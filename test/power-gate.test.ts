// ── LG-069 电量双阈值闸（CEO 2026-10-07 23:52 令）行为锚卷 ──
// 三族：
//   A. stepPowerGate 纯状态机——五态注入（>30 正常 / <30 软 / <20 硬 / 接电恢复 /
//      >25 恢复）+滞回带保持+临界抖动防翻+无电池静默禁用+电池复活。
//   B. startPowerMonitor——检测连续 3 次失败→urgent 告警一次/失效段；读恢复复位
//      再失效可再警（streak 制）；快照面字段齐全。
//   C. cron 硬闸单点——runMissedJobs（导出面，内部全汇 executeJobScheduled）
//      闸停：记 skipped 账面（incrementRun 不 incrementError）+nextRunAt 照常
//      推进（防 0 延迟重臂忙循环）+onJobTrigger 零触发（新派发停止）；无闸对照
//      →正常派发。consecutiveFailures 不因闸停累计（防长闸误引 degraded）。
//
// Run: npx tsx --test test/power-gate.test.ts

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_POWER_GATE_CONFIG,
  stepPowerGate,
  zoneOf,
  startPowerMonitor,
  parsePowerOutput,
  POWER_NOTIFY_FAILURE_ALARM_THRESHOLD,
  type PowerGateState,
  type PowerReading,
} from '../src/power-monitor.js';
import { createCronTimerState, runMissedJobs, type CronTimerDeps } from '../src/cron/timer.js';
import type { CronJob } from '../src/cron/types.js';

const CFG = DEFAULT_POWER_GATE_CONFIG;
const NONE: PowerGateState = { gate: 'none', pendingZone: null, pendingCount: 0, batteryPresent: true };

function reading(percent: number | null, acOnline: boolean, batteryPresent = true): PowerReading {
  // 修复批①后 percentRaw/percentCim 必填；状态机测试只关心判定输入 percent，
  // 双读可见面默认回填=percent 同值（无分叉假设），分叉态由 D 族显式构造。
  return { percent, percentRaw: percent, percentCim: percent, acOnline, batteryPresent };
}

// F 件 b1 v2（2026-10-17）缝注入：单测零外进程（wevtutil）零延迟——空 XML=
// parseWakeEvents null=零行为。旧用例统一补注（非断言语义变更，仅依赖注入）。
const NO_WAKE = async () => '';

function step2(prev: PowerGateState, r: PowerReading) {
  const a = stepPowerGate(prev, r, CFG);
  return stepPowerGate(a.state, r, CFG); // 同读数两连拍=确认窗走满
}

// ── A. 纯状态机 ──

