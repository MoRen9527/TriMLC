// ── R6 件①②③ 白盒：notify hook/cleanup/mailbox-markRead 端到端（2026-11-20）──
// cto 铸面卷 cdda4386a + cos R6 终卷 §三（BOD 径排·fsd 施工）三件随件白盒：
//   件① hook 降序 20 限额+聚合行（新件可达性·截断吞没家族消解）
//   件② hook 注入即标读（走 daemon 端点·写收敛单进程·token 缺/daemon down 降级钉）
//   件③ letter-store cap500+归档 & cleanup 脚本（dry-run 零写+真跑幂等+分席统计）
// 起服配方对齐 test/server/notify-inbox-endpoint.test.ts 先例（临时数据目录+port 0+
// trimodelApiUrl 死端口+TRIMC_NOTIFY_MAILBOX 钉临时路径）。
// hook/cleanup 以 child_process spawnSync 真跑（fixture 信箱 env 钉路径·主树形 cwd
// 推导 seatFilter='bod'）——端到端含 daemon HTTP markRead 真链路·非 mock。
// 绑 dev 机路径注：hook MAIN_ROOT 硬编码（原形继承）·本测试 cwd 用同路径（本机在）。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTriLCApp } from '../../src/server/app.js';
import { storeLetter, applyMailboxCap } from '../../src/notify/letter-store.js';

// 跑法依赖注：npm test 与 npx tsx --test 均以 TriMLC 包根为 cwd——
// hook 入口路径取 process.cwd()（tsx --test 编译面 import.meta.url 虚拟路径
// MODULE_NOT_FOUND 实锚 2026-11-20·fileURLToPath 形弃用）。
const TEST_ROOT = process.cwd();
const HOOK_PATH = join(TEST_ROOT, 'scripts', 'notify-inject.cjs');
const CLEANUP_PATH = join(TEST_ROOT, 'scripts', 'notify-mailbox-cleanup.cjs');
const MAIN_TREE_CWD = 'D:\\Code\\ai\\TriMetaverse'; // hook 主树形推导（dev 机实路径）
const TEST_TOKEN = 'r6-hook-e2e-token';

type Letter = Record<string, unknown>;
type RunResult = { status: number | null; stdout: string; stderr: string };

function makeLetter(id: string, receivedAt: string, targetSeat = 'bod'): Letter {
  return {
    message_id: id,
    source_seat: 'm-duty-cos',
    target_seat: targetSeat,
    urgent: 'normal',
    title: `t-${id}`,
    body: `b-${id}`,
    received_at: receivedAt,
    delivery: 'mailbox',
    delivered_at: receivedAt,
    read: false,
  };
}

function readMailbox(path: string): Letter[] {
  return (JSON.parse(readFileSync(path, 'utf-8')) as { letters: Letter[] }).letters;
}

function notifyLines(stdout: string): string[] {
  return stdout.split('\n').filter((l) => l.startsWith('[M-SG NOTIFY]'));
}

