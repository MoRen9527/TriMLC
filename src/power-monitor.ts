// ── LG-069 本机电量双阈值闸（CEO 2026-10-07 23:52 令）──
// 软闸 <30%：COO 派工前置核查告警（非 API 硬拦——派工是会话行为，daemon 层
// 无可拦 API，自动化止于信号、裁决归人，CTO 方案卷 §二哲学原文）。
// 硬闸 <20%：三层=daemon 自闸（cron 停「新派发」，在跑不中断；闸谓词注入
// cron timer，见 server/app.ts shouldDispatchNewJobs）+urgent 广播（各席收令
// 自停系会话行为，daemon 不强杀——如实边界）+端点置位。
// 恢复：CEO 字面「或」——acOnline==1 || 电量回升；滞回带防临界抖动
// （软 30 触发→34 恢复；硬 20 触发→25 恢复，BOD 裁定③采认）。
// 节律：进程内 setInterval 60s——不进 cron store（常驻语义态，零 F-3 族
// nextRunAt 坑、零白名单面）。检测=P/Invoke GetSystemPowerStatus 单行
// spawn（PSModulePath 净化防 PS5.1 污染坑；脚本常量内嵌=零临时文件写面）。
// 边界：无电池机静默禁用（batteryPresent:false 不告警）；检测连续 3 次失败
// →urgent 告警一次/每失效段（闸失效走告警面；daemon 死=闸死，Watchdog 兜底）。

import { spawn } from "node:child_process";

// ── Types ──

export interface PowerReading {
  /** 0-100；batteryPresent=false 时为 null。修复批①：=保守 min(percentRaw, percentCim)——
   * 两机制同源不同径（kernel 直读 vs WMI 投影，CTO 终判卷 c663b82f 定性：min 是
   * 设计正则非权宜），放电段 P/Invoke 缓存投影滞后于 CIM，取低值=硬闸响应提前。 */
  percent: number | null;
  /** P/Invoke GetSystemPowerStatus 口径原始值（双读可见化）。 */
  percentRaw: number | null;
  /** CIM Win32_Battery 口径原始值；null=单边失败（退单读，healthz 可见）。 */
  percentCim: number | null;
  acOnline: boolean;
  batteryPresent: boolean;
}

export type PowerGate = "none" | "soft" | "hard";

export interface PowerGateConfig {
  softTrigger: number; // <30 触发软闸
  softRecover: number; // >=34 解软闸（滞回）
  hardTrigger: number; // <20 触发硬闸
  hardRecover: number; // >=25 解硬闸（滞回；或接电即解）
  /** E1-5 A 面（CTO 定谳 dcfbbb142）：前置告警档——<advisoryTrigger 且未接电
   *  →升级告警值守面（一次/电量段·告警非闸：不动派发）。机理=Adaptive
   *  Standby 冻结风险在中等电量即存在（硬闸 20% 挡不住）。 */
  advisoryTrigger: number;
  /** 前置档重臂滞回：接电即重臂；或电量回升 >=advisoryRecover 重臂（5 缓冲
   *  防抖动）。 */
  advisoryRecover: number;
}

export const DEFAULT_POWER_GATE_CONFIG: PowerGateConfig = {
  softTrigger: 30,
  softRecover: 34,
  hardTrigger: 20,
  hardRecover: 25,
  advisoryTrigger: 50,
  advisoryRecover: 55,
};

export interface PowerGateState {
  gate: PowerGate;
  /** 防抖待翻区（连续 2 次同区才翻态，60s 节律=2min 确认窗）。 */
  pendingZone: Zone | null;
  pendingCount: number;
  batteryPresent: boolean;
}

export type Zone = "ok" | "soft" | "hard";

export type PowerGateEvent =
  | { type: "gate-soft" } // none→soft
  | { type: "gate-hard" } // none|soft→hard
  | { type: "gate-soft-drop" } // hard→soft（部分恢复，静默改闸仅日志）
  | { type: "gate-recover" } // →none（恢复条件达成，通知 m-cos）
  | { type: "disabled" }; // 电池消失（中途拔出）→静默禁用释放闸

