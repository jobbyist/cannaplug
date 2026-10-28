import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { setUsernameFn } from "@/lib/rewards.functions";
import { normaliseUsername } from "@/lib/rewards-logic";
import { useIdempotencyKey } from "./use-member-account";
import { useUsernameCheck } from "./use-username-check";

/** Choose a username (once). It is the member's unique name and their referral code. */
export function UsernameForm({ onSaved }: { onSaved: () => Promise<void> | void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const check = useUsernameCheck(value);
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
        if (check.state === "ok") void save();
      }}
    >
      <Label htmlFor="member-username">Choose your username</Label>
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
        <Button type="submit" disabled={busy || check.state !== "ok"}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
      <p
        aria-live="polite"
        data-testid="username-status"
        className={
          "text-xs " +
          (check.state === "ok"
            ? "text-primary"
            : check.state === "idle" || check.state === "checking"
              ? "text-muted-foreground"
              : "text-destructive")
        }
      >
        {check.state === "checking"
          ? "Checking…"
          : check.state === "idle"
            ? "3 to 20 letters, numbers or underscores. It becomes your referral code, so it can't be changed later."
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
