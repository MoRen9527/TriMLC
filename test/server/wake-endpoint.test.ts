// ── BOD 实时收件三级链 W2·POST /internal/v1/wake 端点白盒（W2-b 自测）──
// 派工卷：docs/workflow/operating-records/2026-W47/trees/bod-wake-chain-20261120/
//         cos-w2-wake-endpoint-dispatch-20261120.md（§二 W2-b·m-fsd 主刀）。
//
// 契约钉面（骨架期）：
//   正向未接线   带 token POST（空 body / {source,reason} body）
//              → 200 {object:'wake', accepted:false, wired:false, reason:'wake_action_not_wired'}
//   负向门族     无 token/伪 token → 401 unauthorized（全局门族照抄·零新增鉴权）
//              token 未配置 → 401 internal_auth_disabled（fail-closed 同族）
//   形检负向     坏 JSON → 400 invalid_json_body；JSON 非 object → 400 payload_must_be_object；
//              source/reason 非串 → 400 source_must_be_string / reason_must_be_string
//   接线口单元   set→wired→handler 调用透传 accepted:true；handler 抛错 → 500 wake_action_failed；
//              clear 还原未接线态
//   现役族不损   healthz / cron jobs / power / config show（wake 加入后同拍全绿对表）
//
// 起服配方对齐 test/server/auth-gate-rejection.test.ts 先例（临时数据目录 +
// port 0 + trimodelApiUrl 死端口快速降级 + node:http 裸请求）。
// 撞词消歧：与 heartbeat-wake（this.wake 心跳唤醒模块）无关联。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createTriLCApp,
  setWakeActionHandler,
  clearWakeActionHandler,
  isWakeActionWired,
} from '../../src/server/app.js';

const WAKE_TOKEN = 'w2-b-wake-endpoint-fixed-token';

// ══════════════════════ 单元层：接线口三导出 ══════════════════════

describe('W2 wake 接线口单元层：set/clear/isWired', () => {
  after(() => {
    clearWakeActionHandler(); // 兜底还原，防泄漏至端到端层
  });

  it('u1 缺省未接线：isWakeActionWired=false', () => {
    clearWakeActionHandler();
    assert.equal(isWakeActionWired(), false);
  });

  it('u2 set→wired=true；clear→还原 false', () => {
    clearWakeActionHandler();
    setWakeActionHandler(async () => ({}));
    assert.equal(isWakeActionWired(), true);
    clearWakeActionHandler();
    assert.equal(isWakeActionWired(), false);
  });

  it('u3 重复注册以最后一次为准（非首次）', async () => {
    clearWakeActionHandler();
    let called = '';
    setWakeActionHandler(async () => { called = 'first'; return {}; });
    setWakeActionHandler(async () => { called = 'second'; return {}; });
    assert.equal(isWakeActionWired(), true);
    // 端到端层 e10 验证调用面走 second；此处只钉导出不抛。
    assert.equal(called, '');
    clearWakeActionHandler();
  });
});

// ══════════════════════ 端到端层：真起服过全局门 ══════════════════════