export interface PowerSnapshot {
  percent: number | null;
  /** 修复批②：双读可见化（保守 min 的两个原始输入）。 */
  percentRaw: number | null;
  percentCim: number | null;
  acOnline: boolean | null;
  gate: PowerGate;
  batteryPresent: boolean;
  readFailures: number;
  /** 修复批③：notify 出向连续失败计数（成功 tick 清零）。 */
  notifyFailures: number;
  lastReadAt: string | null;
  // ── b1 v2 事件订阅线观测面（healthz 透出·观测面自身可观测）──
  /** 最新一次读到的 507 wakeAt（未评估也记）。 */
  lastWakeSeenAt: string | null;
  /** 最新一次已评估段 wakeAt（基线吸收/阈值吸收/已报均推进）。 */
  lastHandledWakeAt: string | null;
  /** wevtutil 查询连续失败计数（成功清零；仅日志不接 urgent——观测面缺失≠闸失效）。 */
  wakePollFailures: number;
  /** 最近一次达标报告的睡眠段（心跳面 recentWake 字段数据源·§六增量批件）。 */
  lastWakeReport: WakeSegment | null;
}

// ── 纯状态机（单测直接驱动，不依赖定时器/真实电量）──

/**
 * 区带判定（含滞回）：接电=恒 ok（CEO「或」语义：接电即恢复，即使 <20%）；
 * 硬闸保持区按 hardRecover 判（20-24% 持硬）；软闸保持区按 softRecover 判
 * （30-33% 持软）；硬闸恢复落在 25-29% 时降级为软（不直跳 none）。
 */
export function zoneOf(
  percent: number,
  acOnline: boolean,
  gate: PowerGate,
  cfg: PowerGateConfig,
): Zone {
  if (acOnline) return "ok";
  const hardHold = gate === "hard" ? cfg.hardRecover : cfg.hardTrigger;
  const softHold = gate === "soft" ? cfg.softRecover : cfg.softTrigger;
  if (percent < hardHold) return "hard";
  if (percent < softHold) return "soft";
  return "ok";
}

function transitionEvents(from: PowerGate, zone: Zone): PowerGateEvent[] {
  if (zone === "hard") return [{ type: "gate-hard" }];
  if (zone === "soft") return [{ type: from === "hard" ? "gate-soft-drop" : "gate-soft" }];
  return [{ type: "gate-recover" }];
}

/**
 * 状态机单步：连续 2 次采样同区才翻态（防毛刺）。无电池=静默禁用（释放闸、
 * 清防抖、不告警）；电池中途消失发一次 disabled 事件（供日志面注记）。
 */
export function stepPowerGate(
  prev: PowerGateState,
  reading: PowerReading,
  cfg: PowerGateConfig,
): { state: PowerGateState; events: PowerGateEvent[] } {
  if (!reading.batteryPresent) {
    const events: PowerGateEvent[] =
      prev.batteryPresent && prev.gate !== "none" ? [{ type: "disabled" }] : [];
    return {
      state: { gate: "none", pendingZone: null, pendingCount: 0, batteryPresent: false },
      events,
    };
  }
  // batteryPresent=true 但 percent 缺失（防御形态）：不推进不翻态，保持现势。
  if (reading.percent == null) {
    return { state: { ...prev, batteryPresent: true }, events: [] };
  }
  // 电池从无到有（disabled 态复活）：从 none 起点重新评估，无历史闸可保持。
  const baseGate: PowerGate = prev.batteryPresent ? prev.gate : "none";
  const zone = zoneOf(reading.percent, reading.acOnline, baseGate, cfg);
  let { gate, pendingZone, pendingCount } = prev;
  if (!prev.batteryPresent) {
    pendingZone = null;
    pendingCount = 0;
  }
  const events: PowerGateEvent[] = [];
  // 目标闸=区映射（ok→none）；与现闸一致=稳态（含 none+ok 常态），清防抖零事件。
  const targetGate: PowerGate = zone === "ok" ? "none" : zone;
  if (targetGate === gate) {
    pendingZone = null;
    pendingCount = 0;
  } else if (zone === pendingZone) {
    pendingCount += 1;
    if (pendingCount >= 2) {
      events.push(...transitionEvents(gate, zone));
      gate = targetGate;
      pendingZone = null;
      pendingCount = 0;
    }
  } else {
    pendingZone = zone;
    pendingCount = 1;
  }
  return { state: { gate, pendingZone, pendingCount, batteryPresent: true }, events };
}

