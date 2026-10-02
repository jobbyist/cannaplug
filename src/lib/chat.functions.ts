import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

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
  { ok: true; reply: string } | { ok: false; error: string; limited?: boolean };

/**
 * "Ask Cannaplug": gemini-2.5-flash, system prompt built from the site's own facts + the live menu, and
 * layered rate limits (per visitor IP, per session, and a SHARED daily/per-minute budget that keeps the whole
 * site inside the Gemini free tier — see src/lib/ai/quota.ts).
 */
export const askCannaPlug = createServerFn({ method: "POST" })
  .validator((data) => inputSchema.parse(data))
  .handler(async ({ data }): Promise<ChatReply> => {
    const [{ answer }, { chatDeps }] = await Promise.all([
      import("@/lib/ai/chat-service"),
      import("@/lib/ai/chat.server"),
    ]);
    const { getRequest } = await import("@tanstack/react-start/server");
    const { hashIp } = await import("@/lib/payments/service.server");
    const ip = getRequest().headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
    return answer(chatDeps(), { sessionId: data.sessionId, ipHash: hashIp(ip) }, data.messages);
  });
