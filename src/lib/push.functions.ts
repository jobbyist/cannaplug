import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { topicIds } from "@/lib/push-topics";

/** Server-function boundary for push. The member comes only from the verified JWT; inputs never carry a user id. */
const b64url = (min: number, max: number) =>
  z.string().regex(new RegExp(`^[A-Za-z0-9_-]{${min},${max}}$`));
const key = z.string().min(8).max(120);
const endpoint = z.string().url().startsWith("https://").max(1000);

export const getPushSettingsFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) =>
    (await import("@/lib/push-data.server")).getPushSettings(context.userId),
  );

export const subscribePushFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d) =>
    z
      .object({
        endpoint,
        keys: z.object({ p256dh: b64url(80, 100), auth: b64url(16, 32) }),
        userAgent: z.string().max(300).nullable(),
        key,
      })
      .parse(d),
  )
  .handler(async ({ context, data }) =>
    (await import("@/lib/push-data.server")).subscribePush(
      context.userId,
      { endpoint: data.endpoint, p256dh: data.keys.p256dh, auth: data.keys.auth },
      data.userAgent,
      data.key,
    ),
  );

export const unsubscribePushFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d) => z.object({ endpoint }).parse(d))
  .handler(async ({ context, data }) =>
    (await import("@/lib/push-data.server")).unsubscribePush(context.userId, data.endpoint),
  );

export const removePushDeviceFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }) =>
    (await import("@/lib/push-data.server")).removePushDevice(context.userId, data.id),
  );

export const setPushTopicFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d) => z.object({ topic: z.enum(topicIds), enabled: z.boolean(), key }).parse(d))
  .handler(async ({ context, data }) =>
    (await import("@/lib/push-data.server")).setPushTopic(
      context.userId,
      data.topic,
      data.enabled,
      data.key,
    ),
  );

export const sendTestPushFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d) => z.object({}).strict().optional().parse(d))
  .handler(async ({ context }) =>
    (await import("@/lib/push-data.server")).sendTestPush(context.userId),
  );
