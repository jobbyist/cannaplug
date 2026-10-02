import { AlertTriangle, BadgeCheck, ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";
import type { PublicVerification } from "@/lib/clinical/verification-logic";
import logoImage from "@/assets/cannaplug-logo.png";

const COPY: Record<
  PublicVerification["status"],
  { tone: "ok" | "bad" | "warn"; title: string; lead: string }
> = {
  VALID: {
    tone: "ok",
    title: "DOCUMENT VERIFIED",
    lead: "This is a genuine CannaPlug document and it is currently valid.",
  },
  REVOKED: {
    tone: "bad",
    title: "DOCUMENT REVOKED",
    lead: "This document has been revoked and must not be relied on.",
  },
  EXPIRED: {
    tone: "bad",
    title: "DOCUMENT EXPIRED",
    lead: "This document has passed its expiry date.",
  },
  VOID: {
    tone: "bad",
    title: "DOCUMENT NOT VALID",
    lead: "This document was withdrawn before it was issued.",
  },
  NOT_ISSUED: {
    tone: "bad",
    title: "DOCUMENT NOT VALID",
    lead: "This document has not been issued.",
  },
  INTEGRITY_FAILURE: {
    tone: "bad",
    title: "COULD NOT BE VERIFIED",
    lead: "This document failed an integrity check. Do not rely on it and contact CannaPlug.",
  },
  NOT_FOUND: {
    tone: "bad",
    title: "NO MATCHING DOCUMENT",
    lead: "We couldn't find a document for this code. Check the code or contact CannaPlug.",
  },
  RATE_LIMITED: {
    tone: "warn",
    title: "TOO MANY ATTEMPTS",
    lead: "Please wait a few minutes and try again.",
  },
};

export function VerificationResult({ result }: { result: PublicVerification }) {
  const copy = COPY[result.status];
  return (
    <VerificationShell tone={copy.tone} title={copy.title} lead={copy.lead}>
      {result.documentId && (
        <dl className="mt-6 grid gap-3 text-left text-sm">
          <Row label="Document ID" value={result.documentId} />
          <Row label="Document type" value={result.documentType} />
          <Row label="Issued" value={result.issued} />
          {result.expires && <Row label="Valid until" value={result.expires} />}
          <Row label="Practitioner" value={result.practitioner} />
          <Row label="Registration" value={result.registration} />
          {result.signature && <Row label="Signature" value={result.signature} />}
          <Row
            label="Status"
            value={
              result.status === "VALID"
                ? "VALID"
                : result.status === "INTEGRITY_FAILURE"
                  ? "NOT VERIFIED"
                  : result.status.replace("_", " ")
            }
          />
        </dl>
      )}
      <p className="mt-8 text-xs text-muted-foreground">
        Verification confirms that a document is genuine and its current status. It does not show
        the contents of the document or any information about the person it was issued to.
      </p>
    </VerificationShell>
  );
}

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div className="flex justify-between gap-4 border-b border-border pb-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-semibold">{value}</dd>
    </div>
  );
}

export function VerificationShell({
  tone,
  title,
  lead,
  children,
}: {
  tone: "ok" | "bad" | "warn";
  title: string;
  lead: string;
  children?: ReactNode;
}) {
  const Icon = tone === "ok" ? BadgeCheck : tone === "warn" ? AlertTriangle : ShieldAlert;
  const color =
    tone === "ok" ? "text-emerald-600" : tone === "warn" ? "text-amber-600" : "text-destructive";
  return (
    <div className="site grid min-h-screen place-items-center bg-background px-4 py-10">
      <main className="w-full max-w-md rounded-2xl border border-border bg-card p-8 text-center shadow-sm">
        <img src={logoImage} alt="CannaPlug" className="mx-auto mb-6 h-6 w-auto" />
        <Icon className={`mx-auto ${color}`} size={44} aria-hidden />
        <h1 className={`mt-3 font-display text-2xl font-extrabold uppercase ${color}`}>{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{lead}</p>
        {children}
      </main>
    </div>
  );
}