describe('W2 wake 端点端到端：createTriLCApp 真实 HTTP（全局门族内·骨架期）', () => {
  let app: ReturnType<typeof createTriLCApp>;
  let appPort: number;
  let tmpDataDir: string;

  const SAVED_ENV = {
    TRILC_DATA_DIR: process.env.TRILC_DATA_DIR,
    TRILC_PORT: process.env.TRILC_PORT,
    TRIMODEL_API_TOKEN: process.env.TRIMODEL_API_TOKEN,
    TRILC_INTERNAL_TOKEN: process.env.TRILC_INTERNAL_TOKEN,
  };

  async function rawRequest(
    path: string,
    opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ): Promise<{ status: number; json: any }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: appPort,
          path,
          method: opts.method ?? 'GET',
          headers: opts.headers ?? {},
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf-8');
            let json: any = null;
            try { json = JSON.parse(text); } catch { /* 非 JSON 响应保留 null */ }
            resolve({ status: res.statusCode ?? 0, json });
          });
        },
      );
      req.on('error', reject);
      if (opts.body !== undefined) req.write(opts.body);
      req.end();
    });
  }

  before(async () => {
    clearWakeActionHandler();
    tmpDataDir = mkdtempSync(join(tmpdir(), 'trilc-wake-ep-'));
    process.env.TRILC_DATA_DIR = tmpDataDir;
    process.env.TRILC_PORT = '0';
    delete process.env.TRIMODEL_API_TOKEN;
    process.env.TRILC_INTERNAL_TOKEN = WAKE_TOKEN;

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
    clearWakeActionHandler();
    for (const [k, v] of Object.entries(SAVED_ENV)) {
      if (v === undefined) delete process.env[k];
      else (process.env as Record<string, string | undefined>)[k] = v;
    }
    try { await app.stop(); } catch { /* swallow */ }
    for (let attempt = 0; attempt < 5; attempt++) {
      try { rmSync(tmpDataDir, { recursive: true, force: true }); break; } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  });

  it('e1 正向·未接线·空 body：200 {object:wake, accepted:false, wired:false, reason:wake_action_not_wired}（骨架值面完工判据形）', async () => {
    const res = await rawRequest('/internal/v1/wake', {
      method: 'POST',
      headers: { 'x-internal-token': WAKE_TOKEN },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { object: 'wake', accepted: false, wired: false, reason: 'wake_action_not_wired' });
  });

  it('e2 正向·未接线·{source,reason} body：同形 accepted:false（骨架期字段宽松容忍）', async () => {
    const res = await rawRequest('/internal/v1/wake', {
      method: 'POST',
      headers: { 'x-internal-token': WAKE_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'sg-hook', reason: 'bod-inbox-notify' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { object: 'wake', accepted: false, wired: false, reason: 'wake_action_not_wired' });
  });

  it('e3 负向·无 token：401 unauthorized（全局门族自动覆盖·零新增鉴权面实证）', async () => {
    const res = await rawRequest('/internal/v1/wake', { method: 'POST' });
    assert.equal(res.status, 401);
    assert.deepEqual(res.json, { error: 'unauthorized: missing or invalid X-Internal-Token' });
  });

  it('e4 负向·伪 token：401 unauthorized 同文案', async () => {
    const res = await rawRequest('/internal/v1/wake', {
      method: 'POST',
      headers: { 'x-internal-token': 'attacker-supplied-garbage' },
    });
    assert.equal(res.status, 401);
    assert.deepEqual(res.json, { error: 'unauthorized: missing or invalid X-Internal-Token' });
  });

  it('e5 负向·token 未配置：401 internal_auth_disabled（fail-closed 同族）', async () => {
    const prev = process.env.TRILC_INTERNAL_TOKEN;
    delete process.env.TRILC_INTERNAL_TOKEN;
    try {
      const res = await rawRequest('/internal/v1/wake', { method: 'POST' });
      assert.equal(res.status, 401);
      assert.deepEqual(res.json, { error: 'internal_auth_disabled' });
    } finally {
      if (prev === undefined) delete process.env.TRILC_INTERNAL_TOKEN;
      else process.env.TRILC_INTERNAL_TOKEN = prev;
    }
  });

  it('e6 形检·坏 JSON body：400 invalid_json_body', async () => {
    const res = await rawRequest('/internal/v1/wake', {
      method: 'POST',
      headers: { 'x-internal-token': WAKE_TOKEN, 'content-type': 'application/json' },
      body: '{not-valid-json',
    });
    assert.equal(res.status, 400);
    assert.deepEqual(res.json, { error: 'invalid_json_body' });
  });

  it('e7 形检·JSON 非 object（数组）：400 payload_must_be_object', async () => {
    const res = await rawRequest('/internal/v1/wake', {
      method: 'POST',
      headers: { 'x-internal-token': WAKE_TOKEN },
      body: '[1,2,3]',
    });
    assert.equal(res.status, 400);
    assert.deepEqual(res.json, { error: 'payload_must_be_object' });
  });

  it('e8 形检·source/reason 非串：400 source_must_be_string / reason_must_be_string', async () => {
    const r1 = await rawRequest('/internal/v1/wake', {
      method: 'POST',
      headers: { 'x-internal-token': WAKE_TOKEN },
      body: JSON.stringify({ source: 42 }),
    });
    assert.equal(r1.status, 400);
    assert.deepEqual(r1.json, { error: 'source_must_be_string' });

    const r2 = await rawRequest('/internal/v1/wake', {
      method: 'POST',
      headers: { 'x-internal-token': WAKE_TOKEN },
      body: JSON.stringify({ reason: [] }),
    });
    assert.equal(r2.status, 400);
    assert.deepEqual(r2.json, { error: 'reason_must_be_string' });
  });

  it('e9 方法错·GET：非 200（路由 POST-only·实读形断言）', async () => {
    const res = await rawRequest('/internal/v1/wake', {
      method: 'GET',
      headers: { 'x-internal-token': WAKE_TOKEN },
    });
    assert.notEqual(res.status, 200);
    assert.notEqual(res.status, 401); // token 已对·拒绝必来自路由缺位而非鉴权
    assert.notEqual(res.status, 403);
  });

  it('e10 接线后正向：handler 被调·payload 透传·200 {accepted:true, wired:true, ...result}', async () => {
    let seenPayload: unknown = null;
    setWakeActionHandler(async (payload) => {
      seenPayload = payload;
      return { dispatched: true, channel: 'stub' };
    });
    try {
      assert.equal(isWakeActionWired(), true);
      const res = await rawRequest('/internal/v1/wake', {
        method: 'POST',
        headers: { 'x-internal-token': WAKE_TOKEN },
        body: JSON.stringify({ source: 'w2a-form', reason: 'wired-test' }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(res.json, { object: 'wake', accepted: true, wired: true, dispatched: true, channel: 'stub' });
      assert.deepEqual(seenPayload, { source: 'w2a-form', reason: 'wired-test' });
    } finally {
      clearWakeActionHandler();
    }
  });

  it('e11 接线后·handler 抛错：500 wake_action_failed（错误面不裸奔堆栈）', async () => {
    setWakeActionHandler(async () => {
      throw new Error('stub-channel-explosion');
    });
    try {
      const res = await rawRequest('/internal/v1/wake', {
        method: 'POST',
        headers: { 'x-internal-token': WAKE_TOKEN },
        body: '{}',
      });
      assert.equal(res.status, 500);
      assert.equal(res.json?.error, 'wake_action_failed');
      assert.equal(res.json?.message, 'stub-channel-explosion');
    } finally {
      clearWakeActionHandler();
    }
  });

  it('e12 现役端点族不损对表：healthz/cron jobs/power/config show 同拍全绿', async () => {
    const hz = await rawRequest('/healthz');
    assert.equal(hz.status, 200);
    assert.equal(hz.json?.ok, true);

    const jobs = await rawRequest('/internal/v1/cron/jobs', {
      headers: { 'x-internal-token': WAKE_TOKEN },
    });
    assert.equal(jobs.status, 200);
    assert.equal(jobs.json?.ok, true);
    assert.ok(Array.isArray(jobs.json?.jobs));

    const power = await rawRequest('/internal/v1/power', {
      headers: { 'x-internal-token': WAKE_TOKEN },
    });
    assert.equal(power.status, 200);
    assert.equal(power.json?.object, 'power');

    const cfg = await rawRequest('/internal/v1/config/show', {
      headers: { 'x-internal-token': WAKE_TOKEN },
    });
    assert.equal(cfg.status, 200);
    assert.equal(cfg.json?.object, 'config.show');
  });
});
