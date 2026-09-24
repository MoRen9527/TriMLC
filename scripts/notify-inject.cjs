#!/usr/bin/env node
// ── LG-052 单智能收信 hook（UserPromptSubmit 注入面）──
//
// 席位身份=会话 cwd 推导（BOD 预裁 2026-09-24 单智能 hook 路线）：
//   D:/Code/ai/TriMetaverse-worktrees/<seat>/  → seats.json seat==<seat> → opsName 正名过滤
//   D:/Code/ai/TriMetaverse/（主树）           → 'bod'（现行为零变化）
//   其他目录                                    → 不注入（非本仓会话降噪）
// 读共享信箱 TriMLC/notify-mailbox.json，过滤 target_seat==席位正名且未读，
// 打印 [M-SG NOTIFY] 行（与 MVP hook 输出形一致）。任何异常=静默零输出
//（hook 不阻断会话）。12 席配置位=本脚本单点+映射表（无逐席 settings 编辑；
// 未切换 worktree 的席位随切换自动生效，letters 已先行落箱 delivered 态）。
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const MAIN_ROOT = 'D:/Code/ai/TriMetaverse';
const WT_ROOT = 'D:/Code/ai/TriMetaverse-worktrees';
// 信箱路径对齐 letter-store.MAILBOX_FILE_ENV 语义（env 缺省=TriMLC 根现役信箱）
const MAILBOX = process.env.TRIMC_NOTIFY_MAILBOX?.trim() || 'D:/Code/ai/TriMLC/notify-mailbox.json';

try {
  const norm = process.cwd().replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
  let seatFilter = null;
  if (norm === WT_ROOT.toLowerCase() || norm.startsWith(WT_ROOT.toLowerCase() + '/')) {
    const dirName = norm.slice(WT_ROOT.length + 1).split('/')[0] || '';
    if (dirName) {
      const seats = JSON.parse(fs.readFileSync(path.join(MAIN_ROOT, '.claude', 'seats.json'), 'utf8'));
      const hit = (seats.seats || []).find((s) => s && s.seat === dirName);
      if (hit && hit.opsName) seatFilter = hit.opsName;
    }
  } else if (norm === MAIN_ROOT.toLowerCase() || norm.startsWith(MAIN_ROOT.toLowerCase() + '/')) {
    seatFilter = 'bod';
  } else {
    process.exit(0); // 非本仓会话不注入
  }
  if (!seatFilter) process.exit(0); // worktree 席不在册=防御性静默

  const mailbox = JSON.parse(fs.readFileSync(MAILBOX, 'utf8'));
  const letters = (mailbox.letters || []).filter((l) => l && l.target_seat === seatFilter && !l.read);
  for (const l of letters) {
    console.log('[M-SG NOTIFY] ' + String(l.title || '') + ' | ' + String(l.body || '').slice(0, 200));
  }
} catch {
  /* 静默：信箱缺失/坏文件/hook 异常均不阻断会话 */
}
