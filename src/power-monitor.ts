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
}

export const DEFAULT_POWER_GATE_CONFIG: PowerGateConfig = {
  softTrigger: 30,
  softRecover: 34,
  hardTrigger: 20,
  hardRecover: 25,
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

export function defaultReadPower(timeoutMs = 10_000): Promise<PowerReading> {
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
  /** 通知出向（app.ts 接 sg /internal/v1/notify 现役链）；未注入=仅日志。
   * 修复批③：async 化——throw/reject=投递失败（计 notifyFailures），静默吞
   * 病灶消除（BOD 定性「notify 静默吞」实锚=装配面 void fire-and-forget）。 */
  notify?: (payload: PowerNotifyPayload) => void | Promise<void>;
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

export function startPowerMonitor(deps: PowerMonitorDeps): PowerMonitorHandle {
  const cfg: PowerGateConfig = { ...DEFAULT_POWER_GATE_CONFIG, ...deps.config };
  const read = deps.readPower ?? defaultReadPower;
  const log = deps.log ?? (() => {});
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
  let notifyAlarmSent = false;
  let disabledLogged = false;

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
      };
    },
    stop(): void {
      clearInterval(t);
    },
  };
}
