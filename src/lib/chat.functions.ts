import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { PlugReply } from "@/lib/ai/chat-service";
import { INTRO_FEATURE, PREVIEW_FEATURE } from "@/lib/ask-plug-access";

const inputSchema = z.object({
  sessionId: z.string().uuid(),
  mode: z.enum(["chat", "match"]).default("chat"),
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
 * "Ask The Plug 🔌", the AI budtender, for signed-in VERIFIED members. The auth middleware refuses anonymous calls
 * before the handler runs; the handler re-checks verification on every message (src/lib/ai/chat-service.ts), so
 * hiding the button is never the only guard. Quotas: src/lib/ai/quota.ts and src/lib/ai/plug-models.ts. The member
 * is the JWT subject; the browser sends only the conversation text and a session id.
 */
export const askThePlug = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data) => inputSchema.parse(data))
  .handler(async ({ context, data }): Promise<PlugReply> => {
    const [{ answer }, { chatDeps }] = await Promise.all([
      import("@/lib/ai/chat-service"),
      import("@/lib/ai/chat.server"),
    ]);
    const { getRequest } = await import("@tanstack/react-start/server");
    const { hashIp } = await import("@/lib/payments/service.server");
    const ip = getRequest().headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
    return answer(
      chatDeps(),
      { sessionId: data.sessionId, ipHash: hashIp(ip), userId: context.userId },
      data.messages,
      data.mode,
    );
  });

/** Whether this member can use Ask The Plug, what they have left today, and which announcement to show. */
export const getAskThePlugStatusFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) =>
    (await import("@/lib/ai/chat.server")).plugStatus(context.userId),
  );

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