describe('LG-069 stepPowerGate 五态注入', () => {
  it('>30% 电池供电 → gate none 零事件', () => {
    const r = step2(NONE, reading(55, false));
    assert.equal(r.state.gate, 'none');
    assert.deepEqual(r.events, []);
  });

  it('接电 55% → 恒 ok（接电即恢复语义与触发无关）', () => {
    assert.equal(zoneOf(10, true, 'hard', CFG), 'ok');
    assert.equal(zoneOf(5, true, 'none', CFG), 'ok');
  });

  it('<30% 两连拍 → gate soft + gate-soft 事件（软闸）', () => {
    const first = stepPowerGate(NONE, reading(28, false), CFG);
    assert.equal(first.state.gate, 'none', '单拍不翻态（防抖）');
    assert.equal(first.state.pendingZone, 'soft');
    const second = stepPowerGate(first.state, reading(28, false), CFG);
    assert.equal(second.state.gate, 'soft');
    assert.deepEqual(second.events, [{ type: 'gate-soft' }]);
  });

  it('<20% 两连拍 → gate hard + gate-hard 事件（硬闸；软上直接升硬同型）', () => {
    const r = step2(NONE, reading(18, false));
    assert.equal(r.state.gate, 'hard');
    assert.deepEqual(r.events, [{ type: 'gate-hard' }]);
  });

  it('接电恢复（硬闸中 ac=true 两连拍）→ gate-recover + none', () => {
    const hard = step2(NONE, reading(18, false)).state;
    const r = step2(hard, reading(18, true)); // 未接电读数翻接电读数
    assert.equal(r.state.gate, 'none');
    assert.deepEqual(r.events, [{ type: 'gate-recover' }]);
  });

  it('电量回升恢复（硬闸中 26% 两连拍）→ 降级 soft（gate-soft-drop 静默型）', () => {
    const hard = step2(NONE, reading(18, false)).state;
    const r = step2(hard, reading(26, false));
    assert.equal(r.state.gate, 'soft');
    assert.deepEqual(r.events, [{ type: 'gate-soft-drop' }]);
  });

  it('软闸回升 35% 两连拍 → gate-recover + none（滞回上界 34）', () => {
    const soft = step2(NONE, reading(28, false)).state;
    const hold = stepPowerGate(soft, reading(32, false), CFG); // 30-33 持软带
    assert.equal(hold.state.gate, 'soft', '滞回带内保持');
    assert.deepEqual(hold.events, []);
    const r = step2(soft, reading(35, false));
    assert.equal(r.state.gate, 'none');
    assert.deepEqual(r.events, [{ type: 'gate-recover' }]);
  });

  it('硬闸滞回：20-24% 未接电持硬不翻（恢复带 25 起）', () => {
    const hard = step2(NONE, reading(18, false)).state;
    const s = stepPowerGate(hard, reading(22, false), CFG);
    assert.equal(s.state.gate, 'hard', '滞回带保持');
    assert.deepEqual(s.events, []);
  });

  it('临界抖动 19/21 交替 → 永不翻态（连续 2 次同区才切）', () => {
    let st = NONE;
    for (const pct of [19, 21, 19, 21, 19, 21]) {
      st = stepPowerGate(st, reading(pct, false), CFG).state;
    }
    assert.equal(st.gate, 'none');
    assert.equal(st.pendingCount, 1, '末拍重新计 1，未达确认');
  });

  it('无电池 → gate none + batteryPresent false 静默禁用（活跃闸释放发 disabled）', () => {
    const soft = step2(NONE, reading(28, false)).state;
    const r = stepPowerGate(soft, reading(null, false, false), CFG);
    assert.equal(r.state.gate, 'none');
    assert.equal(r.state.batteryPresent, false);
    assert.deepEqual(r.events, [{ type: 'disabled' }]);
    // 持续无电池：零事件（静默，不重复告警）
    const r2 = stepPowerGate(r.state, reading(null, false, false), CFG);
    assert.deepEqual(r2.events, []);
  });

  it('电池复活（disabled 后恢复读数）→ 从 none 重新评估', () => {
    const dead = stepPowerGate(NONE, reading(null, false, false), CFG).state;
    const r = step2(dead, reading(90, false));
    assert.equal(r.state.gate, 'none');
    assert.equal(r.state.batteryPresent, true);
    assert.deepEqual(r.events, []);
  });
});

// ── B. monitor 失效段告警 ──

describe('LG-069 startPowerMonitor 检测失败告警', () => {
  it('连续 3 次读失败 → urgent 告警恰一次/失效段；读恢复复位可再警', async () => {
    const alerts: Array<{ level: string; seats: string[]; title: string }> = [];
    let fail = true;
    const handle = startPowerMonitor({
      queryWakeEventsXml: NO_WAKE,
      readPower: async () => {
        if (fail) throw new Error('mock read fail');
        return reading(55, false);
      },
      notify: (p) => alerts.push({ level: p.level, seats: [...p.seats], title: p.title }),
      log: () => {},
      intervalMs: 5,
    });
    try {
      await new Promise((r) => setTimeout(r, 250)); // 全量负载下 60ms 窗 tick 不足（flake 实证），加宽
      const firstStreak = alerts.filter((a) => a.level === 'urgent');
      assert.ok(firstStreak.length >= 1, '失效段至少一次告警');
      assert.equal(handle.snapshot().readFailures >= 3, true);
      const seatsFlat = firstStreak[0].seats.join(',');
      assert.ok(seatsFlat.includes('m-cos') && seatsFlat.includes('bod'), '告警面=m-cos+bod');

      fail = false; // 读恢复 → 失败计数复位
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(handle.snapshot().readFailures, 0, '读恢复即复位');

      fail = true; // 再失效 → 新失效段可再警
      const before = alerts.length;
      await new Promise((r) => setTimeout(r, 60));
      assert.ok(alerts.length > before, '新失效段重新告警（streak 制非全局一次）');
    } finally {
      handle.stop();
    }
  });
});

