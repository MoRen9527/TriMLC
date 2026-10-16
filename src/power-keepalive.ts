// LG-088 / E1-2 a 件：SetThreadExecutionState 进程级保活（win32 only）。
// 方案稿：cto-lg088-mitigation-plan-a-b-20261017.md 件a（BOD 02:54:53 裁准链·charter-2026-W42-005）。
// 语义：向 Power Manager 声明 ES_CONTINUOUS|ES_SYSTEM_REQUIRED —— 只阻系统空闲睡眠、
// 不阻熄屏；保护性强制睡眠（极端低电量等）仍可越过（防电池耗尽）。
// fail-safe 主保险 = 进程死 OS 层自动失效（线程终结请求即清）；shutdown 链显式释放仅整洁性补。
// 降级语义：非 win32 静默跳过；koffi 加载失败/OS 拒绝 → warn 继续，不阻 daemon 启动
// （最坏情形 = 回到现役睡眠形态，无新增风险面；跨机 TriRMC 同型套用同款语义）。
// 注意：JS 位运算 32 位有符号陷阱 —— 0x80000000 | 1 产生负数，flags 一律字面量直传 uint32。
const ES_CONTINUOUS = 0x80000000;
const ES_SYSTEM_REQUIRED = 0x00000001;
const KEEP_AWAKE_FLAGS = 0x80000001; // ES_CONTINUOUS | ES_SYSTEM_REQUIRED（字面量·禁位运算拼值）

type ExecStateFn = (flags: number) => number;

let execStateFn: ExecStateFn | null = null;
let engaged = false;
let pending = false;

function log(msg: string): void {
  console.log(`[trilc] power-keepalive: ${msg}`);
}

/**
 * 启动面调用：请求系统保持唤醒（幂等·动态 import 零阻塞·失败仅降级 warn）。
 */
export function keepSystemAwake(): void {
  if (process.platform !== 'win32') return;
  if (engaged || pending) return;
  pending = true;
  import('koffi')
    .then((raw) => {
      const koffi = ((raw as { default?: unknown }).default ?? raw) as {
        load(path: string): {
          func(name: string, result: string, args: string[]): (flags: number) => number;
        };
      };
      // 勘正（03:0x 活体冒烟实证）：kernelbase.dll 无此导出（Cannot find function 实锚）——
      // SetThreadExecutionState 正身导出位=kernel32.dll（MS 文档 Library: Kernel32.dll）
      const fn = koffi.load('kernel32.dll').func('SetThreadExecutionState', 'uint32', ['uint32']);
      const prev = fn(KEEP_AWAKE_FLAGS);
      if (prev === 0) {
        // 0 = OS 拒绝（如无权限/不支持）——保持降级态，仅告警
        log('SetThreadExecutionState rejected (prev=0) — degrade to no-keepalive');
        return;
      }
      execStateFn = fn;
      engaged = true;
      log(`engaged (ES_CONTINUOUS|ES_SYSTEM_REQUIRED, prev=0x${prev.toString(16)}) — system idle sleep blocked while daemon lives`);
    })
    .catch((err: unknown) => {
      log(`koffi load failed, degrade to no-keepalive: ${err instanceof Error ? err.message : String(err)}`);
    })
    .finally(() => {
      pending = false;
    });
}

/**
 * 关停面调用：显式释放电源请求（幂等·未生效态静默）。
 * 进程死 OS 自动失效为主保险——本函数失败不影响关停链继续。
 */
export function releaseKeepAwake(): void {
  if (!engaged || !execStateFn) return;
  try {
    execStateFn(ES_CONTINUOUS); // 仅 ES_CONTINUOUS = 清除 SYSTEM_REQUIRED
    engaged = false;
    log('released — system sleep policy restored');
  } catch (err) {
    log(`release failed (process death will auto-release): ${err instanceof Error ? err.message : String(err)}`);
  }
}
