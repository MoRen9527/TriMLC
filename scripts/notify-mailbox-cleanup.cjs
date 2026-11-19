#!/usr/bin/env node
// ── R6 件③ 存量清理脚本（2026-11-20·cto 铸面卷 cdda4386a·BOD 径排·cos R6 终卷 §三）──
//
// 目标：notify-mailbox.json 存量未读件（received_at 超保留窗）一次性 markRead——
// hook 注入面（notify-inject.cjs 降序 20+聚合行）自此只看窗内新件·洪水根治。
//
// 写面纪律（零文件直写）：markRead 走 daemon 端点 POST /internal/v1/notify/mailbox
// ——写收敛 daemon 单进程同步段=原子·与 puller storeLetter/hook 标读零竞争
// （hook 直写文件=多进程读改写竞争族规避·同 hook 件②同形）。
// 统计读数=文件面直读（纯读零竞争·分 target_seat 呈报）。
//
// env：
//   TRILC_INTERNAL_TOKEN        必需（daemon X-Internal-Token 门·缺=拒跑退出 1）
//   TRILC_PORT                  daemon 端口（缺省 8713 现役·hook 同债注）
//   TRILC_NOTIFY_RETENTION_HOURS 保留窗小时（缺省 24）
//   TRILC_NOTIFY_CLEANUP_DRYRUN =1 时只统计零写（dry-run 读数呈报形）
//   TRIMC_NOTIFY_MAILBOX        统计读文件路径（缺省 TriMLC 根现役信箱·daemon 同键）
//
// 幂等可重跑（已读件 markRead=false 计入 already_read·零副作用）。
'use strict';
const fs = require('node:fs');
const http = require('node:http');

const MAILBOX = process.env.TRIMC_NOTIFY_MAILBOX?.trim() || 'D:/Code/ai/TriMLC/notify-mailbox.json';
const PORT = Number(process.env.TRILC_PORT ?? 8713) || 8713;
const TOKEN = process.env.TRILC_INTERNAL_TOKEN?.trim() || '';
const RETENTION_HOURS = Number(process.env.TRILC_NOTIFY_RETENTION_HOURS ?? 24) || 24;
const DRYRUN = process.env.TRILC_NOTIFY_CLEANUP_DRYRUN === '1';
const CONCURRENCY = 10;

if (!TOKEN) {
  console.error('[notify-cleanup] TRILC_INTERNAL_TOKEN 缺失——daemon 门 fail-closed·拒跑（零写面）');
  process.exit(1);
}

// 统计面：文件直读（纯读零竞争）·分席呈报
let doc;
try {
  doc = JSON.parse(fs.readFileSync(MAILBOX, 'utf8'));
} catch (e) {
  console.error('[notify-cleanup] 信箱读取失败 errno=' + (e && e.code ? e.code : 'unknown') + '·拒跑');
  process.exit(1);
}
const letters = (doc && doc.letters) || [];
const cutoff = new Date(Date.now() - RETENTION_HOURS * 3600 * 1000).toISOString();
const staleUnread = letters.filter((l) => l && !l.read && String(l.received_at || '') < cutoff);
const bySeat = {};
for (const l of staleUnread) bySeat[l.target_seat] = (bySeat[l.target_seat] || 0) + 1;

console.log(
  '[notify-cleanup] 窗口=' + RETENTION_HOURS + 'h 截止=' + cutoff +
  ' 全箱=' + letters.length +
  ' 未读=' + letters.filter((l) => l && !l.read).length +
  ' 超窗未读=' + staleUnread.length +
  ' dryrun=' + (DRYRUN ? '1' : '0')
);
for (const seat of Object.keys(bySeat).sort()) {
  console.log('[notify-cleanup]   ' + seat + ': ' + bySeat[seat] + ' 件');
}
if (DRYRUN || staleUnread.length === 0) {
  console.log('[notify-cleanup] ' + (DRYRUN ? 'dry-run 零写毕' : '零超窗未读·零动作毕'));
  process.exit(0);
}

// 写面：走 daemon 端点（并发 CONCURRENCY 分批·幂等可重跑）
const markRead = (messageId) => new Promise((resolve) => {
  const payload = JSON.stringify({ message_id: messageId });
  const req = http.request(
    {
      host: '127.0.0.1',
      port: PORT,
      path: '/internal/v1/notify/mailbox',
      method: 'POST',
      agent: false,
      timeout: 3000,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        'x-internal-token': TOKEN,
      },
    },
    (res) => {
      res.resume();
      // 200=本轮标读成功；404=件已读态/不在箱（幂等重跑形·清理目标已达成）——两者皆计 ok
      res.on('end', () => { req.destroy(); resolve(res.statusCode === 200 || res.statusCode === 404); });
    },
  );
  req.on('timeout', () => { req.destroy(); resolve(false); });
  req.on('error', () => resolve(false));
  req.end(payload);
});

(async () => {
  let okCount = 0;
  let failCount = 0;
  const ids = staleUnread.map((l) => String(l.message_id));
  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const slice = ids.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(slice.map(markRead));
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value === true) okCount += 1;
      else failCount += 1;
    }
    process.stdout.write('[notify-cleanup] 进度 ' + Math.min(i + CONCURRENCY, ids.length) + '/' + ids.length + '\r');
  }
  process.stdout.write('\n');
  console.log('[notify-cleanup] 毕：markRead ok=' + okCount + ' 失败=' + failCount +
    '（失败件=下轮重跑幂等·daemon 侧 404 形已读态亦计 ok 前置已销账）');
  process.exitCode = failCount > 0 && okCount === 0 ? 1 : 0;
})();
