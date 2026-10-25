// Optional error monitoring (Sentry), server side only. Off unless SENTRY_DSN is set.
// What is sent: the error type, a scrubbed message, a scrubbed stack, where it happened and the release.
// Never sent: request bodies, headers, cookies, query strings, user ids, emails, phone or ID numbers.

export type Dsn = { publicKey: string; host: string; projectId: string; protocol: string };

export function parseDsn(dsn: string | undefined): Dsn | null {
  if (!dsn) return null;
  try {
    const u = new URL(dsn);
    const projectId = u.pathname.replace(/^\/+|\/+$/g, "");
    if (!u.username || !/^\d+$/.test(projectId) || !/^https?:$/.test(u.protocol)) return null;
    return { publicKey: u.username, host: u.host, projectId, protocol: u.protocol };
  } catch {
    return null;
  }
}

/** Removes anything that could identify a person or unlock something. */
export function scrub(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]")
    .replace(/\b\d{13}\b/g, "[id-number]") // South African ID numbers
    .replace(/(\+27|\b0)[\s-]?\d{2}[\s-]?\d{3}[\s-]?\d{4}\b/g, "[phone]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[uuid]")
    .replace(/\b(eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, "[jwt]")
    .replace(/\b(sk|pk|re|sb)_[\w-]{8,}\b/g, "[key]")
    .replace(/([?&][\w-]+=)[^&\s"']+/g, "$1[redacted]")
    .replace(/\b\d{6,}\b/g, "[number]")
    .slice(0, 2000);
}

export function sentryEvent(err: unknown, where: string, release: string | undefined) {
  const e =
    err instanceof Error ? err : new Error(typeof err === "string" ? err : "non-error thrown");
  return {
    event_id: crypto.randomUUID().replace(/-/g, ""),
    timestamp: new Date().toISOString(),
    platform: "node",
    level: "error",
    environment: process.env["VERCEL_ENV"] ?? process.env["NODE_ENV"] ?? "production",
    ...(release ? { release } : {}),
    tags: { where: scrub(where).slice(0, 100) },
    exception: {
      values: [{ type: e.name, value: scrub(e.message), stacktrace: undefined }],
    },
    extra: { stack: scrub(e.stack ?? "") },
  };
}

/** Fire-and-forget; never throws, gives up after 2 seconds. */
export async function captureServerError(err: unknown, where: string): Promise<void> {
  const dsn = parseDsn(process.env["SENTRY_DSN"]);
  if (!dsn) return;
  try {
    const event = sentryEvent(err, where, process.env["VERCEL_GIT_COMMIT_SHA"]);
    const body = `${JSON.stringify({ event_id: event.event_id, sent_at: event.timestamp })}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify(event)}\n`;
    await fetch(`${dsn.protocol}//${dsn.host}/api/${dsn.projectId}/envelope/`, {
      method: "POST",
      headers: {
        "content-type": "application/x-sentry-envelope",
        "x-sentry-auth": `Sentry sentry_version=7, sentry_client=cannaplug/1.0, sentry_key=${dsn.publicKey}`,
      },
      body,
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    /* monitoring must never break the request */
  }
}
