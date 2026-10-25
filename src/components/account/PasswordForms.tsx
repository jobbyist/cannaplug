import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";

export const MIN_PASSWORD = 8;

/** Rules a new password must meet before it is sent to Supabase Auth. */
export function passwordProblem(next: string, confirm: string): string | null {
  if (next.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (next.length > 72) return "Use 72 characters or fewer.";
  if (!/[A-Za-z]/.test(next) || !/[0-9]/.test(next)) return "Use letters and at least one number.";
  if (next !== confirm) return "The two passwords do not match.";
  return null;
}

/** Signed in: choose a new password (also used after following a reset link). */
export function ChangePasswordForm({ intro }: { intro?: string }) {
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const problem = passwordProblem(next, confirm);
    if (problem) return setMsg({ ok: false, text: problem });
    setBusy(true);
    setMsg(null);
    try {
      const { error } = await supabase.auth.updateUser({ password: next });
      if (error) throw error;
      setNext("");
      setConfirm("");
      setMsg({ ok: true, text: "Password changed. Use it the next time you sign in." });
    } catch (err) {
      const text = err instanceof Error ? err.message : "";
      setMsg({
        ok: false,
        text: /weak|pwned|leaked|known/i.test(text)
          ? "That password is too easy to guess or has appeared in a data leak. Choose another."
          : /same|different/i.test(text)
            ? "Choose a password you have not used for this account."
            : "The password could not be changed. Sign out, sign in again and retry.",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="grid gap-3" aria-labelledby="change-password-title">
      <h3 id="change-password-title" className="font-display text-sm font-bold uppercase">
        Change password
      </h3>
      {intro && <p className="text-xs text-muted-foreground">{intro}</p>}
      <div className="grid gap-1.5">
        <Label htmlFor="new-password">New password</Label>
        <Input
          id="new-password"
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          required
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="confirm-password">Repeat new password</Label>
        <Input
          id="confirm-password"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
        />
      </div>
      <p className="text-[0.7rem] text-muted-foreground">
        At least {MIN_PASSWORD} characters, with letters and a number.
      </p>
      {msg && (
        <p
          role={msg.ok ? "status" : "alert"}
          className={`rounded-md px-3 py-2 text-xs ${msg.ok ? "bg-primary/10 text-primary" : "bg-destructive/10 text-destructive"}`}
        >
          {msg.text}
        </p>
      )}
      <Button type="submit" disabled={busy}>
        {busy ? "Saving…" : "Change password"}
      </Button>
    </form>
  );
}

/** Signed out: email a reset link. The answer is the same whether or not the address has an account. */
export function ForgotPasswordForm({ onBack }: { onBack: () => void }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: `${window.location.origin}/account?reset=1`,
      });
    } catch {
      /* same answer either way: never reveal whether an account exists */
    } finally {
      setBusy(false);
      setSent(true);
    }
  };

  return (
    <form onSubmit={submit} className="grid gap-4" aria-labelledby="forgot-title">
      <h2 id="forgot-title" className="font-display text-lg font-bold uppercase">
        Reset your password
      </h2>
      {sent ? (
        <p role="status" className="rounded-md bg-primary/10 px-3 py-2 text-xs text-primary">
          If that email has a CannaPlug account, a reset link is on its way. Open it on this device,
          then choose a new password under Account settings.
        </p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            Enter your email and we'll send you a link to choose a new password.
          </p>
          <div className="grid gap-1.5">
            <Label htmlFor="forgot-email">Email address</Label>
            <Input
              id="forgot-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <Button type="submit" disabled={busy}>
            {busy ? "Sending…" : "Send reset link"}
          </Button>
        </>
      )}
      <button type="button" className="text-xs font-semibold text-primary" onClick={onBack}>
        Back to sign in
      </button>
    </form>
  );
}
