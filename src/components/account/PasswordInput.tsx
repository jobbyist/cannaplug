import { forwardRef, useState, type ComponentProps } from "react";
import { Check, Eye, EyeOff } from "lucide-react";
import { Input } from "@/components/ui/input";
import { passwordChecks } from "@/lib/password-rules";

/**
 * A password box with a Show / Hide button. Seeing what was typed (or what the phone suggested) is what stops
 * people losing a password they never saw. `autoComplete` must be "new-password" or "current-password" so the
 * phone's password manager offers to save it.
 */
export const PasswordInput = forwardRef<
  HTMLInputElement,
  Omit<ComponentProps<"input">, "type"> & { autoComplete: "new-password" | "current-password" }
>(function PasswordInput({ className, ...props }, ref) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <Input
        ref={ref}
        {...props}
        type={shown ? "text" : "password"}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        className={"h-11 pr-16 " + (className ?? "")}
      />
      <button
        type="button"
        onClick={() => setShown((s) => !s)}
        aria-label={shown ? "Hide password" : "Show password"}
        aria-pressed={shown}
        className="absolute inset-y-0 right-0 flex min-w-[44px] items-center justify-center gap-1 px-3 text-xs font-semibold text-primary"
      >
        {shown ? <EyeOff size={16} /> : <Eye size={16} />}
        <span>{shown ? "Hide" : "Show"}</span>
      </button>
    </div>
  );
});

/** Live checklist under a new-password box, so the rules are clear before pressing the button. */
export function PasswordHints({ value, id }: { value: string; id?: string }) {
  return (
    <ul id={id} className="grid gap-0.5 text-[0.75rem]" aria-live="polite">
      {passwordChecks(value).map((c) => (
        <li
          key={c.label}
          className={
            "flex items-center gap-1.5 " + (c.ok ? "text-primary" : "text-muted-foreground")
          }
        >
          <Check size={12} className={c.ok ? "opacity-100" : "opacity-30"} aria-hidden="true" />
          {c.label}
          <span className="sr-only">{c.ok ? " (done)" : " (not yet)"}</span>
        </li>
      ))}
    </ul>
  );
}
