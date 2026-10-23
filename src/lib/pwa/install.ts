/**
 * "Get the app" prompt rules. Pure so they are unit-tested:
 *  - never when already installed (standalone display mode / iOS navigator.standalone);
 *  - Android / desktop Chromium: only once the browser has offered `beforeinstallprompt`;
 *  - iOS Safari (no install API): show the Add-to-Home-Screen steps instead;
 *  - never shown again within a week of being shown (or dismissed).
 */
export const INSTALL_SEEN_KEY = "cannaplug.install.seenAt";
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export type InstallMode = "prompt" | "ios" | null;

export function isIosSafari(ua: string): boolean {
  const ios = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && /Mobile\//i.test(ua));
  // Chrome/Firefox/Edge on iOS cannot add to the home screen from their own menu reliably.
  return ios && /Safari\//i.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/i.test(ua);
}

export function installMode(input: {
  standalone: boolean;
  hasPromptEvent: boolean;
  userAgent: string;
  seenAt: number | null;
  now: number;
}): InstallMode {
  if (input.standalone) return null;
  if (input.seenAt !== null && input.now - input.seenAt < WEEK_MS) return null;
  if (input.hasPromptEvent) return "prompt";
  if (isIosSafari(input.userAgent)) return "ios";
  return null;
}

export function readSeenAt(storage: Pick<Storage, "getItem"> | null): number | null {
  try {
    const v = Number(storage?.getItem(INSTALL_SEEN_KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

export function markSeen(storage: Pick<Storage, "setItem"> | null, now = Date.now()): void {
  try {
    storage?.setItem(INSTALL_SEEN_KEY, String(now));
  } catch {
    /* private mode: the prompt may show again, which is harmless */
  }
}
