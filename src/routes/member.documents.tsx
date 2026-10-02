import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Download, Eye, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MemberRequests } from "@/components/clinical/MemberRequests";
import { Notice, StatusBadge, errorText, when } from "@/components/clinical/shared";
import { useAuth } from "@/hooks/useAuth";
import { listMemberDocumentsFn, openDocumentFn } from "@/lib/clinical/clinical.functions";
import type { MemberDocumentRow } from "@/lib/clinical/documents-data.server";
import logoImage from "@/assets/cannaplug-logo.png";

export const Route = createFileRoute("/member/documents")({
  head: () => ({
    meta: [{ title: "My documents | CannaPlug" }, { name: "robots", content: "noindex" }],
  }),
  component: MemberDocumentsPage,
});

const SECTIONS: { title: string; match: (d: MemberDocumentRow) => boolean }[] = [
  { title: "Medical letters", match: (d) => d.document_type === "MEDICAL_LETTER" },
  { title: "Prescriptions / orders", match: (d) => d.document_type === "PRESCRIPTION_ORDER" },
  {
    title: "Other clinical documents",
    match: (d) => d.document_type !== "MEDICAL_LETTER" && d.document_type !== "PRESCRIPTION_ORDER",
  },
];

function MemberDocumentsPage() {
  const { user, loading } = useAuth();
  const [docs, setDocs] = useState<MemberDocumentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<"documents" | "requests">("documents");

  const load = useCallback(async () => {
    try {
      setDocs(await listMemberDocumentsFn());
    } catch (err) {
      setError(errorText(err));
    }
  }, []);
  useEffect(() => {
    if (user) void load();
  }, [user, load]);

  // The file is opened through a short-lived signed URL minted after the access is audited. Members can
  // view and download their own documents; they can never regenerate or modify one.
  const open = async (doc: MemberDocumentRow, kind: "VIEWED" | "DOWNLOADED") => {
    setBusy(`${doc.id}:${kind}`);
    setError(null);
    const tab = kind === "VIEWED" ? window.open("about:blank", "_blank") : null;
    try {
      const { url } = await openDocumentFn({ data: { documentId: doc.id, kind } });
      if (kind === "VIEWED") {
        if (tab) {
          tab.opener = null;
          tab.location.href = url;
        } else window.location.assign(url);
      } else window.location.assign(url);
    } catch (err) {
      tab?.close();
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <Centered>Loading…</Centered>;
  if (!user)
    return (
      <Centered>
        <p className="font-display text-xl font-bold uppercase">Sign in to see your documents</p>
        <Link
          to="/account"
          className="mt-4 inline-flex rounded-full bg-primary px-5 py-2.5 text-xs font-semibold uppercase text-primary-foreground"
        >
          Sign in
        </Link>
      </Centered>
    );

  return (
    <div className="site min-h-screen bg-background">
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <header className="mb-8 flex items-center justify-between">
          <Link to="/">
            <img src={logoImage} alt="CannaPlug" className="h-6 w-auto" />
          </Link>
          <Link to="/account" className="text-xs font-semibold uppercase text-primary">
            Back to my account
          </Link>
        </header>
        <h1 className="font-display text-3xl font-extrabold uppercase">My documents</h1>
        <p className="mb-4 text-sm text-muted-foreground">
          Documents issued to you by your practitioner, and requests for new ones. Only you can open
          them.
        </p>
        <div role="tablist" aria-label="Documents and requests" className="mb-6 flex gap-2">
          {(["documents", "requests"] as const).map((t) => (
            <Button
              key={t}
              role="tab"
              aria-selected={tab === t}
              size="sm"
              variant={tab === t ? "default" : "outline"}
              onClick={() => setTab(t)}
            >
              {t === "documents" ? "My documents" : "Requests"}
            </Button>
          ))}
        </div>
        {tab === "requests" && <MemberRequests onFulfilled={() => void load()} />}
        {tab === "documents" && error && <Notice tone="error">{error}</Notice>}
        {tab === "documents" && docs === null && !error && (
          <p className="text-sm text-muted-foreground">Loading your documents…</p>
        )}
        {tab === "documents" && docs?.length === 0 && (
          <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            You don&apos;t have any documents yet.
          </p>
        )}
        {tab === "documents" &&
          docs &&
          docs.length > 0 &&
          SECTIONS.map((s) => {
            const rows = docs.filter(s.match);
            if (rows.length === 0) return null;
            return (
              <section key={s.title} className="mb-8">
                <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide">{s.title}</h2>
                <ul className="grid gap-3">
                  {rows.map((d) => {
                    const available = d.status === "ISSUED" || d.status === "EXPIRED";
                    return (
                      <li key={d.id} className="rounded-xl border border-border bg-card p-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="font-semibold">{d.document_id}</p>
                          <StatusBadge status={d.status} />
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {d.practitioner} · Issued {when(d.issued_at)}
                          {d.expires_at ? ` · Valid until ${when(d.expires_at)}` : ""}
                        </p>
                        {d.status === "REVOKED" && (
                          <p className="mt-2 text-xs text-destructive">
                            This document has been revoked and can no longer be opened. Contact
                            CannaPlug if you have questions.
                          </p>
                        )}
                        <div className="mt-3 flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!available || busy !== null}
                            onClick={() => void open(d, "VIEWED")}
                          >
                            <Eye size={14} className="mr-1" />
                            View
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!available || busy !== null}
                            onClick={() => void open(d, "DOWNLOADED")}
                          >
                            <Download size={14} className="mr-1" />
                            Download
                          </Button>
                          <Button size="sm" variant="ghost" asChild>
                            <a
                              href={`/verify/${d.verification_token}`}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              <ShieldCheck size={14} className="mr-1" />
                              Verification
                            </a>
                          </Button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
      </div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center bg-background px-6 text-center">
      <div>{children}</div>
    </div>
  );
}
