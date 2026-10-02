import { renderTemplate, type TemplateData } from "./templates";

/**
 * Queue dispatcher. Claims due rows (SKIP LOCKED, leased), renders, sends through a channel adapter and
 * records the outcome with retry/backoff/dead-letter handled by the database. Nothing here runs on a UI
 * render path: it is invoked by the cron route only. Idempotent sends: Resend receives the notification id
 * as its Idempotency-Key, so a crash between "sent" and "recorded" cannot double-send.
 */
export interface QueuedNotification {
  id: string;
  channel: "email" | "sms" | "whatsapp";
  template: string;
  recipient: string;
  data: TemplateData;
  attempts: number;
}

export type SendResult =
  { ok: true; messageId: string } | { ok: false; error: string; permanent: boolean };

export interface NotificationDb {
  claim(limit: number, leaseSeconds: number): Promise<QueuedNotification[]>;
  complete(id: string, r: SendResult): Promise<void>;
}

export interface ChannelAdapters {
  email?: (m: {
    id: string;
    to: string;
    subject: string;
    html: string;
    text: string;
  }) => Promise<SendResult>;
  sms?: (m: { id: string; to: string; body: string }) => Promise<SendResult>;
  whatsapp?: (m: { id: string; to: string; body: string }) => Promise<SendResult>;
}

export interface DispatchSummary {
  claimed: number;
  sent: number;
  retried: number;
  dead: number;
  skippedNotConfigured: boolean;
}

export async function dispatchBatch(
  deps: {
    db: NotificationDb;
    adapters: ChannelAdapters;
    siteUrl: string;
    now?: () => number;
    budgetMs?: number;
  },
  limit = 25,
): Promise<DispatchSummary> {
  const now = deps.now ?? Date.now;
  const started = now();
  const budget = deps.budgetMs ?? 20_000;
  const summary: DispatchSummary = {
    claimed: 0,
    sent: 0,
    retried: 0,
    dead: 0,
    skippedNotConfigured: false,
  };
  // Without an email adapter nothing is claimed, so no attempt counters burn down while unconfigured.
  if (!deps.adapters.email) {
    summary.skippedNotConfigured = true;
    return summary;
  }
  const batch = await deps.db.claim(limit, 120);
  summary.claimed = batch.length;
  for (const n of batch) {
    let result: SendResult;
    if (now() - started > budget) {
      // Out of time: hand the row back for the next run without a verdict.
      result = { ok: false, error: "dispatcher_time_budget", permanent: false };
    } else {
      result = await sendOne(n, deps.adapters, deps.siteUrl);
    }
    await deps.db.complete(n.id, result);
    if (result.ok) summary.sent++;
    else if (result.permanent) summary.dead++;
    else summary.retried++;
  }
  return summary;
}

async function sendOne(
  n: QueuedNotification,
  adapters: ChannelAdapters,
  siteUrl: string,
): Promise<SendResult> {
  const rendered = renderTemplate(n.template, n.data, { siteUrl });
  if (!rendered) return { ok: false, error: `unknown_template:${n.template}`, permanent: true };
  try {
    if (n.channel === "email") {
      if (!adapters.email) return { ok: false, error: "email_not_configured", permanent: false };
      return await adapters.email({
        id: n.id,
        to: n.recipient,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      });
    }
    const adapter = n.channel === "sms" ? adapters.sms : adapters.whatsapp;
    if (!adapter) return { ok: false, error: `${n.channel}_not_configured`, permanent: false };
    if (!rendered.sms) return { ok: false, error: "template_has_no_short_form", permanent: true };
    return await adapter({ id: n.id, to: n.recipient, body: rendered.sms });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message.slice(0, 200) : "send_failed",
      permanent: false,
    };
  }
}