// ── 检测面：P/Invoke GetSystemPowerStatus（CTO 方案卷 §一 主案）+ CIM 双读 ──

// 单行 PowerShell：Add-Type 内嵌 P/Invoke（结构体字段序=Win32 原序，marshal
// 对齐）；同进程内追加 CIM Win32_Battery 双读（修复批①：同源不同径两机制，
// 同刻背靠背采，多电池 Measure-Object -Minimum 取低=保守语义一致）。输出机器
// 行 AC=<0|1|255>;FLAG=<byte>;PCT=<0-100|255>;CIM=<0-100|NA>（NA=CIM 单边失败，
// 退 P/Invoke 单读，不判读失败——P/Invoke 链活着即检测活着）。脚本常量内嵌
// 本模块（零临时文件写面；每次 spawn 独立进程编译，60s 节律下开销可忽略）。
const PS_POWER_SNIPPET =
  "$t='using System.Runtime.InteropServices;public struct SPS{public byte AC;public byte Flag;public byte Pct;public byte R1;public int LT;public int FLT;}" +
  'public class PSPower{[DllImport("kernel32.dll")]public static extern bool GetSystemPowerStatus(out SPS s);}\';' +
  "Add-Type -TypeDefinition $t;$s=New-Object SPS;[void][PSPower]::GetSystemPowerStatus([ref]$s);" +
  'try{$b=Get-CimInstance Win32_Battery -ErrorAction Stop;if($b){$c=($b|Measure-Object -Property EstimatedChargeRemaining -Minimum).Minimum}else{$c=\'NA\'}}catch{$c=\'NA\'};' +
  '"AC=$($s.AC);FLAG=$($s.Flag);PCT=$($s.Pct);CIM=$c"';

/** 解析机器行→读数（纯函数，单测直驱；min() 保守取值设计正则在此单点）。 */
export function parsePowerOutput(out: string): PowerReading {
  const m = out.match(/AC=(\d+);FLAG=(\d+);PCT=(\d+);CIM=(\d+|NA)/);
  if (!m) throw new Error(`power read unparsable: ${out.slice(0, 160).trim()}`);
  const ac = Number(m[1]);
  const flag = Number(m[2]);
  const pct = Number(m[3]);
  // FLAG=128=无系统电池；PCT=255=电量未知——两者皆判无电池（静默禁用面）。
  const batteryPresent = flag !== 128 && pct !== 255;
  const raw = batteryPresent ? pct : null;
  const cim = m[4] === "NA" ? null : Number(m[4]);
  // 保守 min：双值齐取低；CIM 单边失败退 P/Invoke 单读（CIM=NA 不判读失败）。
  const percent =
    raw == null ? null : cim == null ? raw : Math.min(raw, cim);
  return { percent, percentRaw: raw, percentCim: cim, acOnline: ac === 1, batteryPresent };
}

export function defaultReadPower(timeoutMs = 20_000): Promise<PowerReading> {
  return new Promise((resolve, reject) => {
    // PSModulePath 净化（教训族：父链 pwsh7 目录污染致 PS5.1 加载错版模块）——
    // 删除后 powershell.exe 按自身缺省重建模块路径。
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.PSModulePath;
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", PS_POWER_SNIPPET],
      { env, windowsHide: true },
    );
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("power read timeout"));
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString();
    });
    child.on("error", (e: Error) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`power read failed: code=${code} ${err.slice(0, 160).trim()}`));
        return;
      }
      try {
        resolve(parsePowerOutput(out));
      } catch (e) {
        reject(e);
      }
    });
  });
}

