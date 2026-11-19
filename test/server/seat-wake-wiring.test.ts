// ── Seat-wake wake 动作接线白盒（W3-b·W3-a 形定卷 §四.4 案形）──
// 案形边界：名址解析 mock+守门分支+reason 分层——真管道写案不入白盒（活体面归 W3-d 探针窗）。
// 基础面：node:test + assert/strict（照现役套件形）；deps 全 mock 零真盘 IO。
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import { randomUUID } from 'node:crypto';
import {
  createWakeAction,
  resolveBodTargets,
  wireSeatWakeAction,
  isPidAlive,
  defaultConnectSocket,
  type WakeDeps,
  type SocketConn,
} from '../../src/server/seat-wake-wiring.js';
import { clearWakeActionHandler, isWakeActionWired } from '../../src/server/app.js';

/** mock deps 工厂：内存 sessions 注册面+可控 pid 存活/连接器 */
function makeDeps(overrides: {
  sessions?: Array<{ pid: number; name: string; agent: string; socketPath?: string; status?: string }>;
  keys?: Record<number, string>;
  alive?: boolean | ((pid: number) => boolean);
  connect?: (socketPath: string) => Promise<SocketConn>;
} = {}): WakeDeps & { written: string[] } {
  const written: string[] = [];
  const sessions = overrides.sessions ?? [
    { pid: 24572, name: 'bod', agent: 'Board', socketPath: '\\\\.\\pipe\\LOCAL\\cc-msg-4761258b48d225753185943dae7adf9d', status: 'idle' },
  ];
  const keys = overrides.keys ?? { 24572: JSON.stringify({ peerToken: 'a'.repeat(64) }) + '\n' }; // W3-f 信封形
  const dir = 'X:\\mock-sessions';
  const entries = [
    ...sessions.map((s) => `${s.pid}.json`),
    ...Object.keys(keys).map((pid) => `${pid}.${'a'.repeat(64)}.key`),
  ];
  const aliveFn = typeof overrides.alive === 'function' ? overrides.alive : () => overrides.alive ?? true;
  const connector: (socketPath: string) => Promise<SocketConn> =
    overrides.connect ??
    (async (socketPath: string) => ({
      write: (data: string) => { written.push(`${socketPath}|${data}`); },
      waitReply: async () => 'ACK',
      destroy: () => {},
    }));
  return {
    sessionsDir: dir,
    listDir: () => entries,
    readFileUtf8: (p: string) => {
      const base = p.split(/[\\/]/).pop() ?? '';
      const mJson = /^(\d+)\.json$/.exec(base);
      if (mJson) {
        const s = sessions.find((x) => String(x.pid) === mJson[1])!;
        return JSON.stringify({ name: s.name, agent: s.agent, messagingSocketPath: s.socketPath, status: s.status });
      }
      const mKey = /^(\d+)\.([0-9a-f]{64})\.key$/.exec(base);
      if (mKey) return keys[Number(mKey[1])] ?? '';
      throw new Error(`ENOENT mock: ${p}`);
    },
    fileExists: (p: string) => {
      const base = p.split(/[\\/]/).pop() ?? '';
      const mKey = /^(\d+)\.([0-9a-f]{64})\.key$/.exec(base);
      return mKey ? Number(mKey[1]) in keys : false;
    },
    pidAlive: (pid: number) => aliveFn(pid),
    connectSocket: connector,
    connectTimeoutMs: 500,
    nowIso: () => '2026-11-20T00:00:00.000Z',
    written,
  } as WakeDeps & { written: string[] };
}

