// ── Q2 反向通道件③：POST /internal/v1/notify 收箱落箱端点（2026-10-15）──
// 派工单 046caf7cb（CTO 2026-10-15 18:19 +0800·CEO 18:16 批）·红线四条技术形逐条入测：
//   红线① ≤8KB 无文件字段 → n4（file 字段 400）/ n5（body>8KB 413）/ n9（信封>16KB 413）
//   红线② 白名单最小集写死 → n3（白名单外 403 source_seat_not_allowed）/ n0（门前 401 结构证）
//   红线③ 收推≠执行 → n6/n7（advisory 服务端硬打标·客户端字段不信任）
//   红线④ 端到端幂等 → n2（同 message_id 重投 duplicate=true →拉取器安全消账）
// 起服配方对齐 test/server/auth-gate-rejection.test.ts 既有先例（临时数据目录 +
// port 0 + trimodelApiUrl 死端口）；信箱文件经 TRIMC_NOTIFY_MAILBOX 钉到临时路径
// （隔离默认 cwd/notify-mailbox.json，防测试污染仓面 + advisory 断言读文件面）。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTriLCApp } from '../../src/server/app.js';

const TEST_INTERNAL_TOKEN = 'q2-notify-inbox-test-token';

describe('Q2 件③：POST /internal/v1/notify 收箱端点（真起服·X-Internal-Token 门内）', () => {
  let app: ReturnType<typeof createTriLCApp>;
  let appPort: number;
  let tmpDataDir: string;
  let mailboxFile: string;

  const SAVED_ENV = {
    TRILC_DATA_DIR: process.env.TRILC_DATA_DIR,
    TRILC_PORT: process.env.TRILC_PORT,
    TRIMODEL_API_TOKEN: process.env.TRIMODEL_API_TOKEN,
    TRILC_INTERNAL_TOKEN: process.env.TRILC_INTERNAL_TOKEN,
    TRIMC_NOTIFY_MAILBOX: process.env.TRIMC_NOTIFY_MAILBOX,
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
          headers: { 'x-internal-token': TEST_INTERNAL_TOKEN, ...(opts.headers ?? {}) },
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

  /** 读临时信箱文件（advisory 等全字段断言面——GET summary 投影不含 advisory）。 */
  function readMailbox(): Array<Record<string, unknown>> {
    const doc = JSON.parse(readFileSync(mailboxFile, 'utf-8')) as { letters: Array<Record<string, unknown>> };
    return doc.letters;
  }

  before(async () => {
    tmpDataDir = mkdtempSync(join(tmpdir(), 'trilc-notify-inbox-'));
    mailboxFile = join(tmpDataDir, 'notify-mailbox.json');
    process.env.TRILC_DATA_DIR = tmpDataDir;
    process.env.TRILC_PORT = '0';
    process.env.TRIMC_NOTIFY_MAILBOX = mailboxFile;
    delete process.env.TRIMODEL_API_TOKEN;
    process.env.TRILC_INTERNAL_TOKEN = TEST_INTERNAL_TOKEN;

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
    for (let attempt = 0; attempt < 5; attempt++) {
      try { rmSync(tmpDataDir, { recursive: true, force: true }); break; } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  });

  it('n0 无 token → 401 unauthorized（端点结构在 auth 门内的死证·若误置门外应得 200/403）', async () => {
    const res = await rawRequest('/internal/v1/notify', {
      method: 'POST',
      headers: { 'x-internal-token': 'wrong-token' },
      body: JSON.stringify({ source_seat: 'mc-echo-pull', title: 't', body: 'b' }),
    });
    assert.equal(res.status, 401);
  });

  it('n1 白名单内 echo 席合法载荷 → 200 stored=true·advisory=true 服务端硬打标落箱', async () => {
    const res = await rawRequest('/internal/v1/notify', {
      method: 'POST',
      body: JSON.stringify({
        message_id: 'q2-n1-001',
        source_seat: 'mc-echo-pull',
        target_seat: 'm-cos',
        urgent: 'normal',
        title: '[Q2冒烟] 首信',
        body: '端到端消费面冒烟件（测试卷）',
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.json?.ok, true);
    assert.equal(res.json?.stored, true);
    assert.equal(res.json?.duplicate, false);
    const letters = readMailbox();
    const hit = letters.find((l) => l.message_id === 'q2-n1-001');
    assert.ok(hit, 'letter landed in mailbox file');
    assert.equal(hit.advisory, true, 'advisory 服务端强制打标（红线③收推≠执行）');
    assert.equal(hit.source_seat, 'mc-echo-pull');
    assert.equal(hit.target_seat, 'm-cos');
    assert.equal(hit.delivery, 'mailbox');
    assert.equal(hit.read, false);
    assert.ok(typeof hit.received_at === 'string' && hit.received_at.length > 0);
  });

  it('n2 同 message_id 重投 → 200 stored=false duplicate=true（端到端幂等锚·红线④）', async () => {
    const payload = JSON.stringify({
      message_id: 'q2-n2-retry',
      source_seat: 'mc-echo-pull',
      target_seat: 'm-cos',
      title: '重试幂等件',
      body: '同 id 二投不重落',
    });
    const first = await rawRequest('/internal/v1/notify', { method: 'POST', body: payload });
    const second = await rawRequest('/internal/v1/notify', { method: 'POST', body: payload });
    assert.equal(first.status, 200);
    assert.equal(first.json?.stored, true);
    assert.equal(second.status, 200);
    assert.equal(second.json?.stored, false);
    assert.equal(second.json?.duplicate, true);
    const hits = readMailbox().filter((l) => l.message_id === 'q2-n2-retry');
    assert.equal(hits.length, 1, 'mailbox 只落一份（storeLetter 幂等）');
  });

  it('n3 白名单外 source_seat → 403 source_seat_not_allowed（红线②负向探针·机器可判形）', async () => {
    for (const seat of ['bod', 'm-coo', 'random-seat', '']) {
      const res = await rawRequest('/internal/v1/notify', {
        method: 'POST',
        body: JSON.stringify({ source_seat: seat, title: 'x', body: 'y' }),
      });
      assert.equal(res.status, 403, `seat=${seat || '(empty)'} 应 403`);
      assert.equal(res.json?.error, 'source_seat_not_allowed');
    }
    assert.ok(!readMailbox().some((l) => l.source_seat !== 'mc-echo-pull'), '白名单外零落箱');
  });

  it('n4 白名单外字段（file 形）→ 400 forbidden_fields（红线①无文件传输形）', async () => {
    const res = await rawRequest('/internal/v1/notify', {
      method: 'POST',
      body: JSON.stringify({
        source_seat: 'mc-echo-pull',
        title: 'x',
        body: 'y',
        file: 'D:/secret.txt',
      }),
    });
    assert.equal(res.status, 400);
    assert.equal(res.json?.error, 'forbidden_fields');
    assert.deepEqual(res.json?.fields, ['file']);
  });

  it('n5 body 超 8KB → 413 body_over_8kb（红线①≤8KB·Buffer.byteLength 字节面）', async () => {
    const big = 'a'.repeat(8 * 1024 + 1);
    const res = await rawRequest('/internal/v1/notify', {
      method: 'POST',
      body: JSON.stringify({ source_seat: 'mc-echo-pull', title: 'x', body: big }),
    });
    assert.equal(res.status, 413);
    assert.equal(res.json?.error, 'body_over_8kb');
  });

  it('n5b 多字节 8KB 边界：utf-8 字节面超限拒（非字符数）', async () => {
    // 3000 个汉字 = 9000 utf-8 字节 > 8192（字符数面 3000 < 8192 的假阴性反例钉死）
    const res = await rawRequest('/internal/v1/notify', {
      method: 'POST',
      body: JSON.stringify({ source_seat: 'mc-echo-pull', title: 'x', body: '令'.repeat(3000) }),
    });
    assert.equal(res.status, 413);
  });

  it('n6 客户端 advisory:false 不被信任 → 落箱仍 advisory:true（服务端硬打标）', async () => {
    const res = await rawRequest('/internal/v1/notify', {
      method: 'POST',
      body: JSON.stringify({
        message_id: 'q2-n6-trust',
        source_seat: 'mc-echo-pull',
        title: '伪造 advisory:false 件',
        body: '客户端字段不信任',
        advisory: false,
      }),
    });
    assert.equal(res.status, 400, 'advisory 属白名单外字段→400（客户端连提交面都没有）');
    assert.equal(res.json?.error, 'forbidden_fields');
    assert.ok(!readMailbox().some((l) => l.message_id === 'q2-n6-trust'));
  });

  it('n7 缺 title/body → 400 title_and_body_required（空壳信零落箱）', async () => {
    const a = await rawRequest('/internal/v1/notify', {
      method: 'POST',
      body: JSON.stringify({ source_seat: 'mc-echo-pull', title: '', body: 'y' }),
    });
    const b = await rawRequest('/internal/v1/notify', {
      method: 'POST',
      body: JSON.stringify({ source_seat: 'mc-echo-pull', title: 'x' }),
    });
    assert.equal(a.status, 400);
    assert.equal(b.status, 400);
  });

  it('n8 target_seat 缺省 → 落箱 m-cos（一期单投递目标·拉取器可显式覆盖）', async () => {
    const res = await rawRequest('/internal/v1/notify', {
      method: 'POST',
      body: JSON.stringify({
        message_id: 'q2-n8-default-target',
        source_seat: 'mc-echo-pull',
        title: '缺省目标件',
        body: 'target_seat 缺省',
      }),
    });
    assert.equal(res.status, 200);
    const hit = readMailbox().find((l) => l.message_id === 'q2-n8-default-target');
    assert.equal(hit?.target_seat, 'm-cos');
  });

  it('n9 信封超 16KB → 413 payload_too_large（信封上限先于解析·防线收口）', async () => {
    const res = await rawRequest('/internal/v1/notify', {
      method: 'POST',
      body: JSON.stringify({ source_seat: 'mc-echo-pull', title: 'x', body: 'a'.repeat(17 * 1024) }),
    });
    assert.equal(res.status, 413);
    assert.equal(res.json?.error, 'payload_too_large');
  });

  it('n10 坏 JSON → 400 bad_json（不落箱不崩·禁滑落白名单支伪装 403）', async () => {
    const res = await rawRequest('/internal/v1/notify', { method: 'POST', body: '{not-json' });
    assert.equal(res.status, 400);
    assert.equal(res.json?.error, 'bad_json');
  });
});
