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
//
// ── R6 修复件①②（2026-11-20·cto 铸面卷 cdda4386a·BOD 径排·cos R6 终卷 §三）──
// 三重奏根因（5110 件堆积/全量无上限/183KB 预算截断吞没新件）修复：
//   件① 降序取最新 N 条（TRILC_NOTIFY_INJECT_LIMIT env·缺省 20）+行内截断 200
//        保持现形——新件可达性优先（旧件数组头部耗尽预算·尾部新件被吞家族消解）；
//        其余未读聚合一行计数「另有 N 件历史未读（清理候令）」。
//   件② 注入即标读：注入件逐件 POST /internal/v1/notify/mailbox {message_id}
//        （写面收敛 daemon 单进程同步段=原子·hook 侧零直写——多进程读改写竞争族规避）；
//        token=TRILC_INTERNAL_TOKEN env·缺→静默跳过（降级=件①主修不受影响）；
//        失败静默（下回合同件重注入·幂等代价可容·cto 卷原义）。
//   件③ 存量清理=scripts/notify-mailbox-cleanup.cjs + letter-store cap500（另件）。
// 债注（R6-b 同款）：daemon TRILC_PORT 由启动器私有 env 面供（user/machine env 双空
// 实勘 2026-11-20）——hook env 链不可达→缺省写现役 8713；port 变更属部署面变更，
// 届时同步本缺省或设 TRILC_PORT env（毕报载明候 CTO 勘修窗裁量）。
'use strict';
// ── 平台早退（bod-copilot 收信链·CTO 复核 2026-11-27：注册件=本机 Windows 专用形——
//    cmd /c+D:/ 路径在 Linux Copilot 会话必败；注入器层 platform 早退=非 Windows 零输出零副作用，
//    不在非本机面制造怪态。Linux 面命令级 spawn 失败语义（是否阻断 prompt）候验·低概率场景。）
if (process.platform !== 'win32') process.exit(0);
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const MAIN_ROOT = 'D:/Code/ai/TriMetaverse';
const WT_ROOT = 'D:/Code/ai/TriMetaverse-worktrees';
// 信箱路径对齐 letter-store.MAILBOX_FILE_ENV 语义（env 缺省=TriMLC 根现役信箱）
const MAILBOX = process.env.TRIMC_NOTIFY_MAILBOX?.trim() || 'D:/Code/ai/TriMLC/notify-mailbox.json';
const INJECT_LIMIT = Math.max(1, Number(process.env.TRILC_NOTIFY_INJECT_LIMIT ?? 20) || 20);
const PORT = Number(process.env.TRILC_PORT ?? 8713) || 8713;
const TOKEN = process.env.TRILC_INTERNAL_TOKEN?.trim() || '';

let unread = [];
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
  unread = (mailbox.letters || [])
    .filter((l) => l && l.target_seat === seatFilter && !l.read)
    .sort((a, b) => String(b.received_at || '').localeCompare(String(a.received_at || ''))); // 件①降序
} catch {
  process.exit(0); /* 静默：信箱缺失/坏文件/hook 异常均不阻断会话 */
}

const batch = unread.slice(0, INJECT_LIMIT);
const restCount = unread.length - batch.length;
// ── 宿主输出分支（bod-copilot 收信链·CEO 令 2026-11-27 23:14·CTO 派工件②）──
// 缺省 'cc'=逐行 [M-SG NOTIFY]（CC UserPromptSubmit stdout 契约·现形零变化）；
// NOTIFY_HOOK_OUTPUT=copilot → 单行 JSON **{"additionalContext":"<同信文>"}**（Copilot CLI hook 契约）。
//   2026-11-28 CTO 实测勘正：Copilot CLI（@github/copilot 1.0.51 app.js）把钩子 stdout 先 JSON.parse，
//   userPromptSubmitted 只消费 additionalContext／modifiedPrompt／suppressOutput／handled／responseContent
//   五键——此前输出的 {"systemMessage":…} 不在消费集=静默丢弃（三红实锚：copilot「无系统消息」）。
//   临时项目活体实证：{"additionalContext":"MARKER-ZQ7…"} → 模型复述 ZQ7 ✓。
//   另一前置：.github/hooks/ 仓库钩子仅在文件夹受信（trustedFolders）时加载（提示模式=开关
//   GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS=true 或已受信）——实测开关关=NONE。
// 判宿主=显式 env（勿用 env 探测隐式分叉）；同信箱·同批纯文本信·零信内容改动·仅包装形。
// 嵌套转义=JSON.stringify（禁手拼——信文含引号/换行面）。
const HOOK_OUTPUT = (process.env.NOTIFY_HOOK_OUTPUT || '').trim().toLowerCase();
const lines = [];
for (const l of batch) {
  lines.push('[M-SG NOTIFY] ' + String(l.title || '') + ' | ' + String(l.body || '').slice(0, 200));
}
if (restCount > 0) {
  lines.push('[M-SG NOTIFY] …另有 ' + restCount + ' 件历史未读（清理候令）');
}
if (HOOK_OUTPUT === 'copilot') {
  console.log(JSON.stringify({ additionalContext: lines.join('\n') }));
} else {
  for (const line of lines) console.log(line);
}

// 件②注入即标读：stdout 输出后并行 POST（daemon 单进程端点=写原子）；agent:false+
// resolve 即 destroy=事件循环排空后进程自然退出（stdout flush 完整·零 exit 截断）。
if (batch.length > 0 && TOKEN) {
  const markRead = (messageId) => new Promise((resolve) => {
    const payload = JSON.stringify({ message_id: messageId });
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: '/internal/v1/notify/mailbox',
        method: 'POST',
        agent: false,
        timeout: 1500,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          'x-internal-token': TOKEN,
        },
      },
      (res) => {
        // 无 destroy：agent:false 面响应完整收后 socket 自动回收——强断 destroy
        // 会打 daemon 侧 body 循环 ECONNRESET（诊断实锚 2026-11-20·见毕报债段）
        res.resume();
        res.on('end', () => resolve(res.statusCode === 200));
      },
    );
    req.on('timeout', () => { req.destroy(); resolve(false); }); // timeout destroy=主动弃单·daemon 侧 abort 防御随件兜
    req.on('error', () => resolve(false));
    req.end(payload);
  });
  process.exitCode = 0; // 不硬 exit——异步段完成后事件循环自然排空
  Promise.allSettled(batch.map((l) => markRead(String(l.message_id)))).then(() => {});
}