// ── D. 双读保守 min（修复批①：同源不同径，min=设计正则）──

describe('修复批① 双读保守 min', () => {
  it('parsePowerOutput：双值齐 → percent=min(raw,cim)，raw/cim 可见化', () => {
    const r = parsePowerOutput('AC=0;FLAG=2;PCT=41;CIM=40');
    assert.equal(r.percent, 40, '保守取低');
    assert.equal(r.percentRaw, 41);
    assert.equal(r.percentCim, 40);
    assert.equal(r.acOnline, false);
    assert.equal(r.batteryPresent, true);
  });

  it('parsePowerOutput：CIM 高于 P/Invoke（充电态反向差）→ 仍取低', () => {
    const r = parsePowerOutput('AC=1;FLAG=2;PCT=18;CIM=19');
    assert.equal(r.percent, 18);
    assert.equal(r.percentRaw, 18);
    assert.equal(r.percentCim, 19);
  });

  it('parsePowerOutput：CIM=NA 单边失败 → 退 P/Invoke 单读（不判读失败）', () => {
    const r = parsePowerOutput('AC=0;FLAG=2;PCT=37;CIM=NA');
    assert.equal(r.percent, 37);
    assert.equal(r.percentRaw, 37);
    assert.equal(r.percentCim, null, 'CIM 单边失败=null（healthz 可见化）');
    assert.equal(r.batteryPresent, true);
  });

  it('parsePowerOutput：无电池形态（FLAG=128/PCT=255）→ 三值全 null', () => {
    const a = parsePowerOutput('AC=1;FLAG=128;PCT=128;CIM=NA');
    assert.equal(a.batteryPresent, false);
    assert.equal(a.percent, null);
    assert.equal(a.percentRaw, null);
    assert.equal(a.percentCim, null);
    const b = parsePowerOutput('AC=1;FLAG=2;PCT=255;CIM=NA');
    assert.equal(b.batteryPresent, false);
  });

  it('parsePowerOutput：无电池但 CIM 有值 → percent 仍 null（batteryPresent 主判）', () => {
    const r = parsePowerOutput('AC=1;FLAG=128;PCT=128;CIM=42');
    assert.equal(r.batteryPresent, false);
    assert.equal(r.percent, null, '无电池时 min 链不产出读数');
    assert.equal(r.percentCim, 42, 'CIM 面如实可见（观测非判定）');
  });

  it('parsePowerOutput：不可解析输出 → throw（read 失败链入口）', () => {
    assert.throws(() => parsePowerOutput('garbage output'));
  });

  it('状态机端到端：mock 分叉读数 → 闸判定吃 min 值（raw 21/cim 19 → hard）', async () => {
    const handle = startPowerMonitor({
      queryWakeEventsXml: NO_WAKE,
      readPower: async () => ({
        percent: 19, percentRaw: 21, percentCim: 19, // min=19 <20
        acOnline: false, batteryPresent: true,
      }),
      log: () => {},
      intervalMs: 5,
    });
    try {
      await new Promise((r) => setTimeout(r, 30)); // 两连拍确认窗走满
      assert.equal(handle.snapshot().gate, 'hard', 'min 值 19 触发硬闸（raw 21 单读则不会）');
      assert.equal(handle.snapshot().percent, 19);
      assert.equal(handle.snapshot().percentRaw, 21);
      assert.equal(handle.snapshot().percentCim, 19);
    } finally {
      handle.stop();
    }
  });

  it('快照面 lastReadAt 双相：读失败期 null→读成功后非 null 且 ISO 可解析（healthz 投影前置件·从闸 staleness 输入面）', async () => {
    let fail = true;
    const handle = startPowerMonitor({
      queryWakeEventsXml: NO_WAKE,
      readPower: async () => {
        if (fail) throw new Error('mock read fail');
        return reading(55, false);
      },
      log: () => {},
      intervalMs: 5,
    });
    try {
      await new Promise((r) => setTimeout(r, 30)); // 失败期（>=2 tick）
      assert.equal(handle.snapshot().lastReadAt, null, '读失败期 lastReadAt=null（staleness 判定不得消费陈旧值）');

      fail = false;
      await new Promise((r) => setTimeout(r, 30)); // 恢复 tick
      const lra = handle.snapshot().lastReadAt;
      assert.ok(lra !== null, '读成功后 lastReadAt 非 null');
      assert.ok(!Number.isNaN(Date.parse(lra as string)), `ISO 可解析（实际=${String(lra)}）`);
    } finally {
      handle.stop();
    }
  });
});

