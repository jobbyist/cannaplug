import { useEffect, useState } from "react";
import { checkUsernameFn } from "@/lib/rewards.functions";
import { normaliseUsername, usernameProblem } from "@/lib/rewards-logic";

export type UsernameCheck =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "ok" | "taken" | "reserved" | "invalid" | "error"; message: string };

/** Checks, as you type, that a username is well formed and free. The database still has the final say. */
export function useUsernameCheck(value: string, delayMs = 350): UsernameCheck {
  const [result, setResult] = useState<UsernameCheck>({ state: "idle" });
  useEffect(() => {
    const v = normaliseUsername(value);
    if (!v) return setResult({ state: "idle" });
    const problem = usernameProblem(v);
    if (problem) return setResult({ state: "invalid", message: problem });
    let alive = true;
    setResult({ state: "checking" });
    const t = setTimeout(() => {
      checkUsernameFn({ data: { username: v } })
        .then(({ status }) => {
          if (!alive) return;
          setResult(
            status === "ok"
              ? { state: "ok", message: "Available" }
              : status === "taken"
                ? { state: "taken", message: "That username is taken. Try another." }
                : { state: "reserved", message: "That username is not available. Try another." },
          );
        })
        .catch(
          () =>
            alive &&
            setResult({ state: "error", message: "Could not check that username. Try again." }),
        );
    }, delayMs);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [value, delayMs]);
  return result;
}
