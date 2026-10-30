import { useQuery } from "@tanstack/react-query";
import { getAskThePlugStatusFn } from "@/lib/chat.functions";

/** One status request feeds both the launcher and the intro modal. */
export const plugStatusKey = (userId: string | null) =>
  ["ask-the-plug-status", userId ?? "guest"] as const;

export function usePlugStatus(userId: string | null) {
  return useQuery({
    queryKey: plugStatusKey(userId),
    queryFn: () => getAskThePlugStatusFn(),
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

/** Opens the Ask The Plug panel from anywhere (the intro modal, a banner…), optionally with a first message. */
export const OPEN_EVENT = "askplug:open";
export function openAskThePlug(prompt?: string) {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { prompt } }));
}

/** Asks the launcher to open on the next storefront page (used when the intro modal sends a member to the shop). */
export const OPEN_ON_ARRIVAL_KEY = "cannaplug.chat.plug.open";
export function openAskThePlugOnArrival() {
  try {
    window.sessionStorage.setItem(OPEN_ON_ARRIVAL_KEY, "1");
  } catch {
    /* storage unavailable: the member can still tap the launcher */
  }
}
export function takeOpenOnArrival(): boolean {
  try {
    const v = window.sessionStorage.getItem(OPEN_ON_ARRIVAL_KEY) === "1";
    if (v) window.sessionStorage.removeItem(OPEN_ON_ARRIVAL_KEY);
    return v || /(?:^|[?&])ask=1(?:&|$)/.test(window.location.search);
  } catch {
    return false;
  }
}
