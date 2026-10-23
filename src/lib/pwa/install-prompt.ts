/** Hold the install event so the Stories bar can offer "Get the app" when the member chooses. */
export type BeforeInstallPromptEvent = Event & {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};
let deferredPrompt: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
export const getInstallPrompt = () => deferredPrompt;
export const setInstallPrompt = (e: BeforeInstallPromptEvent) => {
  deferredPrompt = e;
  listeners.forEach((l) => l());
};
export const clearInstallPrompt = () => {
  deferredPrompt = null;
  listeners.forEach((l) => l());
};
export const onInstallPromptChange = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
