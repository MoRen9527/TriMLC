// ── LG-036 STE gate: 跨面通知通道 端B（TriMLC 收端）独立复验 ──
// 独立于 FSD notify.test.ts：本件按 STE 五点门禁族实例化——
// ⑤末跳方案 A 语义独立复验（urgent toast-fail 保持 pending 重投/normal 落箱即送达/
// confirm 回路 forward+delivered 双跳）+ 零行为默认关（sgBaseUrl 空）+ 信箱可见面。
// 全程 mock 注入缝（onPull/onToast/onConfirm），零真实外呼零真实 toast。
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startNotifyPoller } from '../src/notify/puller.js';
import { mailboxSummary, MAILBOX_FILE_ENV } from '../src/notify/letter-store.js';

describe('LG-036 STE gate: TriMLC notify 端B', () => {
  const dirs: string[] = [];
  let savedMailboxEnv: string | undefined;
  let mailboxPath: string;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'ste-mlc-notify-'));
    dirs.push(dir);
    mailboxPath = join(dir, 'mailbox.json');
    savedMailboxEnv = process.env[MAILBOX_FILE_ENV];
    process.env[MAILBOX_FILE_ENV] = mailboxPath;
  });

  after(() => {
    if (savedMailboxEnv === undefined) delete process.env[MAILBOX_FILE_ENV];
    else process.env[MAILBOX_FILE_ENV] = savedMailboxEnv;
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  const msg = (id: string, urgent: string) => ({
    message_id: id, source_seat: 'm-duty-cos', target_daemon: 'trimlc', target_seat: 'bod',
    urgent, title: `STE-${id}`, body: `body-${id}`,
  });

  it('⑤方案 A：urgent toast 失败 → 保持 pending 重投（delivered 计 0/failed 计 1/信箱无件）', async () => {
    const confirmed: Array<[string, string]> = [];
    const handle = startNotifyPoller({
      sgBaseUrl: 'http://127.0.0.1:0', sgToken: 'ste', targetSeat: 'bod',
      intervalMs: 3_600_000, mailboxPath,
      onPull: async () => ({ ok: true, messages: [msg('ste-u1', 'urgent')] }),
      onToast: async () => false, // toast 注入失败（第四型：末跳不可达模拟）
      onConfirm: async (id, to) => { confirmed.push([id, to]); return true; },
    });
    const r = await handle.tickOnce();
    handle.stop();
    assert.deepEqual(r, { pulled: 1, delivered: 0, failed: 1 }, 'urgent toast 失败=failed 不静默');
    assert.deepEqual(confirmed, [['ste-u1', 'forwarded']], '仅 forward 确认（delivered 未发=保持 pending 重投语义）');
    const mb = mailboxSummary(mailboxPath);
    assert.equal(mb.total, 1, '信箱有件（先落箱后 toast，重投不重复落箱）');
    assert.equal(mb.unread, 1);
  });

  it('⑤方案 A：normal → 落箱即送达（零 toast 依赖）+ confirm 双跳', async () => {
    const confirmed: Array<[string, string]> = [];
    const toasts: string[] = [];
    const handle = startNotifyPoller({
      sgBaseUrl: 'http://127.0.0.1:0', sgToken: 'ste', targetSeat: 'bod',
      intervalMs: 3_600_000, mailboxPath,
      onPull: async () => ({ ok: true, messages: [msg('ste-n1', 'normal')] }),
      onToast: async (t) => { toasts.push(t); return true; },
      onConfirm: async (id, to) => { confirmed.push([id, to]); return true; },
    });
    const r = await handle.tickOnce();
    handle.stop();
    assert.deepEqual(r, { pulled: 1, delivered: 1, failed: 0 }, 'normal 落箱即送达');
    assert.deepEqual(confirmed, [['ste-n1', 'forwarded'], ['ste-n1', 'delivered']], 'confirm 回路双跳');
    assert.equal(toasts.length, 0, 'normal 不触发 toast');
    const mb = mailboxSummary(mailboxPath);
    assert.equal(mb.unread, 1, '信箱可见面 unread=1');
  });

  it('⑤零行为默认关：sgBaseUrl 未配置 → fetch 不可达静默下轮（零拉取零落箱不 throw）', async () => {
    // 接口契约「未配置=poller 不启动」的守卫在装配层（调用面）；
    // 本件验 poller 层：空 base URL 时 tickOnce 走 fetch 分支→不可达=静默返回零。
    const handle = startNotifyPoller({
      sgBaseUrl: '', sgToken: 'ste', targetSeat: 'bod',
      intervalMs: 3_600_000, mailboxPath,
      onConfirm: async () => true,
    });
    const r = await handle.tickOnce();
    handle.stop();
    assert.deepEqual(r, { pulled: 0, delivered: 0, failed: 0 }, 'fetch 不可达=静默下轮（人话态在发端 status 面）');
    const mb = mailboxSummary(mailboxPath);
    assert.equal(mb.total, 0, '信箱零写入');
  });

  it('⑤urgent toast 成功 → delivered 计 1（正路对照）', async () => {
    const handle = startNotifyPoller({
      sgBaseUrl: 'http://127.0.0.1:0', sgToken: 'ste', targetSeat: 'bod',
      intervalMs: 3_600_000, mailboxPath,
      onPull: async () => ({ ok: true, messages: [msg('ste-u2', 'urgent')] }),
      onToast: async () => true,
      onConfirm: async () => true,
    });
    const r = await handle.tickOnce();
    handle.stop();
    assert.deepEqual(r, { pulled: 1, delivered: 1, failed: 0 }, 'urgent toast 成功=delivered');
  });
});
