import { useEffect, useState } from "react";
import { Download, Share, SquarePlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { installMode, markSeen, readSeenAt, type InstallMode } from "@/lib/pwa/install";
import {
  clearInstallPrompt,
  getInstallPrompt,
  onInstallPromptChange,
} from "@/lib/pwa/install-prompt";

const storage = () => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

/** "Get the app" story bubble: the browser's install prompt, or Add-to-Home-Screen steps on iOS Safari. */
export function GetTheAppStory() {
  const [mode, setMode] = useState<InstallMode>(null);
  const [iosOpen, setIosOpen] = useState(false);

  useEffect(() => {
    const decide = () =>
      setMode((current) => {
        if (current) return current; // once shown this visit, keep it until used or dismissed
        const standalone =
          window.matchMedia?.("(display-mode: standalone)").matches ||
          (navigator as Navigator & { standalone?: boolean }).standalone === true;
        const next = installMode({
          standalone,
          hasPromptEvent: !!getInstallPrompt(),
          userAgent: navigator.userAgent,
          seenAt: readSeenAt(storage()),
          now: Date.now(),
        });
        if (next) markSeen(storage()); // never offered twice in a week
        return next;
      });
    decide();
    return onInstallPromptChange(decide);
  }, []);

  if (!mode) return null;
  const open = async () => {
    if (mode === "ios") return setIosOpen(true);
    const evt = getInstallPrompt();
    if (!evt) return setMode(null);
    await evt.prompt();
    await evt.userChoice.catch(() => undefined);
    clearInstallPrompt();
    setMode(null);
  };

  return (
    <>
      <button className="story" onClick={() => void open()} aria-label="Get the CannaPlug app">
        <span className="story-ring">
          <Download size={22} />
        </span>
        <span>Get the app</span>
      </button>
      {iosOpen && (
        <div
          className="story-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Add CannaPlug to your Home Screen"
          onClick={() => setIosOpen(false)}
        >
          <article
            className="m-auto max-w-sm rounded-2xl bg-card p-6 text-left text-foreground"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-display text-lg font-extrabold uppercase">Get the app</h2>
              <button aria-label="Close" onClick={() => setIosOpen(false)}>
                <X size={18} />
              </button>
            </div>
            <ol className="flex flex-col gap-3 text-sm">
              <li className="flex items-center gap-2">
                <Share size={18} className="text-primary" /> 1. Tap <b>Share</b> in Safari&apos;s
                toolbar.
              </li>
              <li className="flex items-center gap-2">
                <SquarePlus size={18} className="text-primary" /> 2. Choose{" "}
                <b>Add to Home Screen</b>.
              </li>
              <li>
                3. Tap <b>Add</b>. CannaPlug opens full screen, like an app.
              </li>
            </ol>
            <Button className="mt-5 w-full" onClick={() => setIosOpen(false)}>
              Got it
            </Button>
          </article>
        </div>
      )}
    </>
  );
}