// b1 v2 查询面：wevtutil 直 spawn（args 数组零 shell——Git Bash MSYS 路径改写
// 坑不适用 node 侧；2026-10-17 实测 RC=0·38ms·输出 UTF-8 单行 XML 无编码坑）。
// System 日志 Users 默认可读（同日 A1 勘验非提升会话实读实证），零提权。
export function defaultQueryWakeEventsXml(timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "wevtutil",
      [
        "qe",
        "System",
        "/q:*[System[Provider[@Name='Microsoft-Windows-Kernel-Power'] and (EventID=506 or EventID=507)]]",
        "/c:10",
        "/rd:true",
        "/f:xml",
      ],
      { windowsHide: true },
    );
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("wake event query timeout"));
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString();
    });
    child.on("error", (e: Error) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`wake query failed: code=${code} ${err.slice(0, 160).trim()}`));
        return;
      }
      resolve(out);
    });
  });
}

// ── Monitor（interval 封装+通知出向+失效段告警）──

export interface PowerNotifyPayload {
  level: "normal" | "urgent";
  seats: string[];
  title: string;
  body: string;
}

export interface PowerMonitorDeps {
  /** 缺省=defaultReadPower（真机检测）；单测注入 mock。 */
  readPower?: () => Promise<PowerReading>;
  /** 缺省=defaultQueryWakeEventsXml（真机 wevtutil）；非 win32 或单测注入。
   * b1 v2 缝——沿 readPower 注入正形。 */
  queryWakeEventsXml?: () => Promise<string>;
  /** 通知出向（app.ts 接 sg /internal/v1/notify 现役链）；未注入=仅日志。
   * 修复批③：async 化——throw/reject=投递失败（计 notifyFailures），静默吞
   * 病灶消除（BOD 定性「notify 静默吞」实锚=装配面 void fire-and-forget）。 */
  notify?: (payload: PowerNotifyPayload) => void | Promise<void>;
  /** E1-5 C 面（CTO 定谳 dcfbbb142）：达标 wake 段报告时的恢复回调——宿主装配
   *  面接 cron 立即 tick（due 检查+stale reclaim 一轮·不等 ≤60s 节拍）。回调
   *  异常由 tick catch 面兜（不炸 tick 循环）。 */
  onWakeRecovery?: (seg: WakeSegment) => void;
  log?: (line: string) => void;
  intervalMs?: number;
  config?: Partial<PowerGateConfig>;
}

export interface PowerMonitorHandle {
  snapshot(): PowerSnapshot;
  stop(): void;
}

export const POWER_READ_FAILURE_ALARM_THRESHOLD = 3;
export const POWER_NOTIFY_FAILURE_ALARM_THRESHOLD = 3;
// LG-088 件b1 v2（F 件·CEO 2026-10-17 11:00:25 两裁①）：唤醒补报阈值——睡眠段
// 时长 >5min 才补报（浅睡段静默防噪声；今晨实证段① 2min57s 静默·段②③ 64min/
// 5min49s 应报）。v1 tick 冻结差值法（POWER_WAKE_GAP_MS）已删除——结构性缺陷：
// 观测者自身=测量载体，冻结即失效、DRIPS 维护窗拍污染 lastReadAt 即静默破坏
// （2026-10-17 实证：醒后 100+ tick 零触发），观测面不可自证不可修。
// v2=Kernel-Power 506/507 事件订阅线：OS 内核写入的持久化事实源，拉取式查询
// （wevtutil /rd:true 倒序），观测者只是读者——读者可冻结，事实源死不了。
export const POWER_WAKE_MIN_DURATION_MS = 5 * 60 * 1000;

