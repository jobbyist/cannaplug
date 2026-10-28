import { useState } from "react";
import { Bug, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useIdempotencyKey } from "@/hooks/useIdempotencyKey";
import { submitBugReportFn } from "@/lib/forms.functions";

const KINDS = [
  { id: "bug", label: "Something is broken" },
  { id: "feedback", label: "Feedback" },
  { id: "idea", label: "An idea" },
] as const;
type Kind = (typeof KINDS)[number]["id"];

export const BUG_MESSAGE_MIN = 10;
export const BUG_MESSAGE_MAX = 4000;

/**
 * "Report a bug": a popup form from the header menu. The page the visitor was on is sent with the report (its
 * address only, never its query), so the team can find the problem. It goes to the webmaster inboxes fixed in the
 * server code.
 */
export function ReportBugDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto">
        {open && <BugForm onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function BugForm({ onClose }: { onClose: () => void }) {
  const [kind, setKind] = useState<Kind>("bug");
  const [message, setMessage] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState(""); // honeypot: people never see it
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const key = useIdempotencyKey();
  const page = typeof window !== "undefined" ? window.location.pathname : "";
  const tooShort = message.trim().length < BUG_MESSAGE_MIN;
  const emailBad = email.trim() !== "" && !/^\S+@\S+\.\S+$/.test(email.trim());

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await submitBugReportFn({
        data: {
          kind,
          message: message.trim(),
          ...(name.trim() ? { name: name.trim() } : {}),
          ...(email.trim() ? { email: email.trim() } : {}),
          page,
          key: key.get(),
          website,
        },
      });
      key.reset();
      setSent(true);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "We could not send that just now. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <div className="grid gap-4 py-4 text-center" data-testid="bug-sent">
        <CheckCircle2 className="mx-auto text-primary" size={36} />
        <DialogHeader>
          <DialogTitle className="text-center">Thank you</DialogTitle>
          <DialogDescription className="text-center">
            Your report has been sent to the team.{" "}
            {email.trim() ? "We may reply to the email you gave." : ""}
          </DialogDescription>
        </DialogHeader>
        <Button onClick={onClose}>Close</Button>
      </div>
    );
  }

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!tooShort && !emailBad && !busy) void submit();
      }}
    >
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <Bug size={18} /> Report a bug or send feedback
        </DialogTitle>
        <DialogDescription>
          Tell us what went wrong or what we could do better. The page you are on is sent with your
          report to help us find the problem.
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-1.5">
        <span className="text-sm font-medium">What is this about?</span>
        <div role="group" aria-label="Type of report" className="flex flex-wrap gap-2">
          {KINDS.map((k) => (
            <button
              key={k.id}
              type="button"
              aria-pressed={kind === k.id}
              onClick={() => setKind(k.id)}
              className={
                "rounded-full border px-3 py-1.5 text-xs font-semibold transition " +
                (kind === k.id
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border hover:border-primary")
              }
            >
              {k.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="bug-message">What happened?</Label>
        <Textarea
          id="bug-message"
          rows={5}
          maxLength={BUG_MESSAGE_MAX}
          placeholder="What did you do, what did you expect, and what happened instead?"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          Please don&apos;t include ID numbers, health details or passwords.
          {tooShort && message.length > 0
            ? ` Add a little more detail (at least ${BUG_MESSAGE_MIN} characters).`
            : ""}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="bug-name">Your name (optional)</Label>
          <Input
            id="bug-name"
            autoComplete="name"
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="bug-email">Email, so we can reply (optional)</Label>
          <Input
            id="bug-email"
            type="email"
            autoComplete="email"
            maxLength={254}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          {emailBad && (
            <p className="text-xs text-destructive">That email address does not look right.</p>
          )}
        </div>
      </div>

      {/* Honeypot: hidden from people and from screen readers; bots fill it in. */}
      <div aria-hidden="true" className="absolute left-[-9999px] h-0 w-0 overflow-hidden">
        <label>
          Website
          <input
            tabIndex={-1}
            autoComplete="off"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
          />
        </label>
      </div>

      <p className="text-xs text-muted-foreground" data-testid="bug-page">
        Page: {page || "unknown"}
      </p>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || tooShort || emailBad}>
          {busy ? "Sending…" : "Send report"}
        </Button>
      </DialogFooter>
    </form>
  );
}
