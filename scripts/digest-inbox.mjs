// ── digest-inbox.mjs — p2 首条实证线·schema 映射端（shallow 零 LLM）────────
// 读 inbox（org 层）→ digest-rules.yaml 映射 → wiki/org 落位 + reject 日志。
// 用法：node digest-inbox.mjs [--dry-run]
//   env: TRICOMPANY_HOST_ASSETS（默认 D:\Code\ai\TriMetaverse\TriCompany-copilot-host-assets）
import { readFileSync, writeFileSync, readdirSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import yaml from 'yaml';

const HOST_ASSETS = process.env.TRICOMPANY_HOST_ASSETS
  ?? 'D:\\Code\\ai\\TriMetaverse\\TriCompany-copilot-host-assets';
const DRY_RUN = process.argv.includes('--dry-run');

const rulesPath = join(HOST_ASSETS, 'knowledge', 'org', 'digest-rules.yaml');
const rules = yaml.parse(readFileSync(rulesPath, 'utf-8'));
const inboxDir = join(HOST_ASSETS, rules.inboxRoot ?? 'knowledge/org/inbox');
const logPath = join(HOST_ASSETS, rules.rejectLog ?? 'knowledge/org/digest-reject.log');

function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out = {};
  let key = null;
  for (const line of m[1].split('\n')) {
    if (/^\s+-\s/.test(line) && key) { (out[key] ??= []).push(line.replace(/^\s+-\s*/, '')); continue; }
    const mm = line.match(/^([\w-]+):\s?(.*)$/);
    if (mm) { key = mm[1]; out[key] = mm[2].replace(/^["']|["']$/g, ''); }
  }
  return out;
}

// 阀门：大纲位必填（outlineSlot）缺位 → reject 记日志
const rejects = [];
const accepted = [];

for (const f of readdirSync(inboxDir)) {
  if (!f.endsWith('.md')) continue;
  const text = readFileSync(join(inboxDir, f), 'utf-8');
  const fm = parseFrontmatter(text);
  if (!fm.sourceType) { rejects.push(`${f}: sourceType 缺位`); continue; }
  if (!fm.outlineSlot) { rejects.push(`${f}: 大纲位必填缺位（outlineSlot）`); continue; }
  if (!fm.domain) { rejects.push(`${f}: domain 缺位`); continue; }
  accepted.push({ file: f, fm, body: text.replace(/^---[\s\S]*?---\n*/, '') });
}

// 落位：discipline → 手册（outlineSlot 节追加）；experience → 经验页
let handbook = '';
const handbookPath = join(HOST_ASSETS, rules.targets.disciplineHandbook);
if (existsSync(handbookPath)) handbook = readFileSync(handbookPath, 'utf-8');
let experienceIndex = '';
const expIndexPath = join(HOST_ASSETS, rules.targets.experienceIndex);
if (existsSync(expIndexPath)) experienceIndex = readFileSync(expIndexPath, 'utf-8');

const dryNote = DRY_RUN ? '（dry-run 未写盘）' : '';
for (const { file, fm, body } of accepted) {
  const rel = rules.inboxRoot + '/' + file;
  if (fm.sourceType === 'discipline') {
    const slot = fm.outlineSlot;
    const re = new RegExp(`(## ${slot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n)`);
    if (re.test(handbook)) {
      handbook = handbook.replace(re, `$1- ${fm.title}（来源：${rel}）\n`);
    } else {
      handbook += `\n## ${slot}\n\n- ${fm.title}（来源：${rel}）\n`;
    }
    console.log(`[digest] discipline → 手册节 ${slot}: ${fm.title} ${dryNote}`);
  } else if (fm.sourceType === 'experience') {
    const pageName = `experience-${fm.domain}.md`;
    const pagePath = join(HOST_ASSETS, rules.targets.experiencePages, pageName);
    let page = existsSync(pagePath) ? readFileSync(pagePath, 'utf-8') : `# 经验库（${fm.domain}）\n`;
    page += `\n## ${fm.title}\n\n${body}\n（来源：${rel}）\n`;
    if (!DRY_RUN) { mkdirSync(dirname(pagePath), { recursive: true }); writeFileSync(pagePath, page, 'utf-8'); }
    experienceIndex += `\n- [${fm.title}](./experiences/${pageName})\n`;
    console.log(`[digest] experience → ${pageName}: ${fm.title} ${dryNote}`);
  }
}

if (!DRY_RUN) {
  mkdirSync(dirname(handbookPath), { recursive: true });
  writeFileSync(handbookPath, handbook, 'utf-8');
  mkdirSync(dirname(expIndexPath), { recursive: true });
  writeFileSync(expIndexPath, experienceIndex, 'utf-8');
  mkdirSync(dirname(logPath), { recursive: true });
  for (const r of rejects) appendFileSync(logPath, `${new Date().toISOString()} REJECT ${r}\n`, 'utf-8');
}

console.log(`[digest] accepted=${accepted.length} rejects=${rejects.length} ${dryNote}`);
