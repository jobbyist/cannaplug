import { createMiddleware } from "@tanstack/react-start";
import { isNotFound, isRedirect } from "@tanstack/react-router";
import { GENERIC_STAFF_ERROR, friendlyStaffError } from "@/lib/staff-errors";
import { captureServerError } from "@/lib/monitoring";

/**
 * First middleware on every staff server function: whatever goes wrong below (auth, validation, the handler, the
 * database), the browser gets a plain sentence. The original is logged on the server, without request data.
 */
export const friendlyStaffErrors = createMiddleware({ type: "function" }).server(
  async ({ next }) => {
    try {
      return await next();
    } catch (err) {
      if (isRedirect(err) || isNotFound(err) || err instanceof Response) throw err;
      const friendly = friendlyStaffError(err);
      // Unexpected failures (not a rule the person can act on) go to monitoring when SENTRY_DSN is set.
      if (friendly.message === GENERIC_STAFF_ERROR)
        void captureServerError(err, "staff server function");
      if (friendly.message !== (err as Error)?.message)
        console.error(
          "staff action failed:",
          err instanceof Error ? err.message : "non-error thrown",
        );
      throw friendly;
    }
  },
);