// ── b1 v2 纯函数面（单测直驱·test/wake-events.test.ts）──

export interface WakeSegment {
  /** 唤醒时刻（507 TimeCreated SystemTime·ISO）。 */
  wakeAt: string;
  /** 入睡时刻（配对 506·文档序其后最近一条）；缺失=null（缺对不造数）。 */
  sleepAt: string | null;
  /** 睡眠段时长：主判=507 EventData DurationInUs（OS 官方口径）；fallback=
   * wake−sleep 配对差；双缺=null（时长不可判·不报——如实边界）。 */
  durationMs: number | null;
}

/**
 * 解析 wevtutil /f:xml 输出（单行多 <Event> 串·/rd:true 契约=文档序为时间倒序）
 * →最近一次睡眠段。无 507（未醒/无睡眠史）=null。非 506/507 事件块忽略。
 */
export function parseWakeEvents(xml: string): WakeSegment | null {
  const events: { id: number; at: string; durationUs: number | null }[] = [];
  for (const m of xml.matchAll(/<Event\b[\s\S]*?<\/Event>/g)) {
    const block = m[0];
    const id = block.match(/<EventID>(\d+)<\/EventID>/);
    const at = block.match(/<TimeCreated SystemTime='([^']+)'/);
    if (!id || !at) continue;
    const eid = Number(id[1]);
    if (eid !== 506 && eid !== 507) continue;
    const dur =
      eid === 507 ? block.match(/<Data Name='DurationInUs'>(\d+)<\/Data>/) : null;
    events.push({ id: eid, at: at[1], durationUs: dur ? Number(dur[1]) : null });
  }
  const wakeIdx = events.findIndex((e) => e.id === 507);
  if (wakeIdx === -1) return null;
  const wake = events[wakeIdx];
  const sleep = events.slice(wakeIdx + 1).find((e) => e.id === 506) ?? null;
  const durationMs =
    wake.durationUs != null
      ? wake.durationUs / 1000
      : sleep
        ? Date.parse(wake.at) - Date.parse(sleep.at)
        : null;
  return { wakeAt: wake.at, sleepAt: sleep ? sleep.at : null, durationMs };
}

export interface WakeMonitorState {
  /** 首拍基线吸收（防 restart 后重放历史睡眠段误报——生效窗自身要 restart）。 */
  baselineAbsorbed: boolean;
  /** 已评估的最新段 wakeAt（含未达阈值被吸收的段——每段只评估一次）。 */
  lastHandledWakeAt: string | null;
}

export const WAKE_MONITOR_INIT: WakeMonitorState = {
  baselineAbsorbed: false,
  lastHandledWakeAt: null,
};

/**
 * 状态机单步：首段=基线吸收只记不报；旧段重读=幂等跳过；新段未达阈值（含时长
 * 不可判）=吸收不报；新段达标=报告。报告即吸收（lastHandledWakeAt 推进）。
 */
export function processWakeSegment(
  prev: WakeMonitorState,
  seg: WakeSegment | null,
  minDurationMs: number = POWER_WAKE_MIN_DURATION_MS,
): { state: WakeMonitorState; report: WakeSegment | null } {
  if (!seg) return { state: prev, report: null };
  if (!prev.baselineAbsorbed) {
    return {
      state: { baselineAbsorbed: true, lastHandledWakeAt: seg.wakeAt },
      report: null,
    };
  }
  if (
    prev.lastHandledWakeAt != null &&
    Date.parse(seg.wakeAt) <= Date.parse(prev.lastHandledWakeAt)
  ) {
    return { state: prev, report: null };
  }
  const next: WakeMonitorState = {
    baselineAbsorbed: true,
    lastHandledWakeAt: seg.wakeAt,
  };
  if (seg.durationMs == null || seg.durationMs < minDurationMs) {
    return { state: next, report: null };
  }
  return { state: next, report: seg };
}

