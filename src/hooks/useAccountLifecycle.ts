import { useCallback, useEffect, useState } from "react";
import { getMyAccountStateFn, setMyAccountStatusFn } from "@/lib/account-lifecycle.functions";
import type { AccountAction, AccountState } from "@/lib/account-lifecycle";

/** The member's account status, loaded once and updated by each choice. One copy lives on the Account page. */
export function useAccountLifecycle() {
  const [state, setState] = useState<AccountState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setState((await getMyAccountStateFn()) as AccountState);
    } catch {
      // The Settings card says so if it cannot load; the rest of the page does not depend on this.
      setState(null);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (action: AccountAction): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      setState(
        (await setMyAccountStatusFn({
          data: { action, key: crypto.randomUUID() },
        })) as AccountState,
      );
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "That could not be completed. Please retry.");
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { state, busy, error, act, reload: load };
}
export type AccountLifecycle = ReturnType<typeof useAccountLifecycle>;
