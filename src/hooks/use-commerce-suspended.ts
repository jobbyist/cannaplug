import { useCallback, useEffect, useState } from "react";
import { getCommerceStatusFn } from "@/lib/commerce.functions";

/** True while POS sales and online checkout are suspended. Unknown (offline, error) counts as open; the server decides. */
export function useCommerceSuspended(enabled = true) {
  const [suspended, setSuspended] = useState(false);
  const refresh = useCallback(async () => {
    try {
      setSuspended((await getCommerceStatusFn()).suspended === true);
    } catch {
      /* the server enforces the suspension either way */
    }
  }, []);
  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh]);
  return { suspended, refresh };
}