// ── E. notify 出向可观测面（修复批③：静默吞病灶消除）──

describe('修复批③ notify 失败计数+降级告警', () => {
  it('notify throw ×3 → notifyFailures=3 + 降级告警恰一次；成功 tick 清零复位', async () => {
    const alerts: Array<{ level: string; title: string }> = [];
    let fail = true;
    let flips = 0;
    const handle = startPowerMonitor({
      queryWakeEventsXml: NO_WAKE,
      readPower: async () => {
        // 29,29,55,55,29,29... 序列：防抖确认窗走满后每 2 tick 翻一次闸
        // （soft 置位/recover 交替），反复制造闸事件驱动 notify 反复投递。
        flips += 1;
        return Math.floor((flips - 1) / 2) % 2 === 0 ? reading(29, false) : reading(55, false);
      },
      notify: (p) => {
        if (fail) throw new Error('mock notify fail');
        alerts.push({ level: p.level, title: p.title });
      },
      log: () => {},
      intervalMs: 5,
    });
    try {
      await new Promise((r) => setTimeout(r, 80));
      const snap = handle.snapshot();
      assert.ok(snap.notifyFailures >= POWER_NOTIFY_FAILURE_ALARM_THRESHOLD, `连续失败计数达标（现=${snap.notifyFailures}）`);
      // 降级告警面：失败告警自身也走 notify（同样 throw）→ 只 log，不再抛出。
      // 恢复：notify 修好 + 电量恢复制造 gate-recover 事件 → 投递成功清零。
      fail = false;
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(handle.snapshot().notifyFailures, 0, '成功 tick 后清零');
      assert.ok(alerts.length >= 1, '恢复后新事件投递成功');
    } finally {
      handle.stop();
    }
  });

  it('notify 失败不计入 readFailures（两计数器独立）', async () => {
    let flips = 0;
    const handle = startPowerMonitor({
      queryWakeEventsXml: NO_WAKE,
      readPower: async () => {
        flips += 1;
        return flips <= 1 ? reading(29, false) : reading(29, false);
      },
      notify: () => { throw new Error('notify down'); },
      log: () => {},
      intervalMs: 5,
    });
    try {
      await new Promise((r) => setTimeout(r, 40));
      const snap = handle.snapshot();
      assert.ok(snap.notifyFailures >= 1, 'notify 失败计数在增');
      assert.equal(snap.readFailures, 0, '读链活=readFailures 恒零');
    } finally {
      handle.stop();
    }
  });
});

// ── C. cron 硬闸单点（经 runMissedJobs 导出面全汇 executeJobScheduled）──

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: 'power-gate-job',
    name: 'power-gate-test-job',
    schedule: { kind: 'every', everyMs: 60_000 },
    systemPrompt: 'test',
    enabled: true,
    state: 'idle',
    createdAt: '2026-10-08T00:00:00Z',
    updatedAt: '2026-10-08T00:00:00Z',
    runCount: 0,
    errorCount: 0,
    nextRunAt: new Date(Date.now() - 5_000).toISOString(), // 已 due
    ...overrides,
  };
}

