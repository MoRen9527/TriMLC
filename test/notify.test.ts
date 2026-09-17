// ── LG-036 收端测试（TriMLC letter-store+puller；方案 acaae9fc）──
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mailboxSummary, storeLetter, markRead, mailboxPath, MAILBOX_FILE_ENV } from '../src/notify/letter-store.js';
import { startNotifyPoller } from '../src/notify/puller.js';

describe('letter-store（TriMLC 信箱）', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'trimlc-mailbox-'));
    path = join(dir, 'notify-mailbox.json');
  });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  it('落箱+幂等（同 message_id 不重投）', () => {
    const r1 = storeLetter({ message_id: 'ntf-1', source_seat: 'm-duty-cos', target_seat: 'bod', urgent: 'normal', title: 't', body: 'b', delivery: 'mailbox' }, path);
    const r2 = storeLetter({ message_id: 'ntf-1', source_seat: 'm-duty-cos', target_seat: 'bod', urgent: 'normal', title: 't', body: 'b', delivery: 'mailbox' }, path);
    assert.equal(r1.stored, true);
    assert.equal(r2.duplicate, true);
    assert.equal(mailboxSummary(path).total, 1);
  });

  it('信箱可见面：unread 计数+markRead', () => {
    storeLetter({ message_id: 'a', source_seat: 'm-duty-cos', target_seat: 'bod', urgent: 'urgent', title: 'ta', body: 'ba', delivery: 'toast' }, path);
    storeLetter({ message_id: 'b', source_seat: 'm-duty-cos', target_seat: 'bod', urgent: 'normal', title: 'tb', body: 'bb', delivery: 'mailbox' }, path);
    const s1 = mailboxSummary(path);
    assert.equal(s1.total, 2);
    assert.equal(s1.unread, 2);
    markRead('a', path);
    assert.equal(mailboxSummary(path).unread, 1);
  });
});

describe('notify poller（收端外拨拉取；mock 注入）', () => {
  let dirs: string[] = [];
  beforeEach(() => { dirs = []; });
  after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
  function freshMailbox(): string {
    const dir = mkdtempSync(join(tmpdir(), 'trimlc-pull-'));
    dirs.push(dir);
    return join(dir, 'notify-mailbox.json');
  }

  const SG_MSG = (id: string, urgent: string) => ({
    message_id: id, source_seat: 'm-duty-cos', target_seat: 'bod', urgent, title: `标题${id}`, body: `正文${id}`,
  });

  it('normal 件：拉取→落箱→confirm forwarded+delivered 全发（信箱即送达）', async () => {
    const mailbox = freshMailbox();
    const confirms: Array<[string, string]> = [];
    const handle = startNotifyPoller({
      sgBaseUrl: 'http://sg.example', sgToken: 'tok', targetSeat: 'bod', mailboxPath: mailbox,
      onPull: async () => ({ ok: true, messages: [SG_MSG('n1', 'normal')] }),
      onConfirm: async (id, to) => { confirms.push([id, to]); return true; },
    });
    const r = await handle.tickOnce();
    handle.stop();
    assert.deepEqual(r, { pulled: 1, delivered: 1, failed: 0 });
    assert.deepEqual(confirms, [['n1', 'forwarded'], ['n1', 'delivered']]);
    assert.equal(mailboxSummary(mailbox).total, 1);
  });

  it('urgent 件：toast 成功→delivered；toast 失败→不 confirm delivered（绝不静默）', async () => {
    const mailbox = freshMailbox();
    const confirms: Array<[string, string]> = [];
    const toastArgv: string[] = [];
    const failing = startNotifyPoller({
      sgBaseUrl: 'http://sg.example', sgToken: 'tok', targetSeat: 'bod', mailboxPath: mailbox,
      onPull: async () => ({ ok: true, messages: [SG_MSG('u1', 'urgent')] }),
      onConfirm: async (id, to) => { confirms.push([id, to]); return true; },
      onToast: async (_t, _b) => { toastArgv.push('toast-attempt'); return false; },
    });
    const rFail = await failing.tickOnce();
    failing.stop();
    assert.equal(rFail.failed, 1, 'toast 失败计 failed');
    assert.equal(confirms.filter(([to]) => to === 'delivered').length, 0, '失败不 confirm delivered');
    // 成功路径
    const okHandle = startNotifyPoller({
      sgBaseUrl: 'http://sg.example', sgToken: 'tok', targetSeat: 'bod', mailboxPath: mailbox,
      onPull: async () => ({ ok: true, messages: [SG_MSG('u2', 'urgent')] }),
      onConfirm: async (id, to) => { confirms.push([id, to]); return true; },
      onToast: async () => { toastArgv.push('toast-ok'); return true; },
    });
    const rOk = await okHandle.tickOnce();
    okHandle.stop();
    assert.equal(rOk.delivered, 1);
    assert.ok(toastArgv.length >= 2, 'toast 尝试两次在卷');
  });

  it('凭据痕迹：poller 网络面零密钥落盘（信箱文件扫描零 token）+门禁文件不入箱', async () => {
    const mailbox = freshMailbox();
    const handle = startNotifyPoller({
      sgBaseUrl: 'http://sg.example', sgToken: 'sg-secret-token-xyz', targetSeat: 'bod', mailboxPath: mailbox,
      onPull: async () => ({ ok: true, messages: [SG_MSG('n9', 'normal')] }),
      onConfirm: async () => true,
    });
    await handle.tickOnce();
    handle.stop();
    const text = readFileSync(mailbox, 'utf-8');
    assert.equal(text.includes('sg-secret-token'), false, 'sg token 零落盘');
    assert.equal(text.includes('http://sg.example'), false, 'sg 地址零落盘');
    const extra = readdirSync(dirs[dirs.length - 1]).filter((f) => !f.startsWith('notify-mailbox'));
    assert.equal(extra.length, 0, '零附加文件');
  });
});
