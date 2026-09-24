import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const HOURLY_LIMIT = 12;
const SESSION_LIMIT = 40;
const WINDOW_MS = 60 * 60 * 1000;

const inputSchema = z.object({
  sessionId: z.string().uuid(),
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(2000),
      }),
    )
    .min(1)
    .max(40),
});

export type ChatReply =
  | { ok: true; reply: string; remaining: number }
  | { ok: false; error: string; limited?: boolean };

export const askCannaPlug = createServerFn({ method: "POST" })
  .inputValidator((data) => inputSchema.parse(data))
  .handler(async ({ data }): Promise<ChatReply> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { geminiComplete, toPlainText, GatewayError } = await import("./ai-gateway.server");
    const { CANNAPLUG_SYSTEM_PROMPT, buildMenuContext } = await import("./cannaplug-brain.server");

    // Per-session rate limiting
    const now = Date.now();
    const { data: row } = await supabaseAdmin
      .from("chat_rate_limits")
      .select("*")
      .eq("session_id", data.sessionId)
      .maybeSingle();

    let windowStart = row ? new Date(row.window_start).getTime() : now;
    let requestCount = row?.request_count ?? 0;
    const totalCount = row?.total_count ?? 0;
    if (now - windowStart > WINDOW_MS) {
      windowStart = now;
      requestCount = 0;
    }
    if (totalCount >= SESSION_LIMIT) {
      return { ok: false, limited: true, error: "You've reached the chat limit for this session. For more help, call +27 10 123 4567 or pop into the shop." };
    }
    if (requestCount >= HOURLY_LIMIT) {
      const mins = Math.max(1, Math.ceil((windowStart + WINDOW_MS - now) / 60000));
      return { ok: false, limited: true, error: `You're sending messages quickly. Please try again in about ${mins} minute${mins === 1 ? "" : "s"}.` };
    }

    await supabaseAdmin.from("chat_rate_limits").upsert({
      session_id: data.sessionId,
      window_start: new Date(windowStart).toISOString(),
      request_count: requestCount + 1,
      total_count: totalCount + 1,
      updated_at: new Date().toISOString(),
    });

    const menu = await buildMenuContext();
    const history = data.messages.slice(-16);

    try {
      const raw = await geminiComplete(
        [
          { role: "system", content: `${CANNAPLUG_SYSTEM_PROMPT}\n\n${menu}` },
          ...history,
        ],
        { maxTokens: 700, temperature: 0.6 },
      );
      const reply = toPlainText(raw) || "Sorry, I couldn't put an answer together just then. Could you rephrase that?";
      return { ok: true, reply, remaining: Math.min(HOURLY_LIMIT - requestCount - 1, SESSION_LIMIT - totalCount - 1) };
    } catch (error) {
      const message = error instanceof GatewayError ? error.message : "The assistant is temporarily unavailable.";
      return { ok: false, error: message };
    }
  });