function createFakeStore(job: CronJob) {
  const logs: Array<{ jobId: string; status: string; errorMessage?: string }> = [];
  const jobs = new Map<string, CronJob>([[job.id, job]]);
  return {
    logs,
    jobs,
    listJobs: () => [...jobs.values()],
    getJob: (id: string) => jobs.get(id),
    addJob: () => { throw new Error('not implemented in fake'); },
    removeJob: () => false,
    updateJob: () => null,
    updateJobRun: (id: string, updates: Record<string, unknown>) => {
      const j = jobs.get(id);
      if (!j) return;
      if (updates.incrementRun) j.runCount += 1;
      if (updates.incrementError) j.errorCount += 1;
      for (const [key, value] of Object.entries(updates)) {
        if (key === 'incrementRun' || key === 'incrementError') continue;
        (j as Record<string, unknown>)[key] = value;
      }
    },
    addExecutionLog: (jobId: string, status: string, _startedAt: string, _durationMs: number, errorMessage?: string) => {
      logs.push({ jobId, status, errorMessage });
    },
    getExecutionLogs: () => [],
    saveCronStore: () => {},
    db: null as unknown,
  };
}

function makeDeps(store: ReturnType<typeof createFakeStore>, extra: Partial<CronTimerDeps> = {}): CronTimerDeps {
  return {
    store,
    cwd: process.cwd(),
    onJobTrigger: () => {},
    ...extra,
  };
}

describe('LG-069 cron 硬闸单点（runMissedJobs 面）', () => {
  it('闸停：skipped 账面+runCount+1 零 error+nextRunAt 推进未来+onJobTrigger 零触发', async () => {
    const job = makeJob();
    const store = createFakeStore(job);
    let triggered = 0;
    const state = createCronTimerState();
    await runMissedJobs(state, makeDeps(store, {
      shouldDispatchNewJobs: () => false,
      onJobTrigger: () => { triggered += 1; },
    }));
    assert.equal(triggered, 0, '闸停=新派发零触发');
    assert.equal(store.jobs.get(job.id)!.state, 'idle', '不得进入 running');
    assert.equal(store.jobs.get(job.id)!.runCount, 1, 'skipped 记账 incrementRun（角色门禁同款）');
    assert.equal(store.jobs.get(job.id)!.errorCount, 0, '闸停非失败，零 incrementError');
    assert.equal(store.jobs.get(job.id)!.lastRunStatus, 'skipped');
    const skippedLog = store.logs.find((l) => l.status === 'skipped');
    assert.ok(skippedLog, 'skipped 执行账在');
    assert.ok(skippedLog!.errorMessage?.includes('power-gate:hard'), '账面带闸因');
    const next = new Date(store.jobs.get(job.id)!.nextRunAt!).getTime();
    assert.ok(next > Date.now(), 'nextRunAt 推进未来（防 0 延迟重臂忙循环）');
    assert.equal(state.degraded, false, '闸停不计 consecutiveFailures 不引 degraded');
  });

  it('无闸对照 → 正常派发（onJobTrigger 触发，job 消费 due 次）', async () => {
    const job = makeJob({
      command: process.platform === 'win32' ? 'cmd /c exit 0' : 'true',
    });
    const store = createFakeStore(job);
    let triggered = 0;
    const state = createCronTimerState();
    await runMissedJobs(state, makeDeps(store, {
      onJobTrigger: () => { triggered += 1; },
    }));
    assert.equal(triggered, 1, '无闸=正常派发');
    assert.equal(store.jobs.get(job.id)!.state, 'idle');
    assert.equal(store.jobs.get(job.id)!.lastRunStatus, 'ok', '确定性 command job 跑 ok');
    assert.equal(store.jobs.get(job.id)!.runCount, 1);
    const next = new Date(store.jobs.get(job.id)!.nextRunAt!).getTime();
    assert.ok(next > Date.now());
  });
});

// ── E. E1-5 A 面（CTO 定谳 dcfbbb142·COS 2026-11-05 16:35 裁乙连办件）：
//    LG-069 前置告警档——<50% 且未接电→告警值守面恰一次/电量段（非闸不动
//    派发）；重臂=接电或回升 >=55（5 缓冲防抖）。──

