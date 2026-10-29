import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { TOUR_STEPS } from "@/lib/tour-logic";

/**
 * Skippable walkthrough of the member portal, shown as a series of popups. `onFinish` runs once however the
 * member leaves it (Done, Skip, Escape or the close button), so the caller can mark it as seen.
 */
export function PlatformTour({
  onStep,
  onFinish,
}: {
  onStep?: (tab: string) => void;
  onFinish: () => void;
}) {
  const [index, setIndex] = useState(0);
  const step = TOUR_STEPS[index]!;
  const last = index === TOUR_STEPS.length - 1;
  const go = (next: number) => {
    setIndex(next);
    const tab = TOUR_STEPS[next]?.tab;
    if (tab) onStep?.(tab);
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onFinish()}>
      <DialogContent data-testid="platform-tour" className="max-w-md">
        <p className="text-[0.68rem] font-bold uppercase tracking-[0.16em] text-primary">
          Step {index + 1} of {TOUR_STEPS.length}
        </p>
        <DialogTitle className="font-display text-xl font-extrabold uppercase">
          {step.title}
        </DialogTitle>
        <DialogDescription className="text-sm leading-relaxed">{step.body}</DialogDescription>
        <div className="flex gap-1.5" aria-hidden="true">
          {TOUR_STEPS.map((s, i) => (
            <span
              key={s.id}
              className={"h-1.5 flex-1 rounded-full " + (i <= index ? "bg-primary" : "bg-muted")}
            />
          ))}
        </div>
        <div className="flex items-center justify-between gap-2">
          <Button variant="ghost" size="sm" onClick={onFinish}>
            Skip tour
          </Button>
          <div className="flex gap-2">
            {index > 0 && (
              <Button variant="outline" size="sm" onClick={() => go(index - 1)}>
                Back
              </Button>
            )}
            <Button size="sm" onClick={() => (last ? onFinish() : go(index + 1))}>
              {last ? "Done" : "Next"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
