// ── 债② 同族 POST 端点 abort 防御白盒（WO-RW1 批 1·2026-11-20）──
// 崩级面：客户端中途断连（hook 侧 timeout destroy 形等）→server for-await
// 抛 ECONNRESET——旧形未捕获=daemon 崩级 rejection（fddb630 markRead 诊断
// 实锚同族）——修形=照 markRead 正形（fddb630）26 处统一内层 try/catch+静默 return。
// 本案三形代表真断连活体：C 形裸块（init/assemble）/B 形单行（staffing/onboard）/
// A 形外层 try（fade/runs）+markRead 已修形回归钉+断连后业务探针绿（daemon 存活
// +handler 正常运转到业务校验段=变更值面探针形完工判据·非 healthz）。
// 起服配方对齐 notify-hook-e2e.test.ts 先例（port 0+死端口 trimodelApiUrl+临时 DATA_DIR）。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTriLCApp } from '../../src/server/app.js';

const TEST_TOKEN = 'debt2-abort-e2e-token';

interface PostResult { status: number | null; body: string; reset: boolean }

/** POST 请求·opts.halfBody=真 content-length 但 body 只写一半后 destroy
 * （ECONNRESET 活体模拟·fddb630 诊断形同族）——断言 reset 实锚断连形态。 */
function post(port: number, path: string, body: string, opts?: { halfBody?: boolean }): Promise<PostResult> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = {
      'content-type': 'application/json',
      'x-internal-token': TEST_TOKEN,
    };
    if (body.length > 0) headers['content-length'] = Buffer.byteLength(body);
    const req = httpRequest(
      { hostname: '127.0.0.1', port, path, method: 'POST', headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => chunks.push(d));
        res.on('end', () => resolve({ status: res.statusCode ?? null, body: Buffer.concat(chunks).toString('utf-8'), reset: false }));
      },
    );
    req.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ECONNRESET' || e.code === 'EPIPE') resolve({ status: null, body: '', reset: true });
      else reject(e);
    });
    if (opts?.halfBody && body.length >= 2) {
      // 写 content-length 一半字节后强断 socket（服务端 for-await 挂等剩余→reset 抛）
      const half = body.slice(0, Math.floor(body.length / 2));
      req.write(half, () => {
        req.destroy(); // 零参 destroy=真断连形（hook timeout 同族·带参 error 面=客户端侧 reject 假败非断连实锚）
      });
    } else {
      req.end(body);
    }
  });
}

/** 断连后业务探针：markRead 正常路径（body 读段+handler+业务校验全链）——
 * 响应面=业务 JSON（非 ECONNRESET/零响应）=daemon 存活值面探针（非 healthz）。 */
function markReadProbe(port: number): Promise<PostResult> {
  return post(port, '/internal/v1/notify/mailbox', JSON.stringify({ message_id: 'debt2-probe-nonexistent' }));
}