const ADVISORY_TITLE = '[LG-069 前置档]';

describe('E1-5 A 面 前置告警档', () => {
  const advAlerts = (alerts: Array<{ title: string }>) =>
    alerts.filter((a) => a.title.includes(ADVISORY_TITLE));

  it('<50% 未接电 → 前置档告警恰一次；持续 DC 持警不重复', async () => {
    const alerts: Array<{ level: string; seats: string[]; title: string }> = [];
    const handle = startPowerMonitor({
      queryWakeEventsXml: NO_WAKE,
      readPower: async () => reading(45, false),
      notify: (p) => alerts.push({ level: p.level, seats: [...p.seats], title: p.title }),
      log: () => {},
      intervalMs: 5,
    });
    try {
      await new Promise((r) => setTimeout(r, 120));
      const hits = advAlerts(alerts);
      assert.equal(hits.length, 1, '恰一次');
      assert.ok(hits[0].seats.join(',').includes('bod'), '值守面含 bod');
      assert.equal(hits[0].level, 'normal', '前置档=normal（非 urgent·闸语义不变）');
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(advAlerts(alerts).length, 1, '持续 DC 持警不重复');
      // 非闸语义：45% DC 在 advisory 档但高于软闸 30——gate 保持 none。
      assert.equal(handle.snapshot().gate, 'none', '告警非闸：gate 不翻');
    } finally {
      handle.stop();
    }
  });

  it('接电重臂 → 断电再 <50% 可再警', async () => {
    const alerts: Array<{ title: string }> = [];
    let ac = false; // 状态切换驱动（B 族 fail 布尔同形·消 tick 竞态）
    const handle = startPowerMonitor({
      queryWakeEventsXml: NO_WAKE,
      readPower: async () => reading(45, ac),
      notify: (p) => alerts.push({ title: p.title }),
      log: () => {},
      intervalMs: 5,
    });
    try {
      await new Promise((r) => setTimeout(r, 60)); // DC 45 → 警
      assert.equal(advAlerts(alerts).length, 1);
      ac = true; // 接电 → 重臂
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(advAlerts(alerts).length, 1, '接电重臂不告警');
      ac = false; // 断电再 <50% → 再警
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(advAlerts(alerts).length, 2, '重臂后再 <50% 可再警');
    } finally {
      handle.stop();
    }
  });

  it('回升 >=55 重臂（50-54 持警不重复）；接电态 <50% 零告警；无电池零告警', async () => {
    const alerts: Array<{ title: string }> = [];
    let mode: 'dc45' | 'dc52' | 'dc56' | 'ac45' | 'nobatt' = 'dc45';
    const read = async (): Promise<PowerReading> => {
      if (mode === 'dc45') return reading(45, false);
      if (mode === 'dc52') return reading(52, false);
      if (mode === 'dc56') return reading(56, false);
      if (mode === 'ac45') return reading(45, true);
      return reading(45, true, false);
    };
    const handle = startPowerMonitor({
      queryWakeEventsXml: NO_WAKE,
      readPower: read,
      notify: (p) => alerts.push({ title: p.title }),
      log: () => {},
      intervalMs: 5,
    });
    try {
      await new Promise((r) => setTimeout(r, 60)); // dc45 → 警 1
      assert.equal(advAlerts(alerts).length, 1);
      mode = 'dc52'; // 50-54 持警
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(advAlerts(alerts).length, 1, '50-54 持警不重复');
      mode = 'dc56'; // >=55 重臂
      await new Promise((r) => setTimeout(r, 30));
      mode = 'dc45'; // 再降 → 再警
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(advAlerts(alerts).length, 2, '回升重臂后再 <50% 可再警');
      mode = 'ac45'; // AC 45 → 零警
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(advAlerts(alerts).length, 2, '接电态零告警');
      mode = 'nobatt'; // 无电池 → 零警
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(advAlerts(alerts).length, 2, '无电池零告警');
    } finally {
      handle.stop();
    }
  });
});

