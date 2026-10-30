/** Small pure helpers for the Loyalty tab (kept apart so they can be unit-tested). */

/** "7 of 10 tubes" progress towards the next free pre-roll, 0 to 100. */
export function tubeProgress(tubes: number, perReward: number): number {
  if (perReward <= 0) return 0;
  const into = tubes % perReward;
  if (into === 0 && tubes > 0) return 100;
  return Math.round((into / perReward) * 100);
}

export function tubesLine(tubes: number, perReward: number): string {
  if (tubes >= perReward) {
    const n = Math.floor(tubes / perReward);
    return `${n} free pre-roll${n === 1 ? "" : "s"} ready`;
  }
  const left = perReward - tubes;
  return `${left} more tube${left === 1 ? "" : "s"} for a free pre-roll`;
}

/** A fresh idempotency key for one intended action; a retry of the same action must reuse it. */
export const newKey = (label: string) =>
  `${label}-${typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;

export const HISTORY_LABEL: Record<string, string> = {
  return: "Tubes returned",
  redeem: "Free pre-roll given",
  redeem_void: "Sale voided, tubes returned",
};