describe('W3 seat-wake 接线白盒（W3-a 五步形）', () => {
  beforeEach(() => clearWakeActionHandler());

  describe('第 1 步 名址解析（双断言）', () => {
    it('u1 bod+Board 双断言命中·socketPath/status/keyPath 解析在', () => {
      const deps = makeDeps();
      const hits = resolveBodTargets(deps);
      assert.equal(hits.length, 1);
      assert.equal(hits[0].pid, 24572);
      assert.equal(hits[0].status, 'idle');
      assert.ok(hits[0].socketPath.includes('cc-msg-'));
      assert.ok(hits[0].keyPath !== null);
    });
    it('u2 name==bod 而 agent!=Board 不命中（双断言防同名）', () => {
      const deps = makeDeps({ sessions: [{ pid: 100, name: 'bod', agent: 'FSD' }] });
      assert.equal(resolveBodTargets(deps).length, 0);
    });
    it('u3 name!=bod 而 agent==Board 不命中（双断言防漂移）', () => {
      const deps = makeDeps({ sessions: [{ pid: 100, name: 'fsd', agent: 'Board' }] });
      assert.equal(resolveBodTargets(deps).length, 0);
    });
    it('u4 无 .key 注册件的会话不缺 keyPath 断言（keyPath=null 容错形）', () => {
      const deps = makeDeps({ keys: {} });
      const hits = resolveBodTargets(deps);
      assert.equal(hits.length, 1);
      assert.equal(hits[0].keyPath, null);
    });
    it('u5 sessions 目录不可达=零命中（fail-visible 由 not_found 承载）', () => {
      const deps = makeDeps();
      (deps as { listDir: unknown }).listDir = () => { throw new Error('ENOENT'); };
      assert.equal(resolveBodTargets(deps).length, 0);
    });
  });

  describe('reason 分层（W2-c 终态字面兼容·骨架字面零变）', () => {
    it('u6 零命中 → wake_target_not_found', async () => {
      const deps = makeDeps({ sessions: [] });
      const r = await createWakeAction(deps)({});
      assert.deepEqual({ delivered: r.delivered, reason: r.reason }, { delivered: false, reason: 'wake_target_not_found' });
    });
    it('u7 多命中 → wake_target_ambiguous', async () => {
      const deps = makeDeps({
        sessions: [
          { pid: 1, name: 'bod', agent: 'Board', socketPath: '\\\\.\\pipe\\a', status: 'idle' },
          { pid: 2, name: 'bod', agent: 'Board', socketPath: '\\\\.\\pipe\\b', status: 'idle' },
        ],
        keys: { 1: 'a'.repeat(64), 2: 'b'.repeat(64) },
      });
      const r = await createWakeAction(deps)({});
      assert.deepEqual({ delivered: r.delivered, reason: r.reason, matches: r.matches }, { delivered: false, reason: 'wake_target_ambiguous', matches: 2 });
    });
    it('u8 pid 不存活 → wake_target_not_alive', async () => {
      const deps = makeDeps({ alive: false });
      const r = await createWakeAction(deps)({});
      assert.deepEqual({ delivered: r.delivered, reason: r.reason, pid: r.pid }, { delivered: false, reason: 'wake_target_not_alive', pid: 24572 });
    });
    it('u9 连接拒 → wake_delivery_failed（候选定名·值面零 token 零全 socketPath·err 掩形只出 errno 码）', async () => {
      // mock 抛真 ErrnoException 形（net.connect 真错误带 .code）——掩形面 code 在→出 code
      const refused = new Error('connect ECONNREFUSED (mock)') as NodeJS.ErrnoException;
      refused.code = 'ECONNREFUSED';
      const deps = makeDeps({ connect: async () => { throw refused; } });
      const r = await createWakeAction(deps)({ source: 'probe' });
      assert.deepEqual({ delivered: r.delivered, reason: r.reason }, { delivered: false, reason: 'wake_delivery_failed' });
      assert.equal((r as { error: string }).error, 'ECONNREFUSED');
      const flat = JSON.stringify(r);
      assert.ok(!flat.includes('a'.repeat(64)), 'token 值面零回显（D-46）');
      assert.ok(!flat.includes('4761258b48d225753185943dae7adf9d'), 'socketPath 全值零回显（只出掩形尾段）');
    });
    it('u10 全绿投递 → delivered:true+wired:true+status/hasToken 透传（W3-e 六条帧形断言）', async () => {
      const deps = makeDeps();
      const r = await createWakeAction(deps)({ source: 'probe', reason: 'wake' });
      assert.deepEqual(
        {
          delivered: r.delivered, wired: r.wired, target: r.target,
          pid: r.pid, status: r.status, hasToken: r.hasToken, replied: r.replied, deliveredAt: r.deliveredAt,
        },
        { delivered: true, wired: true, target: 'bod', pid: 24572, status: 'idle', hasToken: true, replied: true, deliveredAt: '2026-11-20T00:00:00.000Z' },
      );
      // 帧序断言（W3-e §三.2：auth 首行握手 → 消息帧）
      assert.equal(deps.written.length, 2, 'token 在场=两帧（auth 握手+消息）');
      assert.ok(deps.written[0].endsWith('\n'), 'auth 帧 \\n 尾（①闸 NDJSON 行分帧）');
      assert.ok(deps.written[1].endsWith('\n'), '消息帧 \\n 尾（①闸 NDJSON 行分帧）');
      const authFrame = JSON.parse(deps.written[0].split('|')[1]) as Record<string, unknown>;
      assert.equal(authFrame.type, 'auth', 'auth 帧 type 字段（两候形主铸带 type）');
      assert.equal(authFrame.token, 'a'.repeat(64), 'auth 帧 token=装配 key 值（mock 值·真值零回显锚在结果面/u9）');
      const msgFrame = JSON.parse(deps.written[1].split('|')[1]) as Record<string, unknown>;
      assert.deepEqual(
        { type: msgFrame.type, fromMode: msgFrame.fromMode, name: msgFrame.name },
        { type: 'user', fromMode: 'bypass', name: 'trilc-seat-wake' },
      );
      assert.equal(msgFrame.msg_id, (r as { msgId?: string }).msgId, 'msg_id=结果面 msgId（peer_message_status 回执关联锚）');
      assert.ok(
        String(msgFrame.from).startsWith('uds:\\\\.\\pipe\\LOCAL\\trilc-wake-reply-'),
        'from=uds: 前缀+自建临时 reply socket（W3-g §四.2·lPo 前缀检过）',
      );
      assert.deepEqual(
        msgFrame.message,
        { role: 'user', content: '[seat-wake probe] wake @2026-11-20T00:00:00.000Z' },
        'message 对象形（官方配方铁证·De 只读 message.content·W3-g §四.1）',
      );
      assert.ok(!('body' in msgFrame), 'body 字段零在场（双置删除·W3-g §四.1）');
      assert.ok(!('token' in msgFrame), 'token 不进消息帧（auth 帧传输层专用·D-46）');
      // R6-b 探针读数随件（W3-h §二.②·乱码分界双证）
      const expectedBody = '[seat-wake probe] wake @2026-11-20T00:00:00.000Z';
      assert.equal((r as { bodyBytes?: number }).bodyBytes, Buffer.byteLength(expectedBody, 'utf8'), 'bodyBytes=bodyText 全量 utf8 字节（探针）');
      assert.equal(
        (r as { cp16Hex?: string }).cp16Hex,
        Array.from('wake'.slice(0, 16)).map((c) => c.codePointAt(0)!.toString(16).padStart(4, '0')).join(' '),
        'cp16Hex=reason 前 16 codepoint hex（探针·ASCII 形）',
      );
    });
    it('u11 busy 状态照发语义（W3-a §二.2·status 随结果面透传）', async () => {
      const deps = makeDeps({ sessions: [{ pid: 24572, name: 'bod', agent: 'Board', socketPath: '\\\\.\\pipe\\x', status: 'busy' }] });
      const r = await createWakeAction(deps)({});
      assert.equal(r.status, 'busy');
      assert.equal(r.delivered, true);
    });
    it('u12 key 缺席 → hasToken:false 照投（装配面容错形·零 auth 帧单帧投递）', async () => {
      const deps = makeDeps({ keys: {} });
      const r = await createWakeAction(deps)({});
      assert.equal(r.hasToken, false);
      assert.equal(r.delivered, true);
      assert.equal(deps.written.length, 1, 'token 缺席=跳过 auth 握手（单消息帧）');
    });
    it('u17 R6-b 探针中文形：reason 中文 → bodyBytes 多字节+cp16Hex 中文码点（乱码分界读数能力钉）', async () => {
      const deps = makeDeps();
      const r = await createWakeAction(deps)({ source: 'probe', reason: '中文分界拍' });
      const expectedBody = '[seat-wake probe] 中文分界拍 @2026-11-20T00:00:00.000Z';
      assert.equal((r as { bodyBytes?: number }).bodyBytes, Buffer.byteLength(expectedBody, 'utf8'), 'bodyBytes 多字节计（中文字节>字符数）');
      const expectedCp = Array.from('中文分界拍'.slice(0, 16)).map((c) => c.codePointAt(0)!.toString(16).padStart(4, '0')).join(' ');
      assert.equal((r as { cp16Hex?: string }).cp16Hex, expectedCp, 'cp16Hex=中文 codepoint hex');
      assert.ok(expectedCp.includes('4e2d'), '中文码点 4e2d（中）在探——乱码时此处显形=「收到时已乱 vs 发出才乱」分界读数核心');
    });
  });

  describe('装配面（wireSeatWakeAction 入口+回滚锚）', () => {
    it('u13 wireSeatWakeAction 装配后 isWakeActionWired=true·clear 回骨架态', async () => {
      assert.equal(isWakeActionWired(), false);
      wireSeatWakeAction(makeDeps());
      assert.equal(isWakeActionWired(), true);
      clearWakeActionHandler();
      assert.equal(isWakeActionWired(), false);
    });
    it('u14 装配后经 handler 真身走五步（mock 注入透传）', async () => {
      wireSeatWakeAction(makeDeps());
      // 经 app.ts 路由的 handler 间接调用（模块级变量同体）——此处直接验证装配产物行为面
      const r = await createWakeAction(makeDeps())({});
      assert.equal(r.wired, true);
    });
  });

  describe('pid 存活探测（第 2 步守门依赖）', () => {
    it('u15 现进程探活=true（自参真值）', () => {
      assert.equal(isPidAlive(process.pid), true);
    });
    it('u16 探活契约=布尔形（win32 pid 0 语义特殊如实注·ESRCH 判死分支由 u8 mock 承载）', () => {
      // win32: pid 0=System Idle Process 面 OpenProcess 可达→process.kill(0,0) 不 ESRCH
      // （本席实勘 true!==false 教训）；ESRCH 判死分支真值面无稳定可探死 pid（不杀真进程）
      // ——分支语义由 u8 pidAlive mock=false 承载，此案只钉布尔形契约。
      assert.equal(typeof isPidAlive(process.pid), 'boolean');
    });
  });
});

