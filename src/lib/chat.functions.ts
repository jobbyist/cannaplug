import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { ChatReply } from "@/lib/ai/chat-service";

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

export type { ChatReply };

/**
 * "Ask Cannaplug", for signed-in members only. The same auth middleware as every other member function refuses
 * anonymous calls before the handler runs, so they never reach the quota or Gemini; the widget shows a sign-in
 * prompt instead of the input. Quota: per member per day, then IP, session and the shared free-tier budget
 * (src/lib/ai/quota.ts). The member's own latest-order status and points are added to the prompt server-side.
 */
export const askCannaPlug = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data) => inputSchema.parse(data))
  .handler(async ({ context, data }): Promise<ChatReply> => {
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
    );
  });

/** Messages left today and when they reset (midnight Pacific, when Google resets the free tier). */
export const getChatAllowanceFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) =>
    (await import("@/lib/ai/chat.server")).chatAllowance(context.userId),
  );
