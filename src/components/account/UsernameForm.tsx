import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { setUsernameFn } from "@/lib/rewards.functions";
import { normaliseUsername } from "@/lib/rewards-logic";
import { useIdempotencyKey } from "./use-member-account";
import { useUsernameCheck } from "./use-username-check";

/**
 * Choose a username (once). It is the member's unique name and their referral code. With `initial` (a username we
 * generated for them) the member can keep it or replace it once; after that it is final. An imported member already
 * has the username from the previous platform and may change it once (`mode="change"`), after submitting their ID.
 */
export function UsernameForm({
  onSaved,
  initial,
  mode = "choose",
}: {
  onSaved: () => Promise<void> | void;
  initial?: string;
  mode?: "choose" | "change";
}) {
  const [value, setValue] = useState(initial ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const check = useUsernameCheck(value);
  const keeping = !!initial && normaliseUsername(value) === initial;
  const canSave = keeping || check.state === "ok";
  const key = useIdempotencyKey();

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await setUsernameFn({ data: { username: normaliseUsername(value), key: key.get() } });
      key.reset();
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save your username. Please retry.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="grid gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSave) void save();
      }}
    >
      <Label htmlFor="member-username">
        {mode === "change"
          ? "Change your username (one time only)"
          : initial
            ? "Your username"
            : "Choose your username"}
      </Label>
      <div className="flex gap-2">
        <Input
          id="member-username"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={20}
          placeholder="e.g. thandi_m"
          value={value}
          onChange={(e) => setValue(e.target.value.replace(/\s/g, ""))}
        />
        <Button type="submit" disabled={busy || !canSave}>
          {busy ? "Saving…" : keeping ? "Keep it" : mode === "change" ? "Change" : "Save"}
        </Button>
      </div>
      <p
        aria-live="polite"
        data-testid="username-status"
        className={
          "text-xs " +
          (check.state === "ok" || keeping
            ? "text-primary"
            : check.state === "idle" || check.state === "checking"
              ? "text-muted-foreground"
              : "text-destructive")
        }
      >
        {keeping
          ? "This is the username we generated for you. Keep it, or type a new one."
          : check.state === "checking"
            ? "Checking…"
            : check.state === "idle"
              ? mode === "change"
                ? "3 to 20 letters, numbers or underscores. You can only do this once, and it becomes your referral code."
                : "3 to 20 letters, numbers or underscores. It becomes your referral code, so it can't be changed later."
              : check.message}
      </p>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}
