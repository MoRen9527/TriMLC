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
//   - 投递败（连/写/超时）: wake_delivery_failed    （W3-c 门禁卷对表铸定·定谳字面）
// D-46 值面纪律: <pid>.<64hex>.key 键件值面（messaging token）变量读入零回显零日志零落卷；
//   结果面只报 hasToken 布尔形，socketPath 只回传掩形尾段（suffix 8 位）；err 掩形只出 errno 码。
// wire 协议形（2026-11-20 W3-e 三闸实锚·claude.exe v2.1.328 二进制破译
//   cto-w3e-consumption-semantics-survey-20261120 §二/§三 六条照铸）:
//   ①NDJSON 行分帧——每帧尾 \n 必需（firstLineDeadlineMs=30000 无完整首行→30s 静默 destroy）；
//   ②auth 首行握手——连接后先发 {type:'auth', token:<peerToken>}（peerToken=key 件 119B 值真身
//   定谳·activeTokens 池校验；D-46 值面零回显零落卷照役）·authRequired 时未鉴权非 auth 帧→丢+断连；
//   ③分类闸 fromMode:"bypass" 写入（held→直投·honor 实效候复拍判；undeclared→held 候 idle）。
//   消息帧形（W3-g 第四层勘定卷定谳·官方注入配方铁证）={type:'user', msg_id:<uuid>,
//   from:'uds:'+<自建临时 socket>, fromMode:'bypass', name, message:{role:'user',content:<正文>}}
//   ——message=对象形铁证（De 只读 message.content·字符串形→访问器落空→静默丢弃·第四层根因
//   实锚）；from 加 uds: 前缀（回执发送侧 lPo() 首检 startsWith("uds:")·裸路径→hold-receipt
//   skipped 静默跳过——replyServer 监听裸路径不变·前缀只是地址串格式）；msg_id 关联
//   peer_message_status 回执（held/refused/release 状态面）。回执双路 race：原连接 waitReply 窗
//   与 replyServer inbound connection（server 拨回 from 地址·VIs 回执装配面）先到先 resolve——
//   Windows verifiedPeerPid 恒缺席→oe 即时回连永不触发→accept 路径静默：replied=false+连接保持
//   =候选成功形（queue 已路由·终判锚=接收侧收信确认）。
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { randomUUID } from 'node:crypto';
import { setWakeActionHandler } from './app.js';
import type { WakeActionPayload, WakeActionResult } from './app.js';

/** seat-wake payload 扩展形（C 自证形参数化·app.ts 形检零触——target 族透传字段） */
type SeatWakePayload = WakeActionPayload & { target?: string; targetAgent?: string };

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

/** 第 1 步 名址解析：扫 sessions/*.json → name+agent 双断言
 *  （C 自证形参数化：targetName/targetAgent 可参·bod 主链缺省 name='bod' && agent='Board'
 *   语义零变——W3-a §一 双名分野定谳承·自证形与 bod 真发共用同一解析/帧构造路径） */