describe('债② abort 防御（中途断连 ECONNRESET·daemon 存活）', () => {
  let app: ReturnType<typeof createTriLCApp>;
  let appPort: number;
  let tmpDataDir: string;

  const SAVED_ENV = {
    TRILC_DATA_DIR: process.env.TRILC_DATA_DIR,
    TRILC_PORT: process.env.TRILC_PORT,
    TRIMODEL_API_TOKEN: process.env.TRIMODEL_API_TOKEN,
    TRILC_INTERNAL_TOKEN: process.env.TRILC_INTERNAL_TOKEN,
    TRIMC_NOTIFY_MAILBOX: process.env.TRIMC_NOTIFY_MAILBOX,
  };

  before(async () => {
    tmpDataDir = mkdtempSync(join(tmpdir(), 'trilc-abort-defense-'));
    mkdirSync(join(tmpDataDir, 'projects'), { recursive: true });
    process.env.TRILC_DATA_DIR = tmpDataDir;
    process.env.TRILC_PORT = '0';
    process.env.TRIMC_NOTIFY_MAILBOX = join(tmpDataDir, 'notify-mailbox.json');
    delete process.env.TRIMODEL_API_TOKEN;
    process.env.TRILC_INTERNAL_TOKEN = TEST_TOKEN;

    const { readEnv } = await import('../../src/config/env.js');
    const env = readEnv();
    env.port = 0;
    env.trimodelApiUrl = 'http://127.0.0.1:1'; // 死端口快速降级·零外呼

    app = createTriLCApp(env);
    await app.start();
    appPort = env.port;
    if (!appPort) throw new Error('app did not bind a port');
  });

  after(async () => {
    for (const [k, v] of Object.entries(SAVED_ENV)) {
      if (v === undefined) delete process.env[k];
      else (process.env as Record<string, string | undefined>)[k] = v;
    }
    try { await app.stop(); } catch { /* swallow */ }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try { rmSync(tmpDataDir, { recursive: true, force: true }); break; } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  });

  /** 断连→daemon 存活复合断言（本文件全案共用）：断连 reset 实锚+短窗（异步
   * rejection 若有则崩在此窗=node --test 下未捕获 rejection 即进程崩=案件败）
   * +markRead 业务探针绿（值面·非 healthz）。 */
  async function assertAbortThenAlive(path: string, body: string): Promise<void> {
    const r = await post(appPort, path, body, { halfBody: true });
    assert.equal(r.reset, true, `断连应实锚 ECONNRESET/EPIPE（得 reset=${r.reset} status=${r.status}）`);
    await new Promise((res) => setTimeout(res, 300)); // 异步 rejection 沉降窗
    const probe = await markReadProbe(appPort);
    // 探针 id 非信箱内实件→业务面 404 {ok:false}=handler 全链绿（body 读段→JSON 解析→markRead 查无回 404）
    // ——status 200/404 皆业务面绿（reset:null/零响应=败）
    assert.ok(probe.status === 200 || probe.status === 404, `断连后业务探针应绿（status=${probe.status} body=${probe.body.slice(0, 200)}）`);
    assert.ok(probe.body.includes('"ok"'), '探针响应=业务 JSON 面（非零响应非 reset）');
  }

  it('a1 C 形裸块代表 init/assemble：写半 body destroy→daemon 存活+业务探针绿', async () => {
    await assertAbortThenAlive('/internal/v1/init/assemble', JSON.stringify({ roleCatalog: 'x'.repeat(64) }));
  });

  it('a2 B 形单行代表 staffing/onboard：同形断连→存活+探针绿', async () => {
    await assertAbortThenAlive('/internal/v1/staffing/onboard', JSON.stringify({ seat: 'probe' }));
  });

  it('a3 A 形外层 try 代表 fade/runs：断连→存活+探针绿（断连零进业务 catch 面）', async () => {
    await assertAbortThenAlive('/internal/v1/fade/runs', JSON.stringify({ runId: 'probe' }));
  });

  it('a4 markRead 已修形回归钉：断连→存活（fddb630 正形零回归）', async () => {
    await assertAbortThenAlive('/internal/v1/notify/mailbox', JSON.stringify({ message_id: 'debt2-abort-regression' }));
  });

  it('a5 断连后全形正常路径无损：markRead 正常 body 全程→业务响应（零副作用坏态）', async () => {
    // 断连风暴（三连）后正常请求照常=防御面非坏态（零半开连接残留语义）
    for (const p of ['/internal/v1/init/assemble', '/internal/v1/staffing/onboard', '/internal/v1/fade/runs']) {
      const r = await post(appPort, p, JSON.stringify({ x: 'y'.repeat(32) }), { halfBody: true });
      assert.equal(r.reset, true, `${p} 断连应实锚`);
    }
    await new Promise((res) => setTimeout(res, 300));
    const probe = await markReadProbe(appPort);
    assert.ok(probe.status === 200 || probe.status === 404, `探针业务面绿（status=${probe.status}）`);
    const okBody = JSON.parse(probe.body) as { ok?: boolean };
    assert.ok('ok' in okBody, `探针=业务面 JSON（得=${probe.body.slice(0, 120)}）`);
  });
});
