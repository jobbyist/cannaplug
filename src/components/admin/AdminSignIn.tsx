import { useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { LockKeyhole, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { ForgotPasswordForm } from "@/components/account/PasswordForms";
import logoWhite from "@/assets/cannaplug-logo-white.png";

/** Turns Supabase Auth errors into words a budtender can act on. Never says whether an account exists. */
export function signInMessage(raw: string): string {
  if (/invalid login credentials|invalid.*password|user not found/i.test(raw))
    return "That email and password don't match. Check them, or use Forgot password.";
  if (/email not confirmed/i.test(raw))
    return "This email address hasn't been confirmed yet. Ask a manager for help.";
  if (/rate|too many|security purposes/i.test(raw))
    return "Too many attempts. Wait a minute, then try again.";
  if (/network|fetch/i.test(raw)) return "No connection. Check the internet and try again.";
  return "Sign-in didn't work. Try again, or ask a manager.";
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="site grid min-h-screen bg-[#F8FAF8] dark:bg-background md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <aside className="relative hidden overflow-hidden bg-[#0B3D20] p-10 text-white md:flex md:flex-col md:justify-between">
        <img src={logoWhite} alt="CannaPlug" className="h-8 w-auto self-start" />
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.25em] text-[#D4AF37]">Staff only</p>
          <h1 className="mt-3 font-display text-4xl font-extrabold uppercase leading-tight">
            Admin &amp; till
          </h1>
          <p className="mt-3 max-w-sm text-sm text-white/80">
            The CannaPlug till, online orders, stock and members. Every action is recorded against
            the person signed in.
          </p>
        </div>
        <p className="text-xs text-white/60">Shop 002, One On Mutual, Pretoria Central</p>
        <span
          aria-hidden
          className="absolute -right-24 top-1/3 h-72 w-72 rounded-full border-4 border-[#D4AF37]/30"
        />
      </aside>
      <main className="grid place-items-center px-4 py-10">
        <div className="w-full max-w-sm">{children}</div>
      </main>
    </div>
  );
}

/** /admin when nobody is signed in. On success the auth listener re-renders /admin as the dashboard. */
export function AdminSignIn() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forgot, setForgot] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { error: authError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (authError) throw authError;
    } catch (err) {
      setError(signInMessage(err instanceof Error ? err.message : String(err)));
      setBusy(false);
    }
  };

  return (
    <Shell>
      {forgot ? (
        <ForgotPasswordForm onBack={() => setForgot(false)} />
      ) : (
        <form onSubmit={submit} className="grid gap-4" aria-labelledby="admin-signin-title">
          <div>
            <span className="mb-3 grid h-11 w-11 place-items-center rounded-full bg-[#0B3D20] text-white dark:bg-primary">
              <LockKeyhole size={18} />
            </span>
            <h2 id="admin-signin-title" className="font-display text-2xl font-extrabold uppercase">
              Staff sign-in
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">Use your work email and password.</p>
          </div>
          {error && (
            <p
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {error}
            </p>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="admin-email">Work email</Label>
            <Input
              id="admin-email"
              type="email"
              autoComplete="username"
              inputMode="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="admin-password">Password</Label>
            <Input
              id="admin-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <button
              type="button"
              onClick={() => setForgot(true)}
              className="justify-self-end text-xs font-semibold text-[#0B3D20] dark:text-[#D4AF37] underline-offset-2 hover:underline"
            >
              Forgot password?
            </button>
          </div>
          <Button type="submit" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            Shopping with us?{" "}
            <Link to="/account" className="font-semibold text-[#0B3D20] dark:text-[#D4AF37]">
              Member sign-in
            </Link>
          </p>
        </form>
      )}
    </Shell>
  );
}

/** Signed in, but the account has no staff role. */
export function NoStaffAccess({ email, onSignOut }: { email: string; onSignOut: () => void }) {
  return (
    <Shell>
      <div className="grid gap-4" role="status">
        <span className="grid h-11 w-11 place-items-center rounded-full bg-[#D4AF37]/20 text-[#0B3D20] dark:text-[#D4AF37]">
          <ShieldAlert size={18} />
        </span>
        <h2 className="font-display text-2xl font-extrabold uppercase">No staff access</h2>
        <p className="text-sm text-muted-foreground">
          You're signed in as <strong className="text-foreground">{email}</strong>, which isn't a
          staff account. If you work at CannaPlug, sign out and use your work email, or ask a
          manager to give you access.
        </p>
        <Button onClick={onSignOut}>Sign out and use another account</Button>
        <Link
          to="/account"
          className="text-center text-xs font-semibold text-[#0B3D20] dark:text-[#D4AF37]"
        >
          Go to my member account
        </Link>
      </div>
    </Shell>
  );
}
