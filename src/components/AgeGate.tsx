import { useEffect, useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";

export const AGE_GATE_KEY = "cannaplug.age.v1";
export const AGE_GATE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Pages that never ask: document verification (anyone holding a document may check it), staff areas, offline. */
const EXEMPT = [/^\/verify(\/|$)/, /^\/admin(\/|$)/, /^\/doctor(\/|$)/, /^\/offline$/];
/** Search engines and link previews read public pages without being asked. */
const CRAWLER =
  /bot|crawler|spider|crawling|slurp|bingpreview|facebookexternalhit|whatsapp|telegram|linkedin|embedly|lighthouse/i;

export function ageGateNeeded(
  path: string,
  userAgent: string,
  storedAt: number | null,
  now: number,
) {
  if (EXEMPT.some((r) => r.test(path))) return false;
  if (CRAWLER.test(userAgent)) return false;
  return !(storedAt && now - storedAt >= 0 && now - storedAt < AGE_GATE_DAYS * DAY_MS);
}

function readStored(): number | null {
  try {
    const v = Number(window.localStorage.getItem(AGE_GATE_KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

/**
 * 18+ confirmation on the first visit (site and installed app), remembered on this device for 30 days.
 * It renders only in the browser after load, over the page, so the page itself stays in the HTML for crawlers.
 */
export function AgeGate() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const [open, setOpen] = useState(false);
  const [declined, setDeclined] = useState(false);

  useEffect(() => {
    setOpen(ageGateNeeded(path, navigator.userAgent, readStored(), Date.now()));
  }, [path]);

  if (!open) return null;
  const confirm = () => {
    try {
      window.localStorage.setItem(AGE_GATE_KEY, String(Date.now()));
    } catch {
      /* private mode: confirmed for this visit only */
    }
    setOpen(false);
  };

  return (
    <div
      className="fixed inset-0 z-[100] grid place-items-center bg-[#0B3D20]/95 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="age-gate-title"
      aria-describedby="age-gate-desc"
    >
      <div className="w-full max-w-sm rounded-2xl bg-background p-6 text-center shadow-xl">
        <p className="text-xs font-bold uppercase tracking-[0.2em] text-[#0B3D20] dark:text-[#D4AF37]">
          CannaPlug
        </p>
        <h2 id="age-gate-title" className="mt-2 font-display text-2xl font-extrabold uppercase">
          Are you 18 or older?
        </h2>
        {declined ? (
          <p id="age-gate-desc" role="status" className="mt-3 text-sm text-muted-foreground">
            Sorry, CannaPlug is for adults aged 18 and over only.
          </p>
        ) : (
          <p id="age-gate-desc" className="mt-3 text-sm text-muted-foreground">
            You must be 18 or older to visit this site. We ask again in 30 days.
          </p>
        )}
        <div className="mt-5 grid gap-2">
          <Button autoFocus onClick={confirm}>
            Yes, I'm 18 or older
          </Button>
          <Button variant="outline" onClick={() => setDeclined(true)}>
            No
          </Button>
        </div>
      </div>
    </div>
  );
}
