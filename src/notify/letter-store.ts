// ── TriMLC Notify Letter Store（LG-036 收端；方案 acaae9fc；LG-026 信箱族）──
//
// bod 信箱：收到的通知落盘（会话内存语义外的可见面——「信箱必须可见」GET 计数
// 端点配套）；送达三态的收端段：forwarded（拉走落箱）→delivered（toast 已弹/
// 信箱写入成功）。JSON 原子落盘（tmp+rename，仓内 store 同族）。
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface NotifyLetter {
  message_id: string;
  source_seat: string;
  target_seat: string;
  urgent: 'urgent' | 'normal';
  title: string;
  body: string;
  /** Q2 反向通道（2026-10-15）：回声拉取件=advisory 标（服务端强制打·见 app.ts
   *  SOURCE_SEAT_WHITELIST 段）——收推≠执行（CPO 红线③）：带标信=纯待阅数据，
   *  对本地域无任何可触发执行的路由面。现役席信不带此字段（undefined·零行为变化）。 */
  advisory?: boolean;
  received_at: string;
  delivery: 'toast' | 'mailbox';
  delivered_at: string;
  read: boolean;
}

export interface MailboxDoc {
  letters: NotifyLetter[];
}

export const MAILBOX_FILE_ENV = 'TRIMC_NOTIFY_MAILBOX';

export function mailboxPath(): string {
  const env = process.env[MAILBOX_FILE_ENV]?.trim();
  if (env) return resolve(env);
  return resolve(process.cwd(), 'notify-mailbox.json');
}

function readDoc(path: string): MailboxDoc {
  if (!existsSync(path)) return { letters: [] };
  try {
    const doc = JSON.parse(readFileSync(path, 'utf-8')) as MailboxDoc;
    if (!doc || !Array.isArray(doc.letters)) return { letters: [] };
    return doc;
  } catch {
    return { letters: [] };
  }
}

function writeDocAtomic(path: string, doc: MailboxDoc): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf-8');
  renameSync(tmp, path);
}

/** 落箱（幂等=message_id 去重；同 id 重复拉取不重投）。返回是否新落+cap 裁剪读数。 */
export function storeLetter(
  letter: Omit<NotifyLetter, 'received_at' | 'delivery' | 'delivered_at' | 'read'> & { delivery: 'toast' | 'mailbox' },
  pathOverride?: string,
  now: Date = new Date(),
): { stored: boolean; duplicate: boolean; trimmed: number; archived: number } {
  const path = pathOverride ?? mailboxPath();
  const doc = readDoc(path);
  if (doc.letters.some((l) => l.message_id === letter.message_id)) {
    return { stored: false, duplicate: true, trimmed: 0, archived: 0 };
  }
  doc.letters.push({
    ...letter,
    received_at: now.toISOString(),
    delivery: letter.delivery,
    delivered_at: now.toISOString(),
    read: false,
  });
  writeDocAtomic(path, doc);
  const cap = applyMailboxCap(path);
  return { stored: true, duplicate: false, trimmed: cap.trimmed, archived: cap.archived };
}

/** R6 件③（2026-11-20·cto 铸面卷 cdda4386a）：信箱 FIFO 轮转 cap——落箱后超限裁
 *  最旧（received_at 升序）至 MAILBOX_CAP；被裁件先 append 归档再裁（数据保全优先：
 *  归档写失败=零裁剪零删·cap 延后如实）。返回裁剪/归档读数。 */
export const MAILBOX_CAP = 500;

export function applyMailboxCap(pathOverride?: string): { trimmed: number; archived: number } {
  const path = pathOverride ?? mailboxPath();
  const doc = readDoc(path);
  if (doc.letters.length <= MAILBOX_CAP) return { trimmed: 0, archived: 0 };
  const sorted = [...doc.letters].sort((a, b) => String(a.received_at).localeCompare(String(b.received_at)));
  const cutCount = sorted.length - MAILBOX_CAP;
  const evicted = sorted.slice(0, cutCount);
  const archivePath = /\.json$/.test(path) ? path.replace(/\.json$/, '-archive.jsonl') : `${path}.archive.jsonl`;
  try {
    appendFileSync(
      archivePath,
      evicted.map((l) => JSON.stringify(l)).join('\n') + '\n',
      'utf-8',
    );
  } catch {
    return { trimmed: 0, archived: 0 }; // 归档失败=零裁剪（信箱数据零丢失·cap 延后）
  }
  const evictedIds = new Set(evicted.map((l) => l.message_id));
  doc.letters = doc.letters.filter((l) => !evictedIds.has(l.message_id));
  writeDocAtomic(path, doc);
  return { trimmed: evicted.length, archived: evicted.length };
}

/** 信箱可见面（GET 计数端点配套）：未读数+全列摘要。 */
export function mailboxSummary(pathOverride?: string): { unread: number; total: number; letters: Array<{ message_id: string; urgent: string; title: string; delivery: string; received_at: string; read: boolean }> } {
  const doc = readDoc(pathOverride ?? mailboxPath());
  return {
    unread: doc.letters.filter((l) => !l.read).length,
    total: doc.letters.length,
    letters: doc.letters.map((l) => ({
      message_id: l.message_id,
      urgent: l.urgent,
      title: l.title,
      delivery: l.delivery,
      received_at: l.received_at,
      read: l.read,
    })),
  };
}

/** 标已读（bod 消费后；P2 read 回执的前置位）。 */
export function markRead(messageId: string, pathOverride?: string): boolean {
  const path = pathOverride ?? mailboxPath();
  const doc = readDoc(path);
  const l = doc.letters.find((x) => x.message_id === messageId);
  if (!l || l.read) return false;
  l.read = true;
  writeDocAtomic(path, doc);
  return true;
}
