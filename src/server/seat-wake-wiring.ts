// ── Seat-wake wake 动作接线模块（BOD 实时收件三级链 W3-b）──
// 形法源: CTO W3-a 接线形勘定卷 cto-w3a-wiring-survey-20261120.md §二 产出 a 五步形
//         （名址解析→活态守门→鉴权装配→管道投递→结果面）+ §四 W3-b 交接注四点。
// 名址正形: ~/.claude/sessions/ 会话注册目录（<pid>.json 主注册件 + <pid>.<64hex>.key
//         鉴权键件）——name=="bod" && agent=="Board" 双断言（W3-a §一 双名分野定谳：
//         seats.json opsName 与 sessions 注册件 name 两层分立，匹配用后者）。
// reason 分层（W2-c 门禁卷终态字面兼容·骨架字面零变）:
//   - 未接线态（骨架）  : wake_action_not_wired   —— app.ts 路由分支承载，本模块零触
//   - 名址零命中        : wake_target_not_found
//   - 名址多命中        : wake_target_ambiguous
//   - pid 不存活        : wake_target_not_alive
//   - 投递败（连/写/超时）: wake_delivery_failed    （候选定名·毕报载明候 W3-c 门禁对表铸定）
// D-46 值面纪律: <pid>.<64hex>.key 键件值面（messaging token）变量读入零回显零日志零落卷；
//   结果面只报 hasToken 布尔形，socketPath 只回传掩形尾段（suffix 8 位）。
// 技术债如实: 管道 wire 格式=harness 内部协议（peerProtocol:1）非公开契约——本模块
//   投递信封为占位最小形（自描述 source/reason/sentAt），真发协议勘定归 W3-d 探针窗
//   （W3-a §三案 2·六护栏+BOD 在场窗），真发前须校形。
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { setWakeActionHandler } from './app.js';
import type { WakeActionPayload, WakeActionResult } from './app.js';

/** sessions 注册件解析出的 bod 目标形（socketPath 只以掩形出本模块边界） */
export interface BodTarget {
  pid: number;
  socketPath: string;
  status: string | null;
  keyPath: string | null;
}

/** 管道连接抽象（白盒 mock 面·真实现=net.connect named pipe 双工） */
export interface SocketConn {
  write(data: string): void;
  /** 等回执或对端关闭（限时）——返回首段回执文本，超时/关闭无回执=null */
  waitReply(ms: number): Promise<string | null>;
  destroy(): void;
}

export type SocketConnector = (socketPath: string) => Promise<SocketConn>;

/** 依赖注入面（白盒 mock 用·缺省全真值实现） */
export interface WakeDeps {
  sessionsDir?: string;
  readFileUtf8?: (p: string) => string;
  fileExists?: (p: string) => boolean;
  listDir?: (dir: string) => string[];
  pidAlive?: (pid: number) => boolean;
  connectSocket?: SocketConnector;
  connectTimeoutMs?: number;
  nowIso?: () => string;
}

const KEY_FILE_RE = /^(\d+)\.([0-9a-f]{64})\.key$/;

function defaultSessionsDir(): string {
  return path.join(os.homedir(), '.claude', 'sessions');
}

/** Windows/跨平台 pid 存活探测：signal 0 探活（ESRCH=死·EPERM/成功=活） */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return e.code !== 'ESRCH';
  }
}

/** 第 1 步 名址解析：扫 sessions/*.json → name=="bod" && agent=="Board" 双断言 */
export function resolveBodTargets(deps: WakeDeps = {}): BodTarget[] {
  const dir = deps.sessionsDir ?? defaultSessionsDir();
  const readUtf8 = deps.readFileUtf8 ?? ((p: string) => fs.readFileSync(p, 'utf8'));
  const exists = deps.fileExists ?? ((p: string) => fs.existsSync(p));
  const list = deps.listDir ?? ((d: string) => fs.readdirSync(d));

  let entries: string[];
  try {
    entries = list(dir);
  } catch {
    return []; // sessions 目录不可达=零命中形（fail-visible 由调用分支承载）
  }

  const keyFiles = new Map<number, string>();
  for (const f of entries) {
    const m = KEY_FILE_RE.exec(f);
    if (m && !keyFiles.has(Number(m[1]))) keyFiles.set(Number(m[1]), path.join(dir, f));
  }

  const targets: BodTarget[] = [];
  for (const f of entries) {
    if (!f.endsWith('.json')) continue;
    const pid = Number(path.basename(f, '.json'));
    if (!Number.isInteger(pid) || pid <= 0) continue;
    let reg: { name?: unknown; agent?: unknown; messagingSocketPath?: unknown; status?: unknown };
    try {
      reg = JSON.parse(readUtf8(path.join(dir, f)));
    } catch {
      continue; // 坏件跳过（不投递不可解析注册面）
    }
    if (reg.name !== 'bod' || reg.agent !== 'Board') continue; // 双断言（防同名+防漂移）
    if (typeof reg.messagingSocketPath !== 'string' || reg.messagingSocketPath.length === 0) continue;
    targets.push({
      pid,
      socketPath: reg.messagingSocketPath,
      status: typeof reg.status === 'string' ? reg.status : null,
      keyPath: keyFiles.has(pid) ? keyFiles.get(pid)! : null,
    });
  }
  return targets;
}

