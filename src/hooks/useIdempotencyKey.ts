import { useRef } from "react";

/** One idempotency key per user intent: a retried click replays; a fresh intent gets a new key. */
export function useIdempotencyKey() {
  const ref = useRef<string | null>(null);
  return {
    get: () => (ref.current ??= crypto.randomUUID()),
    reset: () => {
      ref.current = null;
    },
  };
}
