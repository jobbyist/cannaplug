import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

/**
 * Ask The Plug guided match, open to everyone (owner's decision, 30 Oct 2026). A visitor has a tighter hourly cap than a
 * member (plug-match.server.ts). The browser sends quiz answers and product ids it was shown; never prices, stock or
 * user ids. Stock is read live on every call.
 */
const caller = async () => (await import("@/lib/plug-identity.server")).plugCaller();
const answers = z
  .record(z.string().max(20), z.string().max(20))
  .refine((a) => Object.keys(a).length <= 5);
const uuid = z.string().uuid();

export const plugQuizFn = createServerFn({ method: "POST" })
  .validator((d) =>
    z
      .object({
        answers,
        exclude: z.array(uuid).max(50).optional(),
        another: z.boolean().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) =>
    (await import("@/lib/plug-match.server")).plugQuiz(await caller(), {
      answers: data.answers,
      ...(data.exclude ? { exclude: data.exclude } : {}),
      ...(data.another ? { another: data.another } : {}),
    }),
  );

export const plugReserveFn = createServerFn({ method: "POST" })
  .validator((d) => z.object({ productId: uuid, answers, shown: z.array(uuid).max(50) }).parse(d))
  .handler(async ({ data }) =>
    (await import("@/lib/plug-match.server")).plugReserve(await caller(), data),
  );