export function startPowerMonitor(deps: PowerMonitorDeps): PowerMonitorHandle {
  const cfg: PowerGateConfig = { ...DEFAULT_POWER_GATE_CONFIG, ...deps.config };
  const read = deps.readPower ?? defaultReadPower;
  const queryWake = deps.queryWakeEventsXml ?? defaultQueryWakeEventsXml;
  // 2026-10-13 勘修窗（BOD §173 会签）：log 行加时戳前缀——channel.log 行无时戳
  // 系事后勘测盲区（同日实证：power 失败轨迹无法对表 AC 切换段）。
  const rawLog = deps.log ?? (() => {});
  const log = (line: string) => rawLog(`[${new Date().toISOString()}] ${line}`);
  // 初态=乐观有电池（未初读前 gate=none 恒放行零行为；首 tick 立即校准）。
  let st: PowerGateState = { gate: "none", pendingZone: null, pendingCount: 0, batteryPresent: true };
  let lastPct: number | null = null;
  let lastRawPct: number | null = null;
  let lastCimPct: number | null = null;
  let lastAc: boolean | null = null;
  let lastReadAt: string | null = null;
  let readFailures = 0;
  let notifyFailures = 0;
  let failAlarmSent = false;
  // E1-5 A 面：前置告警档一次/电量段标志（接电或回升 >=advisoryRecover 重臂）。
  let advisoryAlarmSent = false;
  let notifyAlarmSent = false;
  let disabledLogged = false;
  // ── b1 v2 事件订阅线状态 ──
  let wakeSt: WakeMonitorState = { ...WAKE_MONITOR_INIT };
  let lastWakeSeenAt: string | null = null;
  let wakePollFailures = 0;
  let lastWakeReport: WakeSegment | null = null;

  /** 修复批③：通知出向唯一入口——await + 失败计数 + 连续≥3 降级告警（一次/
   * 失效段；告警自身失败仅日志不递归计数，通道死时唯一可观测=日志，如实）。 */
  async function dispatchNotify(payload: PowerNotifyPayload): Promise<void> {
    const notifyFn = deps.notify;
    if (!notifyFn) return;
    try {
      await notifyFn(payload);
      if (notifyFailures > 0) log(`notify channel recovered after ${notifyFailures} failures`);
      notifyFailures = 0;
      notifyAlarmSent = false;
      log(`notify delivered: ${payload.title}`);
    } catch (e) {
      notifyFailures += 1;
      log(`notify failure #${notifyFailures}: ${payload.title} — ${e instanceof Error ? e.message : String(e)}`);
      if (notifyFailures >= POWER_NOTIFY_FAILURE_ALARM_THRESHOLD && !notifyAlarmSent) {
        notifyAlarmSent = true;
        log(`[urgent] notify channel failing ${notifyFailures} consecutive times — 闸告警面降级仅日志（告警出向与告警同通道，如实边界）`);
        // 尽力一试（不递归计数）：urgent 告警走同一通道，死马当活马医。
        // then 化入链：deps.notify 同步 throw 也落 promise 链（Promise.resolve
        // 直包同步 throw 会漏成 unhandledRejection——单测 E 族实证）。
        void Promise.resolve()
          .then(() =>
            notifyFn({
              level: "urgent",
              seats: ["m-cos", "bod"],
              title: "[LG-069] 通知通道连续失败·闸告警面降级",
              body: `TriMLC powerMonitor 通知出向连续 ${notifyFailures} 次失败，闸事件告警面降级仅日志。请核查 sg 通知链（TRIMC_NOTIFY_SG_URL）。`,
            }),
          )
          .catch(() => {});
      }
    }
  }

  async function tick(): Promise<void> {
    // ── b1 v2 唤醒补报（F 件·CEO 2026-10-17 两裁①·Kernel-Power 事件订阅线）──
    // 串行挂现役 60s tick（wevtutil ~40ms 实测，追加后 tick 总时长仍 <<60s 节律）。
    // 非 win32 静默跳过（跨平台 guard）；查询失败计数+日志不接 urgent（观测面
    // 缺失≠闸失效，闸有独立 read 失败告警面）。首拍基线吸收防 restart 重放。
    if (process.platform === "win32") {
      try {
        const xml = await queryWake();
        wakePollFailures = 0;
        const seg = parseWakeEvents(xml);
        if (seg) lastWakeSeenAt = seg.wakeAt;
        const { state, report } = processWakeSegment(wakeSt, seg);
        wakeSt = state;
        if (report) {
          lastWakeReport = report;
          const min = Math.round((report.durationMs ?? 0) / 60000);
          log(
            `wake segment detected: sleep=${report.sleepAt ?? "?"} wake=${report.wakeAt} (${min}min) — reporting`,
          );
          void dispatchNotify({
            level: "normal",
            seats: ["m-cos"],
            title: "[LG-088] 唤醒补报·宿主睡眠段（事件日志锚）",
            body: `TriMLC 事件订阅线捕获睡眠段：入睡=${report.sleepAt ?? "缺对"} 唤醒=${report.wakeAt} 时长≈${min}min（Kernel-Power 506/507·OS 事实源）——daemon 已醒恢复值守，请对表该窗内缺口（tick 缺拍段/告警面盲区/跨机链路）。`,
          });
          // ── E1-5 C 面（CTO 定谳 dcfbbb142·修复形三面之一）：wake 后立即一轮
          // due 检查+stale reclaim（防 Modern Standby 冻结段积压 job 滞留至下一
          // 节拍到岗；现役 runMissedJobs=启动补跑·wake 非启动——本回调补 wake
          // 面）。宿主装配面接 cron 立即 tick；回调异常 catch 兜（不炸 tick）。
          if (deps.onWakeRecovery) {
            try {
              log(`wake recovery: triggering immediate due-check + stale-reclaim tick`);
              deps.onWakeRecovery(report);
            } catch (e) {
              log(`wake recovery callback failure: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        }
      } catch (e) {
        wakePollFailures += 1;
        log(`wake event poll failure #${wakePollFailures}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    let r: PowerReading;
    try {
      r = await read();
    } catch (e) {
      readFailures += 1;
      log(`power read failure #${readFailures}: ${e instanceof Error ? e.message : String(e)}`);
      // 连续 3 次失败→告警一次/每失效段（闸失效走告警面；读恢复即复位可再警）。
      if (
        readFailures >= POWER_READ_FAILURE_ALARM_THRESHOLD &&
        !failAlarmSent
      ) {
        failAlarmSent = true;
        void dispatchNotify({
          level: "urgent",
          seats: ["m-cos", "bod"],
          title: "[LG-069] 电量检测连续失败·闸失效风险",
          body: `TriMLC powerMonitor 连续 ${readFailures} 次读取失败，闸状态自此刻起不可信（如实边界：daemon 活性由 Watchdog 兜底，闸本身无独立守护）。请人工核查本机电源状态。`,
        });
      }
      return;
    }
    readFailures = 0;
    failAlarmSent = false;
    lastReadAt = new Date().toISOString();
    lastPct = r.percent;
    lastRawPct = r.percentRaw;
    lastCimPct = r.percentCim;
    lastAc = r.acOnline;
    const { state, events } = stepPowerGate(st, r, cfg);
    st = state;
    if (!r.batteryPresent) {
      if (!disabledLogged) {
        disabledLogged = true;
        log("no battery present: power gate silently disabled (LG-069 boundary)");
      }
      return;
    }
    disabledLogged = false;
    for (const ev of events) {
      log(`power gate event: ${ev.type} (percent=${r.percent} raw=${r.percentRaw} cim=${r.percentCim} ac=${r.acOnline})`);
      if (ev.type === "gate-soft") {
        void dispatchNotify({
          level: "normal",
          seats: ["m-coo"],
          title: "[LG-069] 电量<30% 软闸置位",
          body: `本机电量 ${r.percent}% 且未接电：COO 新增派单前请先核查本机电量（GET :8713/internal/v1/power 可查）。软闸=前置核查告警，非硬停。`,
        });
      } else if (ev.type === "gate-hard") {
        void dispatchNotify({
          level: "urgent",
          seats: ["m-cos", "m-coo", "bod"],
          title: "[LG-069] 电量<20% 硬闸·本地域暂停",
          body: `本机电量 ${r.percent}% 且未接电：TriMLC cron 已停新派发（在跑 job 不中断）；各席收令自停（如实边界：daemon 不强杀会话）。恢复条件=接通电源或电量回升（CEO 令字面「或」）。`,
        });
      } else if (ev.type === "gate-recover") {
        void dispatchNotify({
          level: "normal",
          seats: ["m-cos"],
          title: "[LG-069] 恢复条件达成",
          body: `${r.acOnline ? "已接通电源" : `电量回升至 ${r.percent}%`}：恢复条件达成。daemon 已自解闸恢复派发；COS 请通知 COO 恢复全员工作（CEO 令恢复动作链）。`,
        });
      }
      // gate-soft-drop（硬→软部分恢复）=静默改闸仅日志，不通知（防噪声；
      // 完全恢复走 gate-recover 通知面）。
    }
    // ── E1-5 A 面（CTO 定谳 dcfbbb142·COS 16:35 裁乙连办件）：前置告警档——
    // <advisoryTrigger 且未接电→升级告警值守面（一次/电量段）。告警非闸：
    // 不动派发（软硬闸语义不变）。重臂=接电或电量回升 >=advisoryRecover
    // （5 缓冲防抖动——50-54 区间持警不重复发）。机理=E1-5 定谳 Modern
    // Standby 冻结风险在中等电量 DC 态即存在（硬闸 20% 挡不住 Adaptive 形态）。
    if (
      lastPct != null &&
      lastPct < cfg.advisoryTrigger &&
      lastAc === false &&
      !advisoryAlarmSent
    ) {
      advisoryAlarmSent = true;
      log(`advisory alarm: ${lastPct}% on battery (<${cfg.advisoryTrigger}) — standby-freeze risk`);
      void dispatchNotify({
        level: "normal",
        seats: ["m-cos", "m-coo", "bod"],
        title: "[LG-069 前置档] 电量<50% 未接电·待机冻结风险",
        body: `本机电量 ${lastPct}% 且未接电（E1-5 前置告警档·非闸不动派发）：Adaptive Standby 待机冻结风险在中等电量即存在（E1-5 定谳卷 dcfbbb142——值守机接电=角色要求，8711+8713 双 daemon+多席常驻宿主）。请安排接电或知情值守。`,
      });
    } else if (
      advisoryAlarmSent &&
      (lastAc === true || (lastPct != null && lastPct >= cfg.advisoryRecover))
    ) {
      advisoryAlarmSent = false;
      log(`advisory re-armed: ${lastAc ? "AC online" : `battery ${lastPct}% (>=${cfg.advisoryRecover})`}`);
    }
  }

  const t = setInterval(() => {
    tick().catch((e: unknown) => log(`power tick error: ${e instanceof Error ? e.message : String(e)}`));
  }, deps.intervalMs ?? 60_000);
  if (typeof t.unref === "function") t.unref();
  void tick(); // 首读立即校准（含无电池机首 tick 即禁用注记）

  return {
    snapshot(): PowerSnapshot {
      return {
        percent: lastPct,
        percentRaw: lastRawPct,
        percentCim: lastCimPct,
        acOnline: lastAc,
        gate: st.gate,
        batteryPresent: st.batteryPresent,
        readFailures,
        notifyFailures,
        lastReadAt,
        lastWakeSeenAt,
        lastHandledWakeAt: wakeSt.lastHandledWakeAt,
        wakePollFailures,
        lastWakeReport,
      };
    },
    stop(): void {
      clearInterval(t);
    },
  };
}
