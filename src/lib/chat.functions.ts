import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { PlugReply } from "@/lib/ai/chat-service";
import { INTRO_FEATURE, PREVIEW_FEATURE } from "@/lib/ask-plug-access";

const inputSchema = z.object({
  sessionId: z.string().uuid(),
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        // A member types at most 500 characters; earlier assistant replies come back clipped to 900.
        content: z.string().min(1).max(900),
      }),
    )
    .min(1)
    .max(24)
    .refine((m) => m[m.length - 1]!.role === "user" && m[m.length - 1]!.content.length <= 500, {
      message: "The last message must be the member's, up to 500 characters.",
    }),
});

export type { PlugReply };
export type ChatReply = PlugReply;

/**
 * "Ask The Plug 🔌", the AI budtender, open to everyone (owner's decision, 30 Oct 2026). A valid sign-in makes the caller
 * a member with the full daily allowance; a visitor gets a much smaller one (src/lib/ai/quota.ts). Who the caller is
 * comes from the verified token on the server, never from the request body. The browser sends only the conversation
 * text and a session id.
 */
export const askThePlug = createServerFn({ method: "POST" })
  .validator((data) => inputSchema.parse(data))
  .handler(async ({ data }): Promise<PlugReply> => {
    const [{ answer }, { chatDeps }, { plugCaller }] = await Promise.all([
      import("@/lib/ai/chat-service"),
      import("@/lib/ai/chat.server"),
      import("@/lib/plug-identity.server"),
    ]);
    const who = await plugCaller();
    return answer(chatDeps(), { sessionId: data.sessionId, ...who }, data.messages);
  });

/** The launcher state for this caller: always available; members also get their allowance and the one-time intro. */
export const getAskThePlugStatusFn = createServerFn({ method: "GET" }).handler(async () => {
  const [{ plugStatus }, { plugCaller }] = await Promise.all([
    import("@/lib/ai/chat.server"),
    import("@/lib/plug-identity.server"),
  ]);
  return plugStatus((await plugCaller()).userId);
});

const seenSchema = z.object({
  feature: z.enum([INTRO_FEATURE, PREVIEW_FEATURE]),
  action: z.enum(["opened", "dismissed"]),
  idempotencyKey: z.string().min(8).max(120),
});

/** Records that the member has seen the launch announcement, so it never shows again on any device. */
export const markAskThePlugSeenFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data) => seenSchema.parse(data))
  .handler(async ({ context, data }) =>
    (await import("@/lib/ai/chat.server")).markFeatureSeen(
      context.userId,
      data.feature,
      data.action,
      data.idempotencyKey,
    ),
  );