// ── F. E1-5 C 面（CTO 定谳 dcfbbb142）：wake 恢复回调——达标段报告→立即
//    tick 回调恰一次携带段；短段/基线段零调；回调 throw 不炸 tick。──

const ev = (id: number, systemTime: string, extra = ''): string =>
  `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'>` +
  `<System><Provider Name='Microsoft-Windows-Kernel-Power'/>` +
  `<EventID>${id}</EventID><TimeCreated SystemTime='${systemTime}'/>` +
  `<Channel>System</Channel></System>` +
  `<EventData>${extra}</EventData></Event>`;
const durData = (us: number) => `<Data Name='DurationInUs'>${us}</Data>`;
const sixMinUs = 6 * 60 * 1_000_000;

describe('E1-5 C 面 wake 恢复回调', () => {
  it('达标段报告 → onWakeRecovery 恰一次携带段（首拍基线吸收零调）', async () => {
    const baselineXml =
      ev(507, '2026-11-05T06:00:00.0000000Z', durData(sixMinUs)) +
      ev(506, '2026-11-05T05:54:00.0000000Z');
    const freshXml =
      ev(507, '2026-11-05T08:00:00.0000000Z', durData(sixMinUs)) +
      ev(506, '2026-11-05T07:54:00.0000000Z');
    const xmlSeq = [baselineXml, freshXml, freshXml];
    let xi = 0;
    const calls: Array<{ wakeAt: string }> = [];
    const handle = startPowerMonitor({
      queryWakeEventsXml: async () => xmlSeq[Math.min(xi, xmlSeq.length - 1)] ?? '',
      readPower: async () => {
        xi += 1;
        return reading(80, true);
      },
      onWakeRecovery: (seg) => calls.push({ wakeAt: seg.wakeAt }),
      log: () => {},
      intervalMs: 5,
    });
    try {
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(calls.length, 1, '首拍吸收+次拍报告=恰一次');
      assert.equal(calls[0].wakeAt, '2026-11-05T08:00:00.0000000Z', '携带新段 wakeAt');
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(calls.length, 1, '同段重读幂等零调');
    } finally {
      handle.stop();
    }
  });

  it('短段（<5min 阈值）→ 零回调', async () => {
    const shortXml =
      ev(507, '2026-11-05T08:00:00.0000000Z', durData(2 * 60 * 1_000_000)) +
      ev(506, '2026-11-05T07:58:00.0000000Z');
    let xi = 0;
    const calls: number[] = [];
    const handle = startPowerMonitor({
      queryWakeEventsXml: async () => (xi === 0 ? '' : shortXml), // 首拍空=无段
      readPower: async () => {
        xi += 1;
        return reading(80, true);
      },
      onWakeRecovery: () => calls.push(1),
      log: () => {},
      intervalMs: 5,
    });
    try {
      await new Promise((r) => setTimeout(r, 120));
      assert.equal(calls.length, 0, '浅睡段吸收零回调');
    } finally {
      handle.stop();
    }
  });

  it('回调 throw → tick 存活（读面照常推进）', async () => {
    let xi = 0;
    const wakeXml =
      ev(507, '2026-11-05T08:00:00.0000000Z', durData(sixMinUs)) +
      ev(506, '2026-11-05T07:54:00.0000000Z');
    const handle = startPowerMonitor({
      queryWakeEventsXml: async () => (xi === 0 ? '' : wakeXml),
      readPower: async () => {
        xi += 1;
        return reading(80, true);
      },
      onWakeRecovery: () => {
        throw new Error('mock recovery failure');
      },
      log: () => {},
      intervalMs: 5,
    });
    try {
      await new Promise((r) => setTimeout(r, 120));
      const snap = handle.snapshot();
      assert.ok(snap.lastReadAt != null, '回调炸后 tick 存活·读面推进');
      assert.ok(!Number.isNaN(Date.parse(snap.lastReadAt!)), 'lastReadAt ISO 可解析');
    } finally {
      handle.stop();
    }
  });
});
