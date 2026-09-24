// ── LG-036 收端测试（TriMLC letter-store+puller；方案 acaae9fc）──
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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

// ── LG-052 阶段一：名册化收端回归（13 席扩面）──
describe('notify puller 名册回归（LG-052 双名并入）', () => {
  const dirs: string[] = [];
  after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
  const SEATS_FIXTURE = {
    seats: [
      { seat: 'full-stack-developer', opsName: 'm-fsd' },
      { seat: 'chief-technology-officer', opsName: 'm-cto' },
      { seat: 'ceo-chief-of-staff', opsName: 'm-cos' },
      { seat: 'board', opsName: 'board' },
    ],
  };

  function withSeatsFile(): string {
    const dir = mkdtempSync(join(tmpdir(), 'trimlc-roster-'));
    dirs.push(dir);
    const seatsPath = join(dir, 'seats.json');
    writeFileSync(seatsPath, JSON.stringify(SEATS_FIXTURE), 'utf-8');
    process.env.TRIMC_NOTIFY_SEATS_FILE = seatsPath;
    return seatsPath;
  }

  it('opsName 正名件入册收递：target_seat=m-fsd 落箱+双 confirm', async () => {
    const seatsPath = withSeatsFile();
    const mailbox = join(dirs[dirs.length - 1], 'notify-mailbox.json');
    const confirms: Array<[string, string]> = [];
    const handle = startNotifyPoller({
      sgBaseUrl: 'http://sg.example', sgToken: 'tok', targetSeat: 'bod', mailboxPath: mailbox,
      onPull: async () => ({ ok: true, messages: [{ message_id: 'bc-1--m-fsd', source_seat: 'bod', target_seat: 'm-fsd', urgent: 'normal', title: '广播件', body: '全员' }] }),
      onConfirm: async (id, to) => { confirms.push([id, to]); return true; },
    });
    const r = await handle.tickOnce();
    handle.stop();
    delete process.env.TRIMC_NOTIFY_SEATS_FILE;
    assert.deepEqual(r, { pulled: 1, delivered: 1, failed: 0 });
    assert.deepEqual(confirms, [['bc-1--m-fsd', 'forwarded'], ['bc-1--m-fsd', 'delivered']]);
    assert.equal(mailboxSummary(mailbox).total, 1);
    void seatsPath;
  });

  it('FIXED_ROUTE 一致性：bod/coo 短名恒可达（无 seats 文件时回退单值语义不破）', async () => {
    delete process.env.TRIMC_NOTIFY_SEATS_FILE; // 无名册=回退 targetSeat 单值（现行为）
    const mailbox = join((dirs[dirs.length - 1] ?? mkdtempSync(join(tmpdir(), 'trimlc-fr-'))), 'notify-mailbox.json');
    dirs.push(mailbox.slice(0, mailbox.lastIndexOf('\\')) || mailbox.slice(0, mailbox.lastIndexOf('/')));
    const handle = startNotifyPoller({
      sgBaseUrl: 'http://sg.example', sgToken: 'tok', targetSeat: 'bod', mailboxPath: mailbox,
      onPull: async () => ({ ok: true, messages: [{ message_id: 'fr-bod', source_seat: 'm-duty-cos', target_seat: 'bod', urgent: 'normal', title: 't', body: 'b' }] }),
      onConfirm: async () => true,
    });
    const r = await handle.tickOnce();
    handle.stop();
    assert.equal(r.delivered, 1, 'bod 件恒可达（零变化哨兵）');
  });

  it('名册外席件不落箱：target_seat=nobody 跳过（双名并入后仍拒）', async () => {
    withSeatsFile();
    const mailbox = join(dirs[dirs.length - 1], 'notify-mailbox-2.json');
    const handle = startNotifyPoller({
      sgBaseUrl: 'http://sg.example', sgToken: 'tok', targetSeat: 'bod', mailboxPath: mailbox,
      onPull: async () => ({ ok: true, messages: [{ message_id: 'x-1', source_seat: 'bod', target_seat: 'nobody', urgent: 'normal', title: 't', body: 'b' }] }),
      onConfirm: async () => true,
    });
    const r = await handle.tickOnce();
    handle.stop();
    delete process.env.TRIMC_NOTIFY_SEATS_FILE;
    assert.equal(r.pulled, 1);
    assert.equal(r.delivered, 0, '名册外不落箱');
    assert.equal(mailboxSummary(mailbox).total, 0);
  });

  it('幂等重拉：同广播件重出=信箱去重单件（storeLetter duplicate 面）', async () => {
    withSeatsFile();
    const mailbox = join(dirs[dirs.length - 1], 'notify-mailbox-3.json');
    const msg = { message_id: 'bc-2--m-cto', source_seat: 'bod', target_seat: 'm-cto', urgent: 'normal', title: 't', body: 'b' };
    const handle = startNotifyPoller({
      sgBaseUrl: 'http://sg.example', sgToken: 'tok', targetSeat: 'bod', mailboxPath: mailbox,
      onPull: async () => ({ ok: true, messages: [msg, { ...msg }] }), // 同件重出（确认前 replay）
      onConfirm: async () => true,
    });
    const r = await handle.tickOnce();
    handle.stop();
    delete process.env.TRIMC_NOTIFY_SEATS_FILE;
    assert.equal(r.delivered, 2, '拉取面两次到件');
    assert.equal(mailboxSummary(mailbox).total, 1, '信箱幂等单件');
  });
});