function maskSocketPath(p: string): string {
  const tail = p.slice(-8);
  return `cc-msg-…${tail}`;
}

/** 第 4 步 真值连接器：net.connect named pipe → SocketConn（最小双工形） */
export const defaultConnectSocket: SocketConnector = (socketPath: string) =>
  new Promise<SocketConn>((resolve, reject) => {
    const sock = net.connect(socketPath);
    const pending: Buffer[] = [];
    let replyResolve: ((v: string | null) => void) | null = null;
    let settled = false;

    sock.on('connect', () => {
      settle({
        write: (data: string) => sock.write(data),
        waitReply: (ms: number) =>
          new Promise<string | null>((res) => {
            replyResolve = (v) => { if (!settled) { settled = true; res(v); } };
            const timer = setTimeout(() => replyResolve?.(null), ms);
            timer.unref?.();
          }),
        destroy: () => sock.destroy(),
      });
    });
    sock.on('data', (chunk: Buffer) => {
      pending.push(chunk);
      replyResolve?.(Buffer.concat(pending).toString('utf8'));
    });
    sock.on('close', () => replyResolve?.(Buffer.concat(pending).toString('utf8') || null));
    sock.on('error', (err: Error) => {
      replyResolve?.(null);
      if (!settled) reject(err);
    });

    function settle(conn: SocketConn) { settled = true; resolve(conn); }
  });

/**
 * wakeAction 五步形（W3-a §二产出 a·handler 真身）。
 * 结果面契约（W2-c 终态字面兼容）:
 *   成功  { delivered:true, wired:true, target:'bod', pid, status, hasToken, socketSuffix, replied, deliveredAt }
 *   失败  { delivered:false, reason, ...上下文形 }（reason 见模块头分层注）
 */
export function createWakeAction(deps: WakeDeps = {}) {
  return async function wakeAction(payload: WakeActionPayload): Promise<WakeActionResult> {
    const nowIso = deps.nowIso ?? (() => new Date().toISOString());
    const connect = deps.connectSocket ?? defaultConnectSocket;
    const readUtf8 = deps.readFileUtf8 ?? ((p: string) => fs.readFileSync(p, 'utf8'));
    const exists = deps.fileExists ?? ((p: string) => fs.existsSync(p));
    const alive = deps.pidAlive ?? isPidAlive;
    const timeoutMs = deps.connectTimeoutMs ?? 5000;

    // 1. 名址解析（双断言·零/多命中 fail-visible）
    const hits = resolveBodTargets(deps);
    if (hits.length === 0) return { delivered: false, reason: 'wake_target_not_found' };
    if (hits.length > 1) return { delivered: false, reason: 'wake_target_ambiguous', matches: hits.length };
    const target = hits[0];

    // 2. 活态守门（busy=在轮中信会排队照发·idle=需唤醒正形目标态——两态均投递·status 随结果面）
    if (!alive(target.pid)) {
      return { delivered: false, reason: 'wake_target_not_alive', pid: target.pid };
    }

    // 3. 鉴权装配（key 值面变量读入·零回显零日志——结果面只报 hasToken）
    let token: string | null = null;
    if (target.keyPath && exists(target.keyPath)) {
      try { token = readUtf8(target.keyPath).trim() || null; } catch { token = null; }
    }

    // 4. 管道投递（连接→写→读回执/关闭 最小形·占位信封·协议校形归 W3-d 探针窗）
    try {
      const conn = await connect(target.socketPath);
      const envelope = JSON.stringify({
        source: 'trilc-seat-wake',
        reason: typeof payload?.reason === 'string' ? payload.reason : 'wake',
        sentAt: nowIso(),
        auth: token ?? undefined,
      });
      conn.write(envelope);
      const reply = await conn.waitReply(2000);
      conn.destroy();
      // 5. 结果面
      return {
        delivered: true,
        wired: true,
        target: 'bod',
        pid: target.pid,
        status: target.status,
        hasToken: token !== null,
        socketSuffix: maskSocketPath(target.socketPath),
        replied: reply !== null,
        deliveredAt: nowIso(),
      };
    } catch (err) {
      return {
        delivered: false,
        reason: 'wake_delivery_failed',
        pid: target.pid,
        socketSuffix: maskSocketPath(target.socketPath),
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };
}

/** 装配入口：setWakeActionHandler 填装（回滚锚=clearWakeActionHandler 即回骨架态） */
export function wireSeatWakeAction(deps?: WakeDeps): void {
  setWakeActionHandler(createWakeAction(deps));
}
