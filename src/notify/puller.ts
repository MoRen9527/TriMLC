// ── TriMLC Notify Puller（LG-036 收端外拨拉取；方案 acaae9fc §一「mc_link 顺路」
// 同族外拨形态——独立低频 interval，mirror pusher 零耦合）──
//
// 流程：GET sg /internal/v1/Inter-token）→ 逐件 letter-store
// 落箱 → urgent=Windows toast 即时（成功→delivered 确认；失败保持 pending 下轮
// 重投，绝不静默）→ normal=信箱落箱即 delivered（信箱可见=送达达成，CPO 三态
// 精简两级 done=P2）→ confirm 回 sg（forwarded 拉走确认在拉取后即发）。
import { spawn } from 'node:child_process';
import { storeLetter, mailboxSummary, type NotifyLetter } from './letter-store.js';

export interface NotifyPollerOptions {
  /** sg TriMMC base（如 http://sg-ip:8710）。未配置=poller 不启动（零行为）。 */
  sgBaseUrl: string;
  sgToken: string;
  targetSeat: string;
  intervalMs?: number;
  mailboxPath?: string;
  /** toast 注入缝（测试 mock；默认 powershell spawn）。 */
  onToast?: (title: string, body: string) => Promise<boolean>;
  /** confirm 注入缝（测试 mock）。 */
  onConfirm?: (messageId: string, to: 'forwarded' | 'delivered') => Promise<boolean>;
  /** 拉取注入缝（测试 mock）。 */
  onPull?: () => Promise<{ ok: boolean; messages?: Array<Record<string, unknown>> }>;
}

export interface NotifyPollerHandle {
  stop: () => void;
  /** 手动触发一轮（测试/手动刷新）。 */
  tickOnce: () => Promise<{ pulled: number; delivered: number; failed: number }>;
}

/** Windows toast（零新依赖=powershell WinRT；成功=true）。 */
export async function showWindowsToast(title: string, body: string): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  const esc = (t: string) => t.replace(/'/g, "''");
  const script = [
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
    "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
    "$xml=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
    "$t=$xml.GetElementsByTagName('text')",
    `$t.Item(0).AppendChild($xml.CreateTextNode('${esc(title)}')) | Out-Null`,
    `$t.Item(1).AppendChild($xml.CreateTextNode('${esc(body)}')) | Out-Null`,
    "$appId='{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show([Windows.UI.Notifications.ToastNotification]::new($xml))",
  ].join('; ');
  return new Promise((resolveP) => {
    try {
      const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore', windowsHide: true });
      const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } resolveP(false); }, 15000);
      child.on('close', (code) => { clearTimeout(timer); resolveP(code === 0); });
      child.on('error', () => { clearTimeout(timer); resolveP(false); });
    } catch {
      resolveP(false);
    }
  });
}

async function confirmToSg(sgBaseUrl: string, sgToken: string, messageId: string, to: 'forwarded' | 'delivered'): Promise<boolean> {
  try {
    const res = await fetch(`${sgBaseUrl.replace(/\/$/, '')}/internal/v1/notify/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-token': sgToken },
      body: JSON.stringify({ message_id: messageId, to }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** 启动 poller（TRIMC_NOTIFY_SG_URL 未配置=不启动，零行为变化）。 */
export function startNotifyPoller(opts: NotifyPollerOptions): NotifyPollerHandle {
  const intervalMs = opts.intervalMs ?? 60_000;
  let stopped = false;
  let running = false;

  async function tickOnce(): Promise<{ pulled: number; delivered: number; failed: number }> {
    if (running) return { pulled: 0, delivered: 0, failed: 0 };
    running = true;
    try {
      let raw: { ok: boolean; messages?: Array<Record<string, unknown>> };
      if (opts.onPull) {
        raw = await opts.onPull();
      } else {
        try {
          const res = await fetch(`${opts.sgBaseUrl.replace(/\/$/, '')}/internal/v1/notify/outbox`, {
            headers: { 'x-internal-token': opts.sgToken },
          });
          raw = (await res.json()) as { ok: boolean; messages?: Array<Record<string, unknown>> };
        } catch {
          return { pulled: 0, delivered: 0, failed: 0 }; // 通道不可达=静默下轮（人话态在发端 status 面）
        }
      }
      const messages = Array.isArray(raw.messages) ? raw.messages : [];
      let delivered = 0;
      let failed = 0;
      for (const m of messages) {
        const messageId = String(m.message_id ?? '');
        const urgent = m.urgent === 'urgent' ? 'urgent' as const : 'normal' as const;
        const title = String(m.title ?? '');
        const body = String(m.body ?? '');
        if (!messageId) continue;
        // 拉走确认（forwarded）——先发，失败不阻断落箱（下轮 confirm 幂等重放）
        if (opts.onConfirm) await opts.onConfirm(messageId, 'forwarded');
        else await confirmToSg(opts.sgBaseUrl, opts.sgToken, messageId, 'forwarded');
        // 落箱（幂等）
        const letter = {
          message_id: messageId,
          source_seat: String(m.source_seat ?? ''),
          target_seat: String(m.target_seat ?? opts.targetSeat),
          urgent,
          title,
          body,
          delivery: (urgent === 'urgent' ? 'toast' : 'mailbox') as NotifyLetter['delivery'],
        };
        const { stored } = storeLetter(letter, opts.mailboxPath);
        // 最后一跳（方案 A）
        let deliveredOk = true;
        if (urgent === 'urgent') {
          deliveredOk = opts.onToast ? await opts.onToast(title, body) : await showWindowsToast(title, body);
        }
        if (deliveredOk) {
          delivered += 1;
          if (opts.onConfirm) await opts.onConfirm(messageId, 'delivered');
          else await confirmToSg(opts.sgBaseUrl, opts.sgToken, messageId, 'delivered');
        } else {
          failed += 1; // urgent toast 失败：保持 pending→下轮重投（绝不静默）
        }
        void stored;
      }
      return { pulled: messages.length, delivered, failed };
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => { if (!stopped) void tickOnce(); }, intervalMs);
  // 不持句柄保活（daemon 生命周期管理；watchdog 体系外零新进程面）
  if (typeof timer === 'object' && 'unref' in timer) (timer as { unref: () => void }).unref();

  return {
    stop: () => { stopped = true; clearInterval(timer); },
    tickOnce,
  };
}

/** 信箱可见面汇总（GET 端点用）。 */
export function mailboxVisible(pathOverride?: string) {
  return mailboxSummary(pathOverride);
}
