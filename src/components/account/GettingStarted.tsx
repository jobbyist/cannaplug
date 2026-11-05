import { CheckCircle2, Circle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { gettingStartedSteps, type GettingStartedState } from "@/lib/tour-logic";

/**
 * "Getting started" checklist for new members, shown inside the portal. It replaced the six-step popup tour
 * (5 Nov 2026): popups straight after sign-up got in the way of the phone saving the new password. Nothing here
 * opens over the page; the member can hide it at any time.
 */
export function GettingStarted({
  state,
  onGo,
  onDismiss,
}: {
  state: GettingStartedState;
  onGo: (tab: string) => void;
  onDismiss: () => void;
}) {
  const steps = gettingStartedSteps(state);
  const done = steps.filter((s) => s.done).length;
  return (
    <section
      data-testid="getting-started"
      aria-labelledby="getting-started-title"
      className="rounded-xl border border-primary/40 bg-primary/5 p-4 sm:p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="getting-started-title" className="font-display text-base font-bold uppercase">
            Getting started
          </h2>
          <p className="text-xs text-muted-foreground">
            {done} of {steps.length} done
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Hide getting started"
          className="-m-2 grid h-11 w-11 place-items-center rounded-full text-muted-foreground hover:bg-muted"
        >
          <X size={18} />
        </button>
      </div>
      <ol className="mt-3 grid gap-2">
        {steps.map((s) => (
          <li
            key={s.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-background p-3"
          >
            <div className="flex min-w-0 flex-1 items-start gap-2.5">
              {s.done ? (
                <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-primary" />
              ) : (
                <Circle size={18} className="mt-0.5 shrink-0 text-muted-foreground" />
              )}
              <div className="min-w-0">
                <p className={"text-sm font-semibold " + (s.done ? "line-through opacity-60" : "")}>
                  {s.title}
                </p>
                {!s.done && <p className="text-xs text-muted-foreground">{s.body}</p>}
              </div>
            </div>
            {!s.done &&
              (s.href ? (
                <Button asChild size="sm" variant="outline" className="min-h-[40px]">
                  <a href={s.href}>{s.action}</a>
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  className="min-h-[40px]"
                  onClick={() => s.tab && onGo(s.tab)}
                >
                  {s.action}
                </Button>
              ))}
          </li>
        ))}
      </ol>
    </section>
  );
}