describe('R6 hook/cleanup 端到端（真起服·child spawnSync）', () => {
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

  /** 子进程 env=白名单最小面（Windows node 起动必需键+overrides）——node --test
   *  runner 子进程注入面（NODE_OPTIONS/loader 遗传·实锚：全 env 透传=hook exit 1）
   *  隔离；'node' 走 PATH（nvm4w shim 面 process.execPath spawnSync ENOENT 规避）。 */
  function childEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
    const BASE = ['PATH', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'COMSPEC', 'TEMP', 'TMP', 'APPDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'windir'];
    const env: Record<string, string> = {};
    for (const k of BASE) if (process.env[k]) env[k] = process.env[k] as string;
    for (const [k, v] of Object.entries(overrides)) if (v !== undefined) env[k] = v;
    return env as NodeJS.ProcessEnv;
  }

  /** 异步 spawn+收 stdout/stderr（**禁 spawnSync**：阻塞父进程事件循环→同进程
   *  daemon 冻结→hook 请求全 timeout 全败+修前 destroy 形 ECONNRESET 打崩 daemon
   *  ——全案失败真因实锚 2026-11-20·异步 spawn 面 daemon 活体照常响应）。 */
  async function runHook(overrides: Record<string, string | undefined>, fixture: string): Promise<RunResult> {
    // 注入面=标读面同文件闭环：daemon markRead handler 调 letter-store.markRead 无
    // pathOverride→mailboxPath() 每请求现读 test 进程 env（daemon 与 test 同进程）——
    // 案级重钉到本案 fixture，与 hook child env 同文件（否则 hook 读 A 标读写 B=两文件错位）。
    process.env.TRIMC_NOTIFY_MAILBOX = fixture;
    // overrides 后展开=案级覆盖优先（h5 死端口 override 曾被 runner TRILC_PORT 缺省
    // 覆盖→hook 实打活体 daemon→「零标读」断言反转——2026-11-20 实锚）
    return runChild('node', [HOOK_PATH], MAIN_TREE_CWD, {
      TRIMC_NOTIFY_MAILBOX: fixture, TRILC_PORT: String(appPort), ...overrides,
    });
  }

  async function runCleanup(overrides: Record<string, string | undefined>, fixture: string): Promise<RunResult> {
    // 同 runHook：cleanup 写面走 daemon 端点（现读 env）——统计面与标读面须同文件。
    process.env.TRIMC_NOTIFY_MAILBOX = fixture;
    return runChild('node', [CLEANUP_PATH], TEST_ROOT, {
      TRIMC_NOTIFY_MAILBOX: fixture, TRILC_PORT: String(appPort), ...overrides,
    });
  }

  async function runChild(cmd: string, args: string[], cwd: string, overrides: Record<string, string | undefined>): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { cwd, env: childEnv(overrides), timeout: 30000 });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d: Buffer) => { stdout += String(d); });
      child.stderr?.on('data', (d: Buffer) => { stderr += String(d); });
      child.on('error', reject);
      child.on('close', (code) => resolve({ status: code, stdout, stderr }));
    });
  }

  before(async () => {
    tmpDataDir = mkdtempSync(join(tmpdir(), 'trilc-notify-hook-'));
    mailboxFile = join(tmpDataDir, 'notify-mailbox.json');
    process.env.TRILC_DATA_DIR = tmpDataDir;
    process.env.TRILC_PORT = '0';
    process.env.TRIMC_NOTIFY_MAILBOX = mailboxFile;
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

  // ── 件①② hook 端到端 ──

  it('h1 20 件未读→20 行注入+零聚合行+注入件全 read:true（标读真链路闭环）', async () => {
    const fixture = join(tmpDataDir, 'h1-mailbox.json');
    const base = Date.parse('2026-11-19T10:00:00Z');
    const letters = Array.from({ length: 20 }, (_, i) =>
      makeLetter(`h1-${String(i).padStart(2, '0')}`, new Date(base + i * 60000).toISOString()));
    writeFileSync(fixture, JSON.stringify({ letters }, null, 2), 'utf-8');

    const r = await runHook({ TRILC_INTERNAL_TOKEN: TEST_TOKEN }, fixture);
    assert.equal(r.status, 0, `hook exit=${r.status} stderr=${r.stderr} stdout=${r.stdout}`);
    const lines = notifyLines(r.stdout ?? '');
    assert.equal(lines.length, 20);
    assert.ok(!lines.some((l) => l.includes('另有')), '零聚合行（恰 20=限额内）');
    const after = readMailbox(fixture);
    assert.ok(after.every((l) => l.read === true), '注入件全部标读（daemon 端点真链路）');
  });

  it('h2 25 件乱序→降序 top20 注入+聚合行「另有 5 件」+最老 5 件保持未读', async () => {
    const fixture = join(tmpDataDir, 'h2-mailbox.json');
    const base = Date.parse('2026-11-19T11:00:00Z');
    // 数组序=插入序乱排·received_at=严格递增（降序判据=received_at 非数组序）
    const order = [7, 3, 21, 0, 15, 11, 24, 5, 18, 2, 9, 13, 20, 1, 16, 8, 23, 4, 19, 10, 14, 6, 22, 12, 17];
    const letters = order.map((i) =>
      makeLetter(`h2-${String(i).padStart(2, '0')}`, new Date(base + i * 60000).toISOString()));
    writeFileSync(fixture, JSON.stringify({ letters }, null, 2), 'utf-8');

    const r = await runHook({ TRILC_INTERNAL_TOKEN: TEST_TOKEN }, fixture);
    assert.equal(r.status, 0);
    const lines = notifyLines(r.stdout ?? '');
    assert.equal(lines.length, 21, '20 注入行+1 聚合行');
    assert.ok(lines[lines.length - 1].includes('另有 5 件'), '聚合行=另有 5 件历史未读');
    // 降序断言：首注入行=最新件（i=24）·第二行=i=23
    assert.ok(lines[0].includes('t-h2-24'), `首行=最新件·得=${lines[0]}`);
    assert.ok(lines[1].includes('t-h2-23'), `次行=次新件·得=${lines[1]}`);
    const after = readMailbox(fixture);
    const readIds = after.filter((l) => l.read).map((l) => String(l.message_id));
    const unreadIds = after.filter((l) => !l.read).map((l) => String(l.message_id));
    assert.equal(readIds.length, 20);
    assert.equal(unreadIds.length, 5);
    // 未读=最老 5 件（received_at 最小序=i 最小的 0..4）
    const unreadMinutes = unreadIds.map((id) => Number(id.slice(3)));
    assert.deepEqual([...unreadMinutes].sort(), [0, 1, 2, 3, 4]);
  });

  it('h3 token 缺→注入照常+零标读（降级形·件①主修不受影响钉）', async () => {
    const fixture = join(tmpDataDir, 'h3-mailbox.json');
    const letters = Array.from({ length: 3 }, (_, i) =>
      makeLetter(`h3-${i}`, new Date(Date.parse('2026-11-19T12:00:00Z') + i * 60000).toISOString()));
    writeFileSync(fixture, JSON.stringify({ letters }, null, 2), 'utf-8');

    const r = await runHook({ TRILC_INTERNAL_TOKEN: undefined }, fixture);
    assert.equal(r.status, 0);
    assert.equal(notifyLines(r.stdout ?? '').length, 3, '注入照常');
    const after = readMailbox(fixture);
    assert.ok(after.every((l) => l.read === false), 'token 缺=零标读（降级如实）');
  });

  it('h4 错 token→注入照常+零标读（daemon 门拒·降级同形）', async () => {
    const fixture = join(tmpDataDir, 'h4-mailbox.json');
    const letters = [makeLetter('h4-0', '2026-11-19T13:00:00Z')];
    writeFileSync(fixture, JSON.stringify({ letters }, null, 2), 'utf-8');

    const r = await runHook({ TRILC_INTERNAL_TOKEN: 'wrong-token' }, fixture);
    assert.equal(r.status, 0);
    assert.equal(notifyLines(r.stdout ?? '').length, 1);
    assert.equal(readMailbox(fixture)[0].read, false);
  });

  it('h5 daemon down（死端口）→注入照常+零标读（连接拒降级钉）', async () => {
    const fixture = join(tmpDataDir, 'h5-mailbox.json');
    const letters = [makeLetter('h5-0', '2026-11-19T14:00:00Z')];
    writeFileSync(fixture, JSON.stringify({ letters }, null, 2), 'utf-8');

    const r = await runHook({ TRILC_INTERNAL_TOKEN: TEST_TOKEN, TRILC_PORT: '1' }, fixture);
    assert.equal(r.status, 0);
    assert.equal(notifyLines(r.stdout ?? '').length, 1, 'daemon down 注入不阻断');
    assert.equal(readMailbox(fixture)[0].read, false, '零标读');
  });

  it('h6 零未读→零输出零动作', async () => {
    const fixture = join(tmpDataDir, 'h6-mailbox.json');
    const letters = [makeLetter('h6-read', '2026-11-19T15:00:00Z')];
    (letters[0] as Record<string, unknown>).read = true;
    writeFileSync(fixture, JSON.stringify({ letters }, null, 2), 'utf-8');

    const r = await runHook({ TRILC_INTERNAL_TOKEN: TEST_TOKEN }, fixture);
    assert.equal(r.status, 0);
    assert.equal(notifyLines(r.stdout ?? '').length, 0);
  });

  it('h7 多席隔离：m-cos 件不注入不标读（target_seat 过滤原形保持）', async () => {
    const fixture = join(tmpDataDir, 'h7-mailbox.json');
    const letters = [
      makeLetter('h7-bod', '2026-11-19T16:00:00Z', 'bod'),
      makeLetter('h7-cos', '2026-11-19T16:01:00Z', 'm-cos'),
    ];
    writeFileSync(fixture, JSON.stringify({ letters }, null, 2), 'utf-8');

    const r = await runHook({ TRILC_INTERNAL_TOKEN: TEST_TOKEN }, fixture);
    assert.equal(r.status, 0);
    const lines = notifyLines(r.stdout ?? '');
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes('t-h7-bod'));
    const after = readMailbox(fixture);
    assert.equal(after.find((l) => l.message_id === 'h7-bod').read, true);
    assert.equal(after.find((l) => l.message_id === 'h7-cos').read, false, '他席件零触碰');
  });

  it('h8 LIMIT env=3→3 行注入+聚合行「另有 2 件」（限额可调形）', async () => {
    const fixture = join(tmpDataDir, 'h8-mailbox.json');
    const base = Date.parse('2026-11-19T17:00:00Z');
    const letters = Array.from({ length: 5 }, (_, i) =>
      makeLetter(`h8-${i}`, new Date(base + i * 60000).toISOString()));
    writeFileSync(fixture, JSON.stringify({ letters }, null, 2), 'utf-8');

    const r = await runHook({ TRILC_INTERNAL_TOKEN: TEST_TOKEN, TRILC_NOTIFY_INJECT_LIMIT: '3' }, fixture);
    assert.equal(r.status, 0);
    const lines = notifyLines(r.stdout ?? '');
    assert.equal(lines.length, 4, '3 注入+1 聚合');
    assert.ok(lines[3].includes('另有 2 件'));
    const after = readMailbox(fixture);
    assert.equal(after.filter((l) => l.read).length, 3, '只标读注入 3 件');
  });

  it('h9 markRead 端点形：200 标读/重投 404 幂等/未知 id 404（件②消费面端点独立钉）', async () => {
    // 前案 runHook/runCleanup 会改写 test 进程 env（案级重钉族）——本案不经 runner，
    // 防御性重钉回 suite 级 mailboxFile（daemon 端点面 mailboxPath() 现读 env）。
    process.env.TRIMC_NOTIFY_MAILBOX = mailboxFile;
    const fixture = join(tmpDataDir, 'h9-mailbox.json');
    const letters = [makeLetter('h9-0', '2026-11-19T18:00:00Z')];
    writeFileSync(fixture, JSON.stringify({ letters }, null, 2), 'utf-8');
    // daemon 端点读 process.env.TRIMC_NOTIFY_MAILBOX（before 已钉 tmpDataDir 根）——
    // 本案端点面用 daemon 钉定信箱（mailboxFile）落一件再 POST
    storeLetter({
      message_id: 'h9-endpoint', source_seat: 'm-duty-cos', target_seat: 'bod',
      urgent: 'normal', title: 't', body: 'b', delivery: 'mailbox',
    }, mailboxFile);

    const post = (body: string) => new Promise<{ status: number; json: Record<string, unknown> }>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1', port: appPort, path: '/internal/v1/notify/mailbox', method: 'POST',
          headers: { 'x-internal-token': TEST_TOKEN, 'content-type': 'application/json' },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            let json: Record<string, unknown> = {};
            try { json = JSON.parse(Buffer.concat(chunks).toString('utf-8')); } catch { /* keep */ }
            resolve({ status: res.statusCode ?? 0, json });
          });
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    const first = await post(JSON.stringify({ message_id: 'h9-endpoint' }));
    assert.equal(first.status, 200);
    assert.equal(first.json.ok, true);
    assert.equal(readMailbox(mailboxFile).find((l) => l.message_id === 'h9-endpoint').read, true);
    const second = await post(JSON.stringify({ message_id: 'h9-endpoint' }));
    assert.equal(second.status, 404, '已读重投=404（幂等）');
    const unknown = await post(JSON.stringify({ message_id: 'h9-ghost' }));
    assert.equal(unknown.status, 404);
  });

  // ── 件③ cleanup 脚本 ──

  it('c1 dry-run：超窗未读统计输出+零写面（read 全保持 false）', async () => {
    const fixture = join(tmpDataDir, 'c1-mailbox.json');
    const stale = Date.parse('2026-11-18T00:00:00Z'); // >24h 窗外（对现时刻）
    const letters = Array.from({ length: 4 }, (_, i) =>
      makeLetter(`c1-${i}`, new Date(stale + i * 60000).toISOString()));
    writeFileSync(fixture, JSON.stringify({ letters }, null, 2), 'utf-8');

    const r = await runCleanup(
      { TRILC_INTERNAL_TOKEN: TEST_TOKEN, TRILC_NOTIFY_CLEANUP_DRYRUN: '1', TRILC_NOTIFY_RETENTION_HOURS: '24' },
      fixture,
    );
    assert.equal(r.status, 0);
    assert.ok((r.stdout ?? '').includes('超窗未读=4'), `统计行在·得=${r.stdout}`);
    assert.ok(readMailbox(fixture).every((l) => l.read === false), 'dry-run 零写');
  });

  it('c2 真跑：超窗未读全标读+窗内件保持未读+ok 计数输出（幂等可重跑）', async () => {
    const fixture = join(tmpDataDir, 'c2-mailbox.json');
    const stale = Date.parse('2026-11-18T01:00:00Z');
    const fresh = Date.now() - 3600 * 1000; // 1h 前=窗内
    const letters = [
      ...Array.from({ length: 3 }, (_, i) => makeLetter(`c2-stale-${i}`, new Date(stale + i * 60000).toISOString())),
      makeLetter('c2-fresh', new Date(fresh).toISOString()),
    ];
    writeFileSync(fixture, JSON.stringify({ letters }, null, 2), 'utf-8');

    const opts = { TRILC_INTERNAL_TOKEN: TEST_TOKEN, TRILC_NOTIFY_RETENTION_HOURS: '24' };
    const r1 = await runCleanup(opts, fixture);
    assert.equal(r1.status, 0);
    assert.ok((r1.stdout ?? '').includes('markRead ok=3'), `ok 计数·得=${r1.stdout}`);
    let after = readMailbox(fixture);
    assert.equal(after.filter((l) => l.read).length, 3, '超窗 3 件标读');
    assert.equal(after.find((l) => l.message_id === 'c2-fresh').read, false, '窗内件保持未读');

    // 幂等重跑：已读件 404 形=计 ok·零失败零副作用
    const r2 = await runCleanup(opts, fixture);
    assert.equal(r2.status, 0);
    assert.ok((r2.stdout ?? '').includes('超窗未读=0'), '重跑零目标');
    assert.equal(readMailbox(fixture).filter((l) => !l.read).length, 1, '箱面不变');
  });

  it('c3 token 缺→拒跑 exit 1 零写（fail-closed 钉）', async () => {
    const fixture = join(tmpDataDir, 'c3-mailbox.json');
    const letters = [makeLetter('c3-0', '2026-11-18T02:00:00Z')];
    writeFileSync(fixture, JSON.stringify({ letters }, null, 2), 'utf-8');

    const r = await runCleanup({ TRILC_INTERNAL_TOKEN: undefined }, fixture);
    assert.equal(r.status, 1, 'fail-closed 拒跑');
    assert.equal(readMailbox(fixture)[0].read, false, '零写面');
  });
});