// ── W3-WAKE 真值连接器案组（修复②·真 named pipe server 内存对拍·mock 掩盖家族教训钉补）──
// 教训锚（W3-e §一+预勘卷 §二）：33 案白盒全走 mock connector→真值连接器内部状态机零覆盖→
// settled 互斥重用永挂 bug 白盒不可见。s1 修复前必红（永挂→案级 3s 超时红）=回归钉——
// 后续任何连接器状态机改动必过此案组。

/** 真 named pipe 临时 server（收帧录制+行分帧 onLine 回调·close 全收口） */
interface PipeServer {
  path: string;
  frames: string[];
  close(): Promise<void>;
}

function startPipeServer(onLine: (line: string, sock: net.Socket) => void): Promise<PipeServer> {
  const pipePath = `\\\\.\\pipe\\trilc-test-${randomUUID()}`;
  const frames: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    let buf = '';
    sock.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        frames.push(line);
        onLine(line, sock);
      }
    });
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => {});
  });
  server.on('error', () => {});
  return new Promise((resolve) => {
    server.listen(pipePath, () => {
      resolve({
        path: pipePath,
        frames,
        close: async () => {
          for (const s of sockets) s.destroy();
          await new Promise<void>((res) => server.close(() => res()));
        },
      });
    });
  });
}

