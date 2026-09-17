// ── TriMLC Notify Letter Store（LG-036 收端；方案 acaae9fc；LG-026 信箱族）──
//
// bod 信箱：收到的通知落盘（会话内存语义外的可见面——「信箱必须可见」GET 计数
// 端点配套）；送达三态的收端段：forwarded（拉走落箱）→delivered（toast 已弹/
// 信箱写入成功）。JSON 原子落盘（tmp+rename，仓内 store 同族）。
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface NotifyLetter {
  message_id: string;
  source_seat: string;
  target_seat: string;
  urgent: 'urgent' | 'normal';
  title: string;
  body: string;
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

/** 落箱（幂等=message_id 去重；同 id 重复拉取不重投）。返回是否新落。 */
export function storeLetter(
  letter: Omit<NotifyLetter, 'received_at' | 'delivery' | 'delivered_at' | 'read'> & { delivery: 'toast' | 'mailbox' },
  pathOverride?: string,
  now: Date = new Date(),
): { stored: boolean; duplicate: boolean } {
  const path = pathOverride ?? mailboxPath();
  const doc = readDoc(path);
  if (doc.letters.some((l) => l.message_id === letter.message_id)) {
    return { stored: false, duplicate: true };
  }
  doc.letters.push({
    ...letter,
    received_at: now.toISOString(),
    delivery: letter.delivery,
    delivered_at: now.toISOString(),
    read: false,
  });
  writeDocAtomic(path, doc);
  return { stored: true, duplicate: false };
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
