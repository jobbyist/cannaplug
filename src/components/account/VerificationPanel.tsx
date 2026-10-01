import { useState, type FormEvent } from "react";
import { BadgeCheck, Clock, ShieldAlert, ShieldCheck, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { createIdUploadFn, submitVerificationFn } from "@/lib/verification.functions";
import {
  DOCUMENT_TYPES,
  ID_ACCEPT,
  ID_BUCKET,
  checkIdFile,
  dobProblem,
  earliestBirthDate,
  latestAdultBirthDate,
  verificationView,
  type DocumentType,
  type VerificationRow,
} from "@/lib/verification-logic";
import { useIdempotencyKey } from "./use-member-account";

const errorText = (err: unknown) =>
  err instanceof Error ? err.message : "Something went wrong. Please try again.";

const TONE_CLASS = {
  neutral: "border-border bg-card",
  warning: "border-amber-500/40 bg-amber-500/5",
  success: "border-primary/40 bg-primary/5",
  danger: "border-destructive/40 bg-destructive/5",
} as const;

function StatusIcon({ tone }: { tone: keyof typeof TONE_CLASS }) {
  if (tone === "success") return <ShieldCheck className="text-primary" size={22} />;
  if (tone === "warning") return <Clock className="text-amber-600" size={22} />;
  if (tone === "danger") return <ShieldAlert className="text-destructive" size={22} />;
  return <BadgeCheck className="text-muted-foreground" size={22} />;
}

/** Compact reminder for the dashboard; hidden once the member is verified. */
export function VerificationBanner({
  verification,
  onOpen,
}: {
  verification: VerificationRow | null;
  onOpen: () => void;
}) {
  const view = verificationView(verification);
  if (view.status === "verified") return null;
  return (
    <div
      data-testid="verification-banner"
      className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4 ${TONE_CLASS[view.tone]}`}
    >
      <div className="flex items-start gap-3">
        <StatusIcon tone={view.tone} />
        <div>
          <p className="text-sm font-semibold">{view.headline}</p>
          <p className="text-xs text-muted-foreground">{view.detail}</p>
        </div>
      </div>
      <Button size="sm" variant={view.canSubmit ? "default" : "outline"} onClick={onOpen}>
        {view.canSubmit ? "Verify my ID" : "View status"}
      </Button>
    </div>
  );
}

export function VerificationPanel({
  verification,
  defaultDob,
  onDone,
}: {
  verification: VerificationRow | null;
  defaultDob: string;
  onDone: () => Promise<void>;
}) {
  const view = verificationView(verification);
  const [documentType, setDocumentType] = useState<DocumentType>("sa_id");
  const [dob, setDob] = useState(defaultDob);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useIdempotencyKey();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const dobIssue = dobProblem(dob);
    if (dobIssue) return setError(dobIssue);
    if (!file) return setError("Choose a photo or scan of your ID.");
    const fileIssue = checkIdFile(file);
    if (fileIssue) return setError(fileIssue);

    setBusy(true);
    try {
      const { path, token } = await createIdUploadFn({ data: { mime: file.type as never } });
      const { error: uploadError } = await supabase.storage
        .from(ID_BUCKET)
        .uploadToSignedUrl(path, token, file, { contentType: file.type });
      if (uploadError) throw new Error("The upload failed. Please try again.");
      await submitVerificationFn({ data: { documentType, path, dob, key: key.get() } });
      key.reset();
      setFile(null);
      await onDone();
    } catch (err) {
      setError(errorText(err));
      // A refused or failed attempt is a new intent: don't replay a stale key.
      key.reset();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex max-w-xl flex-col gap-4">
      <h2 className="font-display text-lg font-bold uppercase">ID verification</h2>
      <div
        data-testid="verification-status"
        className={`flex items-start gap-3 rounded-xl border p-5 ${TONE_CLASS[view.tone]}`}
      >
        <StatusIcon tone={view.tone} />
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold">{view.headline}</p>
            <Badge>{view.label}</Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{view.detail}</p>
        </div>
      </div>

      {view.canSubmit && (
        <form
          onSubmit={(e) => void submit(e)}
          className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5"
        >
          <div className="grid gap-1.5">
            <Label htmlFor="id-type">Document type</Label>
            <select
              id="id-type"
              value={documentType}
              onChange={(e) => setDocumentType(e.target.value as DocumentType)}
              className="h-10 rounded-md border border-input bg-background px-3 text-sm"
            >
              {DOCUMENT_TYPES.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="id-dob">Date of birth (as on your ID)</Label>
            <Input
              id="id-dob"
              type="date"
              required
              min={earliestBirthDate()}
              max={latestAdultBirthDate()}
              value={dob}
              onChange={(e) => setDob(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="id-file">Photo or scan of your ID</Label>
            <Input
              id="id-file"
              type="file"
              accept={ID_ACCEPT}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            <p className="text-[0.7rem] text-muted-foreground">
              JPG, PNG, WebP or PDF, up to 5 MB. Make sure your name, photo and date of birth are
              clear. Only CannaPlug managers can open it, and every view is logged.
            </p>
          </div>
          {error && (
            <p
              role="alert"
              className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {error}
            </p>
          )}
          <Button type="submit" disabled={busy} className="self-start">
            <Upload size={14} className="mr-1.5" />
            {busy ? "Uploading…" : "Submit for review"}
          </Button>
          <p className="text-[0.7rem] text-muted-foreground">
            {view.attemptsLeft} submission{view.attemptsLeft === 1 ? "" : "s"} left.
          </p>
        </form>
      )}
      {!view.canSubmit && view.status === "rejected" && (
        <p className="text-xs text-muted-foreground">
          You've used all your submissions. Please contact CannaPlug support.
        </p>
      )}
    </div>
  );
}
