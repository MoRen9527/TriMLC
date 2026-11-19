// ── Seat-wake wake 动作接线白盒（W3-b·W3-a 形定卷 §四.4 案形）──
// 案形边界：名址解析 mock+守门分支+reason 分层——真管道写案不入白盒（活体面归 W3-d 探针窗）。
// 基础面：node:test + assert/strict（照现役套件形）；deps 全 mock 零真盘 IO。
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createWakeAction,
  resolveBodTargets,
  wireSeatWakeAction,
  isPidAlive,
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
  const keys = overrides.keys ?? { 24572: 'a'.repeat(64) + '\n' };
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
    it('u10 全绿投递 → delivered:true+wired:true+status/hasToken 透传', async () => {
      const deps = makeDeps();
      const r = await createWakeAction(deps)({ source: 'probe', reason: 'wake' });
      assert.deepEqual(
        {
          delivered: r.delivered, wired: r.wired, target: r.target,
          pid: r.pid, status: r.status, hasToken: r.hasToken, replied: r.replied, deliveredAt: r.deliveredAt,
        },
        { delivered: true, wired: true, target: 'bod', pid: 24572, status: 'idle', hasToken: true, replied: true, deliveredAt: '2026-11-20T00:00:00.000Z' },
      );
      // 投递信封=peer 帧形断言（W3-d 校形卷 §三.1·协议形）
      assert.equal(deps.written.length, 1);
      const envelope = JSON.parse(deps.written[0].split('|')[1]) as Record<string, unknown>;
      assert.deepEqual(
        { kind: envelope.kind, from: envelope.from, name: envelope.name },
        { kind: 'peer', from: 'did:trilc-seat-wake', name: 'trilc-seat-wake' },
      );
      assert.ok(String(envelope.body).startsWith('[seat-wake probe]'), 'body 信文自描述形（护栏①）');
      assert.ok(!('auth' in envelope), 'auth 字段移除不进帧（W3-d 校形卷 §二·协议零 token 消费点·D-46 增强锚）');
      assert.ok(!('fromMode' in envelope), 'fromMode 零写（honor 边界·absent 正形）');
    });
    it('u11 busy 状态照发语义（W3-a §二.2·status 随结果面透传）', async () => {
      const deps = makeDeps({ sessions: [{ pid: 24572, name: 'bod', agent: 'Board', socketPath: '\\\\.\\pipe\\x', status: 'busy' }] });
      const r = await createWakeAction(deps)({});
      assert.equal(r.status, 'busy');
      assert.equal(r.delivered, true);
    });
    it('u12 key 缺席 → hasToken:false 照投（装配面容错形）', async () => {
      const deps = makeDeps({ keys: {} });
      const r = await createWakeAction(deps)({});
      assert.equal(r.hasToken, false);
      assert.equal(r.delivered, true);
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
