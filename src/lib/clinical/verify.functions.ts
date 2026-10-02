import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

/** Public: no authentication. The token is validated and rate limited server-side. */
export const verifyDocumentFn = createServerFn({ method: "POST" })
  .validator((d) => z.object({ token: z.string().max(100) }).parse(d))
  .handler(async ({ data }) => {
    const [{ requestContext }, { verifyToken }] = await Promise.all([
      import("@/lib/clinical/context.server"),
      import("@/lib/clinical/verify-data.server"),
    ]);
    return verifyToken(data.token, requestContext().ip);
  });