export function resolveWakeTargets(deps: WakeDeps = {}, targetName = 'bod', targetAgent = 'Board'): BodTarget[] {
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
    if (reg.name !== targetName || reg.agent !== targetAgent) continue; // 双断言（防同名+防漂移）
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

/** 兼容别名（bod 主链语义原形·W3-b 白盒既有引用面零断） */
export function resolveBodTargets(deps: WakeDeps = {}): BodTarget[] {
  return resolveWakeTargets(deps, 'bod', 'Board');
}

function maskSocketPath(p: string): string {
  const tail = p.slice(-8);
  return `cc-msg-…${tail}`;
}

/** 第 4 步 真值连接器：net.connect named pipe → SocketConn（NDJSON 双工形·W3-WAKE 修复版）
 *  修复（CTO W3-e 卷 §一 裁决铸形）：settled 拆分=connectSettled/replySettled 两标志分立——
 *  旧形单 settled 互斥重用（connect settle 置 true→waitReply guard 恒 false→四路全闸死→永挂）
 *  ——真发首拍断层实锚（sde-w3d2 卷 §三）·本席 W3-b 手笔自领。 */
export const defaultConnectSocket: SocketConnector = (socketPath: string) =>
  new Promise<SocketConn>((resolve, reject) => {
    const sock = net.connect(socketPath);
    const pending: Buffer[] = [];
    let connectSettled = false; // guard ①：connect settle 竞争（resolve vs reject）·唯一职责
    let replyResolve: ((v: string | null) => void) | null = null;

    sock.on('connect', () => {
      if (connectSettled) return;
      connectSettled = true;
      resolve({
        write: (data: string) => sock.write(data),
        waitReply: (ms: number) =>
          new Promise<string | null>((res) => {
            // guard ②：replySettled 局部守卫——零共享 connectSettled（修复位）
            let replySettled = false;
            let timer: NodeJS.Timeout | undefined;
            const done = (v: string | null) => {
              if (replySettled) return;
              replySettled = true;
              if (timer) clearTimeout(timer); // 防 resolve 后 timer 空放（W3-e §一.1）
              res(v);
            };
            timer = setTimeout(() => done(pendingText() || null), ms);
            timer.unref?.();
            replyResolve = done;
          }),
        destroy: () => sock.destroy(),
      });
    });
    sock.on('data', (chunk: Buffer) => {
      pending.push(chunk);
      replyResolve?.(pendingText());
    });
    sock.on('close', () => replyResolve?.(pendingText() || null));
    sock.on('error', (err: Error) => {
      replyResolve?.(null);
      if (!connectSettled) { connectSettled = true; reject(err); }
    });

    function pendingText() { return Buffer.concat(pending).toString('utf8'); }
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

    // 1. 名址解析（C 参数化：payload.target 缺省 'bod'·payload.targetAgent 缺省 'Board'
    //    ——bod 主链语义零变·自证形探针换目标名共用同一解析路径）
    const p = payload as SeatWakePayload;
    const targetName = typeof p?.target === 'string' && p.target.length > 0 ? p.target : 'bod';
    const targetAgent = typeof p?.targetAgent === 'string' && p.targetAgent.length > 0 ? p.targetAgent : 'Board';
    const hits = resolveWakeTargets(deps, targetName, targetAgent);
    if (hits.length === 0) return { delivered: false, reason: 'wake_target_not_found', target: targetName };
    if (hits.length > 1) return { delivered: false, reason: 'wake_target_ambiguous', matches: hits.length, target: targetName };
    const target = hits[0];

    // 2. 活态守门（busy=在轮中信会排队照发·idle=需唤醒正形目标态——两态均投递·status 随结果面）
    if (!alive(target.pid)) {
      return { delivered: false, reason: 'wake_target_not_alive', pid: target.pid };
    }

    // 3. 鉴权装配（W3-f 定谳：key 件=JSON 信封对象 {peerToken:"<32hex>",procStart?,pidDomain?}
    //    ——119B=信封全长非裸 token；裸读全文当 token→harness pnl timing-safe 池校验必败
    //    →unauthed_drop（W3-E 自证形 24ms 即断实锚）。safeParse 形：解析败/peerToken 缺失非串
    //    →token=null+authParseFailed 标志（error 面 'auth_parse_failed' 出形）。值面零回显零日志照役。
    let token: string | null = null;
    let authParseFailed = false;
    if (target.keyPath && exists(target.keyPath)) {
      try {
        const envelope = JSON.parse(readUtf8(target.keyPath)) as { peerToken?: unknown };
        const pt = typeof envelope?.peerToken === 'string' ? envelope.peerToken.trim() : '';
        token = pt || null;
        if (!token) authParseFailed = true;
      } catch { token = null; authParseFailed = true; }
    }

    // 4. 管道投递——W3-e 三闸实锚六条照铸（§三.1-6）：①NDJSON 行分帧 ②auth 首行握手
    //    ③from=自建临时 socket ④fromMode:"bypass" ⑤type:"user"+msg_id 帧形 ⑥destroy/收口入 finally。
    //    C 参数化：bod 真发与自证形探针（payload.target）共用同一帧构造路径（本函数体零分叉）。
    const reasonText = typeof payload?.reason === 'string' ? payload.reason : 'wake';
    const sentAt = nowIso();
    const bodyText = `[seat-wake probe] ${reasonText} @${sentAt}`;

    // R6-b daemon 侧 codepoint 探针（W3-h 勘定卷 §二.②·乱码层位分界双证随件）——零改码面
    // 遵行（只加日志与结果面读数·帧构造零动）：bodyBytes=bodyText 全量 utf8 字节长；
    // cp16Hex=reasonText 前 16 codepoint hex。取段注记：bodyText 前 16 codepoint=ASCII 前缀
    // （'[seat-wake prob'）对 A 段（拍发链）中文乱码零分辨力——cp16 取 reason 段（中文直接载体
    // ·乱码即在此显形）方能「收到时已乱 vs 发出才乱」一次分清（偏离 CTO 卷字面·毕报载明候对表）。
    // reason 非密值面可回显（D-46 照役仅 token 面）。
    const bodyBytes = Buffer.byteLength(bodyText, 'utf8');
    const cp16Hex = Array.from(reasonText.slice(0, 16))
      .map((ch) => ch.codePointAt(0)!.toString(16).padStart(4, '0'))
      .join(' ');
    console.log(`[seat-wake] bodyBytes=${bodyBytes} cp16=[${cp16Hex}] reason16="${reasonText.slice(0, 16)}"`);
    // ③ from=daemon 自建临时监听 socket（\\.\pipe\LOCAL\trilc-wake-reply-<uuid>）——
    //    过对端塑形检查（did: 风险消解）·回执可达面。W3-g §四.3：connection handler 接线
    //    （server 拨回 from 地址的消费面·原造件 listener 零消费结构性缺口补齐）。
    const replySocketPath = `\\\\.\\pipe\\LOCAL\\trilc-wake-reply-${randomUUID()}`;
    const replyServer = net.createServer();
    const inbound = new Set<net.Socket>();
    let inboundDone: ((v: string | null) => void) | null = null;
    replyServer.on('connection', (c: net.Socket) => {
      inbound.add(c);
      const chunks: Buffer[] = [];
      c.on('data', (d: Buffer) => chunks.push(d));
      c.on('close', () => {
        inbound.delete(c);
        inboundDone?.(Buffer.concat(chunks).toString('utf8') || null);
      });
      c.on('error', () => {});
    });
    let conn: SocketConn | null = null;
    try {
      await new Promise<void>((resolve, reject) => {
        replyServer.once('error', reject);
        replyServer.listen(replySocketPath, () => resolve());
      });
      replyServer.on('error', () => {}); // listen 后 err 静默（对端回信中断面·不挂 daemon）

      conn = await connect(target.socketPath);
      // ② auth 首行握手（token 装配面有则发·无则跳过如实由 hasToken 面）——官方配方逐字吻合
      //    定谳（W3-g §三·txi(token) 发送侧构造正身）；D-46 值面零回显零落卷照役
      if (token) conn.write(JSON.stringify({ type: 'auth', token }) + '\n');
      // ① NDJSON 行尾+④⑤ W3-g 对象形（官方配方铁证：message:{role:'user',content}——De 只读
      //    message.content·双置字符串形删除）+from uds: 前缀（lPo 前缀检·§四.2）
      const msgId = randomUUID();
      conn.write(
        JSON.stringify({
          type: 'user',
          msg_id: msgId,
          from: 'uds:' + replySocketPath,
          fromMode: 'bypass',
          name: 'trilc-seat-wake',
          message: { role: 'user', content: bodyText },
        }) + '\n',
      );

      // 回执双路 race（W3-g §四.3）：conn.waitReply（原连接窗·保底）与 replyServer inbound
      // （server 拨回 from 地址）先到先 resolve——waitReply 超时后 inbound 残留由 finally 收口触发 close
      // →resolve（无观察者·零泄漏）。
      const inboundReply = new Promise<string | null>((res) => { inboundDone = res; });
      const reply = await Promise.race([conn.waitReply(2000), inboundReply]);
      // 5. 结果面——回执语义（W3-g §四.3 校准）：Windows verifiedPeerPid 恒缺席→oe 即时回连
      //    永不触发→accept 路径静默——replied=false+连接保持=候选成功形（queue 已路由·
      //    终判锚=接收侧收信确认）；replied=true=held/refused/release 回执面（可解析状态）。
      return {
        delivered: true,
        wired: true,
        target: targetName,
        pid: target.pid,
        status: target.status,
        hasToken: token !== null,
        socketSuffix: maskSocketPath(target.socketPath),
        msgId,
        replied: reply !== null,
        deliveredAt: sentAt,
        bodyBytes,
        cp16Hex,
      };
    } catch (err) {
      // err 掩形（校形卷 §三.4 照役）——只出 errno 码形；W3-f：key 信封解析败→'auth_parse_failed' 出形
      return {
        delivered: false,
        reason: 'wake_delivery_failed',
        pid: target.pid,
        target: targetName,
        socketSuffix: maskSocketPath(target.socketPath),
        error: authParseFailed
          ? 'auth_parse_failed'
          : err instanceof Error ? ((err as NodeJS.ErrnoException).code ?? 'delivery_error') : 'delivery_error',
      };
    } finally {
      // ⑥ 泄漏收口（W3-WAKE 修复③+§四.3）：任何路径必收口（conn destroy+inbound sockets+reply server）
      conn?.destroy();
      for (const c of inbound) c.destroy();
      try { replyServer.close(); } catch { /* 已关形容忍 */ }
    }
  };
}

/** 装配入口：setWakeActionHandler 填装（回滚锚=clearWakeActionHandler 即回骨架态） */
export function wireSeatWakeAction(deps?: WakeDeps): void {
  setWakeActionHandler(createWakeAction(deps));
}
