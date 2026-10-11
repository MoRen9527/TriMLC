// ── Global crash handlers（勘修窗 2026-10-11 件A）──
// TriMLC 零全局崩溃 handler 实锚（栏 B 勘读段）：uncaughtException/unhandledRejection
// 零接手=运行期任何异步未捕获异常即 node 默认静默 crash（43480 死因「独立崩溃」向源码面
// 成立）。本件：双 handler 结构化日志（crash.log JSON 行·appendFileSync 同步落盘防 exit
// 截断）+受控 exit(1) 交 watchdog revive 链（DOWN→revive→self-check 兜底在役）。
// pidfile 清理由 index.ts 既有 process.on('exit') 同步钩子覆盖（process.exit 触发）。
// 回滚通道：TRIMLC_CRASH_LOG_ONLY=1 → 仅日志不退出（对齐 TRIMLC_CRON_STALE_RECLAIM
// 惯例；注记：该模式下 unhandledRejection 语义由 crash 变续命——回滚态知情面）。
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type CrashKind = 'uncaughtException' | 'unhandledRejection';

export interface CrashLogLine {
  ts: string;
  kind: CrashKind;
  message: string;
  stack: string | null;
}

export function makeCrashLogLine(kind: CrashKind, err: unknown): CrashLogLine {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error && err.stack ? err.stack : null;
  return { ts: new Date().toISOString(), kind, message, stack };
}

export interface CrashHandlerOpts {
  /** crash.log 落盘目录（传 env.dataDir=TRILC_DATA_DIR 启动链显式面）。 */
  logDir: string;
  /** 仅日志不退出（默认读 TRIMLC_CRASH_LOG_ONLY=1；测试注入 true/false）。 */
  logOnly?: boolean;
  /** 退出回调（默认 process.exit；测试注入 spy 防真退）。 */
  onExit?: (code: number) => void;
}

export function installCrashHandlers(
  opts: CrashHandlerOpts,
): { handle: (kind: CrashKind, err: unknown) => void } {
  const logOnly = opts.logOnly ?? process.env.TRIMLC_CRASH_LOG_ONLY === '1';
  const exit = opts.onExit ?? ((code: number) => process.exit(code));
  const logPath = resolve(opts.logDir, 'crash.log');

  const handle = (kind: CrashKind, err: unknown): void => {
    let line: CrashLogLine;
    try {
      line = makeCrashLogLine(kind, err);
    } catch {
      line = { ts: new Date().toISOString(), kind, message: String(err), stack: null };
    }
    // 同步落盘（crash 时 async 写会被 exit 截断）；append 失败降级 console 防递归。
    try {
      appendFileSync(logPath, JSON.stringify(line) + '\n');
    } catch (writeErr) {
      console.error(
        '[trilc] crash.log append failed:',
        writeErr instanceof Error ? writeErr.message : String(writeErr),
      );
    }
    console.error(`[trilc] ${kind}: ${line.message}`);
    if (line.stack) console.error(line.stack);
    if (!logOnly) exit(1);
  };

  process.on('uncaughtException', (err) => handle('uncaughtException', err));
  process.on('unhandledRejection', (err) => handle('unhandledRejection', err));
  return { handle };
}