// ── 件③ letter-store cap 白盒（直调函数面·fixture 文件构造）──

describe('letter-store cap500+归档（applyMailboxCap·R6 件③）', () => {
  let dir: string;
  let path: string;
  function capFixture(n: number): Letter[] {
    const base = Date.parse('2026-11-19T00:00:00Z');
    return Array.from({ length: n }, (_, i) =>
      makeLetter(`cap-${String(i).padStart(3, '0')}`, new Date(base + i * 60000).toISOString()));
  }
  function writeFixture(letters: Letter[]): string {
    writeFileSync(path, JSON.stringify({ letters }, null, 2), 'utf-8');
    return path;
  }

  it('cap0 500 整不裁：零 trimmed·零 archive 文件', () => {
    dir = mkdtempSync(join(tmpdir(), 'trilc-cap-'));
    path = join(dir, 'mb.json');
    writeFixture(capFixture(500) as Letter[]);
    const r = applyMailboxCap(path);
    assert.deepEqual(r, { trimmed: 0, archived: 0 });
    assert.equal(readMailbox(path).length, 500);
    assert.ok(!existsSync(join(dir, 'mb-archive.jsonl')), '零 archive');
    rmSync(dir, { recursive: true, force: true });
  });

  it('cap1 501→裁最旧 1·archive 1 行全字段·箱 500', () => {
    dir = mkdtempSync(join(tmpdir(), 'trilc-cap-'));
    path = join(dir, 'mb.json');
    writeFixture(capFixture(501) as Letter[]);
    const r = applyMailboxCap(path);
    assert.deepEqual(r, { trimmed: 1, archived: 1 });
    const after = readMailbox(path);
    assert.equal(after.length, 500);
    assert.ok(!after.some((l) => l.message_id === 'cap-000'), '最旧件出箱');
    const archive = readFileSync(join(dir, 'mb-archive.jsonl'), 'utf-8').trim().split('\n');
    assert.equal(archive.length, 1);
    const archived = JSON.parse(archive[0]) as Letter;
    assert.equal(archived.message_id, 'cap-000', '归档=最旧件');
    assert.equal(archived.title, 't-cap-000', '归档全字段保全');
    rmSync(dir, { recursive: true, force: true });
  });

  it('cap2 大超 520→裁 20·剩 500=最新 500·storeLetter 返回值并入 trimmed 读数', () => {
    dir = mkdtempSync(join(tmpdir(), 'trilc-cap-'));
    path = join(dir, 'mb.json');
    writeFixture(capFixture(519) as Letter[]);
    // 519+1 store=520 触发裁 20——storeLetter 返回值面并入
    const r = storeLetter({
      message_id: 'cap-new', source_seat: 'm-duty-cos', target_seat: 'bod',
      urgent: 'normal', title: 't-new', body: 'b', delivery: 'mailbox',
    }, path, new Date(Date.parse('2026-11-19T23:00:00Z')));
    assert.equal(r.stored, true);
    assert.equal(r.trimmed, 20, `裁 20·得=${r.trimmed}`);
    assert.equal(r.archived, 20);
    const after = readMailbox(path);
    assert.equal(after.length, 500);
    assert.ok(after.some((l) => l.message_id === 'cap-new'), '新件在箱');
    assert.ok(!after.some((l) => l.message_id === 'cap-000'), '最旧族出箱');
    const archive = readFileSync(join(dir, 'mb-archive.jsonl'), 'utf-8').trim().split('\n');
    assert.equal(archive.length, 20);
    rmSync(dir, { recursive: true, force: true });
  });

  it('cap3 duplicate 短路零裁副作用', () => {
    dir = mkdtempSync(join(tmpdir(), 'trilc-cap-'));
    path = join(dir, 'mb.json');
    writeFixture(capFixture(501) as Letter[]);
    const r = storeLetter({
      message_id: 'cap-250', source_seat: 'm-duty-cos', target_seat: 'bod',
      urgent: 'normal', title: 'dup', body: 'b', delivery: 'mailbox',
    }, path);
    assert.equal(r.duplicate, true);
    assert.deepEqual({ trimmed: r.trimmed, archived: r.archived }, { trimmed: 0, archived: 0 });
    assert.equal(readMailbox(path).length, 501, '箱面不变');
    rmSync(dir, { recursive: true, force: true });
  });

  it('cap4 归档失败→零裁剪零删（数据保全优先·安全失败钉）', () => {
    dir = mkdtempSync(join(tmpdir(), 'trilc-cap-'));
    path = join(dir, 'mb.json');
    writeFixture(capFixture(501) as Letter[]);
    // archive 路径占名目录→appendFileSync 必炸→零裁剪
    mkdirSync(join(dir, 'mb-archive.jsonl'));
    const r = applyMailboxCap(path);
    assert.deepEqual(r, { trimmed: 0, archived: 0 }, '归档失败=零裁剪');
    assert.equal(readMailbox(path).length, 501, '箱面保全');
    rmSync(dir, { recursive: true, force: true });
  });
});