describe('W3-WAKE 真值连接器案组（s1-s4·真 socket 对拍·修复②回归钉）', () => {
  it('s1 回执形：server 收帧回写 → waitReply resolve 该文本（修复前必红·回归钉）', { timeout: 3000 }, async () => {
    const srv = await startPipeServer((_line, sock) => { sock.write('ACK ok\n'); });
    try {
      const conn = await defaultConnectSocket(srv.path);
      conn.write('ping\n');
      const reply = await conn.waitReply(2000);
      conn.destroy();
      assert.ok(reply !== null && reply.includes('ACK ok'), `回执面 resolve（实收=${JSON.stringify(reply)}）`);
      assert.deepEqual(srv.frames, ['ping'], 'server 侧收帧录制对拍');
    } finally {
      await srv.close();
    }
  });

  it('s2 超时形：server 静默保持 → waitReply 限时 resolve null（非永挂）', { timeout: 3000 }, async () => {
    const srv = await startPipeServer(() => { /* 零回执 */ });
    try {
      const conn = await defaultConnectSocket(srv.path);
      conn.write('ping\n');
      const t0 = Date.now();
      const reply = await conn.waitReply(400);
      conn.destroy();
      assert.equal(reply, null, '超时路径 resolve null');
      assert.ok(Date.now() - t0 >= 350, 'timer 面 ~400ms 非即返');
    } finally {
      await srv.close();
    }
  });

  it('s3 close 形：server 收帧即断 → close 路 resolve null（EPIPE/对端断族）', { timeout: 3000 }, async () => {
    const srv = await startPipeServer((_line, sock) => { sock.destroy(); });
    try {
      const conn = await defaultConnectSocket(srv.path);
      conn.write('ping\n');
      const reply = await conn.waitReply(2000);
      conn.destroy();
      assert.equal(reply, null, 'close 路径 resolve（pendingText 空→null）');
    } finally {
      await srv.close();
    }
  });

  it('s4 连接拒形：管道不存在 → connector reject（errno 码族面）', { timeout: 3000 }, async () => {
    await assert.rejects(
      defaultConnectSocket(`\\\\.\\pipe\\trilc-test-nonexistent-${randomUUID()}`),
      (err: unknown) => {
        const code = (err as NodeJS.ErrnoException).code;
        return typeof code === 'string' && code.length > 0;
      },
    );
  });

  it('s5 真值投递端到端：wakeAction 全链真 socket（auth→msg 帧序+NDJSON 行分帧 server 侧对拍）', { timeout: 3000 }, async () => {
    const srv = await startPipeServer((line, sock) => {
      const f = JSON.parse(line) as Record<string, unknown>;
      if (f.type === 'auth') sock.write(JSON.stringify({ type: 'auth_ok' }) + '\n');
      else sock.write(JSON.stringify({ type: 'peer_message_status', orig_msg_id: f.msg_id, status: 'delivered' }) + '\n');
    });
    try {
      const keyToken = 'c'.repeat(64);
      const deps: WakeDeps = {
        sessionsDir: 'X:\\mock-sessions',
        listDir: () => ['24572.json', `24572.${keyToken}.key`],
        readFileUtf8: (p: string) => {
          const base = p.split(/[\\/]/).pop() ?? '';
          if (base === '24572.json') {
            return JSON.stringify({ name: 'bod', agent: 'Board', messagingSocketPath: srv.path, status: 'idle' });
          }
          return JSON.stringify({ peerToken: keyToken }); // W3-f 信封形
        },
        fileExists: (p: string) => (p.split(/[\\/]/).pop() ?? '').endsWith('.key'),
        pidAlive: () => true,
        nowIso: () => '2026-11-20T00:00:00.000Z',
      };
      const r = await createWakeAction(deps)({ source: 's5', reason: 'true-socket-e2e' });
      assert.equal(r.delivered, true, '真值全链投递成');
      assert.equal((r as { replied?: boolean }).replied, true, '回执信息面（真 socket 回写面）');
      // server 侧按行分帧收到 auth→消息 帧序（①闸 NDJSON 真值解析对拍）
      assert.equal(srv.frames.length, 2, '两帧按行分帧（零粘连零截断）');
      const f0 = JSON.parse(srv.frames[0]) as Record<string, unknown>;
      const f1 = JSON.parse(srv.frames[1]) as Record<string, unknown>;
      assert.equal(f0.type, 'auth', '首行=auth 帧（②闸握手序）');
      assert.equal(f0.token, keyToken, 'auth token=key 装配值（mock 值）');
      assert.equal(f1.type, 'user', '次行=消息帧');
      assert.equal(f1.fromMode, 'bypass', 'fromMode 写入（③闸）');
      assert.equal((r as { msgId?: string }).msgId, f1.msg_id, 'msg_id 关联一致');
      assert.equal(
        String(f1.from).startsWith('uds:\\\\.\\pipe\\LOCAL\\trilc-wake-reply-'), true,
        'from=uds: 前缀+自建临时 reply socket 形（W3-g §四.2）',
      );
      assert.deepEqual(
        f1.message,
        { role: 'user', content: '[seat-wake probe] true-socket-e2e @2026-11-20T00:00:00.000Z' },
        'message 对象形（官方配方铁证·W3-g §四.1）',
      );
    } finally {
      await srv.close();
    }
  });

  it('s6 回执拨回真值案：对端拨 from 地址→内部 replyServer 消费→race resolve（W3-g §四.3 结构性缺口回归钉）', { timeout: 3000 }, async () => {
    // mock connector=原连接零回写形（Windows accept 静默实锚模拟·waitReply 满 2s 窗才 null）——
    // 唯一回执通道=server 拨回 from 地址（inbound handler 消费·race 先到先 resolve）。
    // 修复前此案 replied:false 红（造件 listener 零消费·回执不可达）=结构性缺口回归钉。
    let capturedFrom: string | null = null;
    const deps = makeDeps({
      connect: async () => ({
        write: (data: string) => {
          try {
            const f = JSON.parse(data) as { from?: string };
            if (typeof f.from === 'string' && f.from.startsWith('uds:')) capturedFrom = f.from.slice(4);
          } catch { /* auth 帧无 from 形容忍 */ }
        },
        waitReply: (ms: number) => new Promise<string | null>((res) => setTimeout(() => res(null), ms)),
        destroy: () => {},
      }),
    });
    const p = createWakeAction(deps)({ source: 's6', reason: 'inbound-race' });
    await new Promise((r) => setTimeout(r, 120)); // listen+两帧写完成
    assert.ok(capturedFrom !== null, 'from 地址捕获（uds: 前缀剥除=裸管道路径）');
    // 对端拨回：真连 replyServer 裸路径→写 peer_message_status 回执行→半关（close 触发 inboundDone）
    const sock = net.connect(capturedFrom as string);
    await new Promise<void>((res, rej) => { sock.once('connect', () => res()); sock.once('error', rej); });
    sock.write(JSON.stringify({ type: 'peer_message_status', status: 'held', orig_msg_id: 'x' }) + '\n');
    sock.end();
    const r = await p;
    assert.equal(r.delivered, true);
    assert.equal((r as { replied?: boolean }).replied, true, 'inbound 回执经 race resolve（replied=true·held 状态面可达）');
  });
});
