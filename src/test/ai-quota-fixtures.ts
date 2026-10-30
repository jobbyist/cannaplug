import type { QuotaDb } from "@/lib/ai/quota";

/** An in-memory fixed-window counter that behaves like ai_quota_take. */
export function memQuota() {
  const counts = new Map<string, number>();
  const db: QuotaDb = {
    async take(bucket, limit) {
      const n = counts.get(bucket) ?? 0;
      if (n >= limit) return false;
      counts.set(bucket, n + 1);
      return true;
    },
    async count(bucket) {
      return counts.get(bucket) ?? 0;
    },
  };
  return { db, counts };
}
