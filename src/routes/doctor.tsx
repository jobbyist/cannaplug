import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ClipboardCheck,
  FileText,
  History,
  LayoutDashboard,
  Pill,
  ScrollText,
  ShieldCheck,
  Signature,
  UserRound,
  Users,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DashboardSidebar, type SidebarItem } from "@/components/dashboard/Sidebar";
import { DocumentEditor, type EditorTarget } from "@/components/clinical/DocumentEditor";
import { TemplatesPanel } from "@/components/clinical/TemplatesPanel";
import { ReviewDialog } from "@/components/clinical/ReviewDialog";
import {
  Notice,
  StatusBadge,
  errorText,
  selectClass,
  when,
  whenTime,
} from "@/components/clinical/shared";
import { useAuth } from "@/hooks/useAuth";
import {
  getDoctorHomeFn,
  listDoctorAuditFn,
  listDoctorDocumentsFn,
  listPatientsFn,
  listTemplatesFn,
  signingOptionsFn,
  updateDoctorProfileFn,
} from "@/lib/clinical/clinical.functions";
import type {
  DoctorDocumentRow,
  DoctorProfileRow,
  DoctorView,
  EventRow,
  PatientRow,
  TemplateRow,
} from "@/lib/clinical/documents-data.server";
import { ASSURANCE_LABELS, documentTypeLabel, type DocumentType } from "@/lib/clinical/logic";
import logoImage from "@/assets/cannaplug-logo.png";

export const Route = createFileRoute("/doctor")({
  head: () => ({
    meta: [{ title: "Practitioner Portal | CannaPlug" }, { name: "robots", content: "noindex" }],
  }),
  component: DoctorPage,
});

const NAV: SidebarItem[] = [
  { id: "overview", icon: LayoutDashboard, label: "Overview" },
  { id: "patients", icon: Users, label: "Patients" },
  { id: "reviews", icon: ClipboardCheck, label: "Pending Reviews" },
  { id: "documents", icon: FileText, label: "Documents" },
  { id: "prescriptions", icon: Pill, label: "Prescriptions" },
  { id: "profile", icon: UserRound, label: "Profile" },
  { id: "templates", icon: ScrollText, label: "Templates" },
  { id: "signature", icon: Signature, label: "Signature" },
  { id: "audit", icon: History, label: "Audit" },
];

function DoctorPage() {
  const { user, loading } = useAuth();
  const [profile, setProfile] = useState<DoctorProfileRow | null | undefined>(undefined);
  const [patients, setPatients] = useState<PatientRow[]>([]);
  const [documents, setDocuments] = useState<DoctorDocumentRow[]>([]);
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [tab, setTab] = useState("overview");
  const [error, setError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorTarget | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const p = await getDoctorHomeFn();
      setProfile(p);
      if (!p || !p.is_active || p.verification_status !== "verified") return;
      const [pa, d, t, e] = await Promise.all([
        listPatientsFn(),
        listDoctorDocumentsFn(),
        listTemplatesFn(),
        listDoctorAuditFn(),
      ]);
      setPatients(pa);
      setDocuments(d);
      setTemplates(t);
      setEvents(e);
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  useEffect(() => {
    if (user) void refresh();
  }, [user, refresh]);

  if (loading) return <Centered>Loading…</Centered>;
  if (!user)
    return (
      <Centered>
        <p className="font-display text-xl font-bold uppercase">Practitioner sign-in required</p>
        <Link
          to="/account"
          className="mt-4 inline-flex rounded-full bg-primary px-5 py-2.5 text-xs font-semibold uppercase text-primary-foreground"
        >
          Sign in
        </Link>
      </Centered>
    );
  if (profile === undefined)
    return <Centered>{error ?? "Loading your practitioner profile…"}</Centered>;
  if (profile === null)
    return (
      <Centered>
        <p className="font-display text-xl font-bold uppercase">No practitioner profile</p>
        <p className="mt-2 max-w-sm text-sm text-muted-foreground">
          This account is not set up as a practitioner. A CannaPlug administrator must create your
          practitioner profile and verify your HPCSA registration.
        </p>
      </Centered>
    );

  const verified = profile.is_active && profile.verification_status === "verified";
  const pending = documents.filter((d) => d.status === "PENDING_DOCTOR_REVIEW");
  const prescriptions = documents.filter((d) => d.document_type === "PRESCRIPTION_ORDER");

  return (
    <div className="site flex min-h-screen flex-col bg-background md:flex-row">
      <DashboardSidebar
        items={NAV}
        active={tab}
        onSelect={setTab}
        header={
          <Link to="/">
            <img src={logoImage} alt="CannaPlug" className="h-6 w-auto" />
          </Link>
        }
      />
      <main className="flex-1 overflow-y-auto px-4 pb-24 pt-6 sm:px-8 sm:pt-8 md:pb-8">
        <header className="mb-6">
          <h1 className="font-display text-2xl font-extrabold uppercase">
            {NAV.find((n) => n.id === tab)?.label}
          </h1>
          <p className="text-sm text-muted-foreground">
            {profile.title} {profile.first_name} {profile.last_name} ·{" "}
            <RegistrationBadge status={profile.verification_status} />
          </p>
        </header>
        {error && <Notice tone="error">{error}</Notice>}
        {!verified && (
          <Notice tone="warn">
            Your registration is <strong>{profile.verification_status}</strong>
            {profile.is_active ? "" : " and your profile is inactive"}. You cannot create, review or
            sign documents until a CannaPlug administrator verifies your HPCSA registration.
          </Notice>
        )}

        {verified && tab === "overview" && (
          <div className="grid gap-6">
            <section className="grid grid-cols-2 gap-4 xl:grid-cols-4">
              <Stat
                label="Awaiting your review"
                value={pending.length}
                onClick={() => setTab("reviews")}
              />
              <Stat
                label="Drafts"
                value={documents.filter((d) => d.status === "DRAFT").length}
                onClick={() => setTab("documents")}
              />
              <Stat
                label="Issued"
                value={documents.filter((d) => d.status === "ISSUED").length}
                onClick={() => setTab("documents")}
              />
              <Stat label="Patients" value={patients.length} onClick={() => setTab("patients")} />
            </section>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => setEditor({ mode: "new", type: "MEDICAL_LETTER" })}>
                New medical letter
              </Button>
              <Button
                variant="outline"
                disabled={!profile.prescribing_authorised}
                onClick={() => setEditor({ mode: "new", type: "PRESCRIPTION_ORDER" })}
              >
                New prescription
              </Button>
            </div>
            {!profile.prescribing_authorised && (
              <p className="text-xs text-muted-foreground">
                You have not been authorised to issue prescriptions. An administrator records that
                after checking your scope.
              </p>
            )}
            <DocumentTable
              title="Awaiting your review"
              rows={pending}
              onOpen={setReviewing}
              empty="Nothing is waiting for review."
            />
          </div>
        )}

        {verified && tab === "patients" && (
          <section>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Patient</TableHead>
                  <TableHead>Member ID</TableHead>
                  <TableHead>Date of birth</TableHead>
                  <TableHead>Identity</TableHead>
                  <TableHead>Documents</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {patients.map((p) => (
                  <TableRow key={p.member_id}>
                    <TableCell className="font-medium">{p.full_name}</TableCell>
                    <TableCell>{p.member_ref}</TableCell>
                    <TableCell>{p.date_of_birth ?? "—"}</TableCell>
                    <TableCell>
                      {p.identity_verified ? (
                        <Badge>Verified</Badge>
                      ) : (
                        <Badge variant="outline">Not verified</Badge>
                      )}
                    </TableCell>
                    <TableCell>{p.documents}</TableCell>
                    <TableCell className="flex justify-end gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!p.identity_verified}
                        onClick={() =>
                          setEditor({ mode: "new", type: "MEDICAL_LETTER", memberId: p.member_id })
                        }
                      >
                        Letter
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!p.identity_verified || !profile.prescribing_authorised}
                        onClick={() =>
                          setEditor({
                            mode: "new",
                            type: "PRESCRIPTION_ORDER",
                            memberId: p.member_id,
                          })
                        }
                      >
                        Prescription
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {patients.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
                      No patients are assigned to you yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </section>
        )}

        {verified && tab === "reviews" && (
          <DocumentTable
            rows={pending}
            onOpen={setReviewing}
            empty="Nothing is waiting for review."
            review
          />
        )}
        {verified && tab === "documents" && (
          <DocumentTable rows={documents} onOpen={setReviewing} empty="No documents yet." />
        )}
        {verified && tab === "prescriptions" && (
          <div className="grid gap-4">
            <div>
              <Button
                disabled={!profile.prescribing_authorised}
                onClick={() => setEditor({ mode: "new", type: "PRESCRIPTION_ORDER" })}
              >
                New prescription
              </Button>
            </div>
            <DocumentTable
              rows={prescriptions}
              onOpen={setReviewing}
              empty="No prescriptions yet."
            />
          </div>
        )}
        {tab === "profile" && <ProfilePanel profile={profile} onSaved={refresh} />}
        {verified && tab === "templates" && <TemplatesPanel role="doctor" />}
        {tab === "signature" && <SignaturePanel profile={profile} />}
        {verified && tab === "audit" && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Document</TableHead>
                <TableHead>Event</TableHead>
                <TableHead>By</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((e) => (
                <TableRow key={e.id}>
                  <TableCell>{whenTime(e.created_at)}</TableCell>
                  <TableCell>{e.document_id}</TableCell>
                  <TableCell>{e.event_type.replaceAll("_", " ").toLowerCase()}</TableCell>
                  <TableCell>{e.actor_role}</TableCell>
                </TableRow>
              ))}
              {events.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-sm text-muted-foreground">
                    No activity yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}

        <DocumentEditor
          target={editor}
          patients={patients}
          templates={templates}
          canPrescribe={profile.prescribing_authorised}
          onClose={() => setEditor(null)}
          onSaved={() => void refresh()}
          onReadyForReview={(id) => {
            setEditor(null);
            setReviewing(id);
          }}
        />
        <ReviewDialog
          documentId={reviewing}
          onClose={() => setReviewing(null)}
          onChanged={() => void refresh()}
          onEditDraft={(id) => {
            setReviewing(null);
            setEditor({ mode: "edit", documentId: id });
          }}
          onNewVersion={(v: DoctorView) => {
            setReviewing(null);
            setEditor({
              mode: "new",
              type: v.document_type,
              memberId: v.member_id,
              supersedes: v.id,
            });
          }}
        />
      </main>
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

function RegistrationBadge({ status }: { status: string }) {
  return (
    <Badge
      variant={
        status === "verified" ? "default" : status === "pending" ? "secondary" : "destructive"
      }
    >
      Registration {status}
    </Badge>
  );
}

function Stat({ label, value, onClick }: { label: string; value: number; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="rounded-xl border border-border bg-card p-4 text-left transition hover:bg-muted"
    >
      <p className="text-[0.7rem] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="font-display text-3xl font-extrabold">{value}</p>
    </button>
  );
}

function DocumentTable({
  rows,
  onOpen,
  empty,
  title,
  review,
}: {
  rows: DoctorDocumentRow[];
  onOpen: (id: string) => void;
  empty: string;
  title?: string;
  review?: boolean;
}) {
  return (
    <section>
      {title && <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide">{title}</h2>}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Patient</TableHead>
            <TableHead>Document type</TableHead>
            <TableHead>Created</TableHead>
            <TableHead>Status</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id}>
              <TableCell className="font-medium">
                {r.patient ?? "—"}
                <span className="block text-[0.7rem] font-normal text-muted-foreground">
                  {r.document_id}
                </span>
              </TableCell>
              <TableCell>{documentTypeLabel(r.document_type)}</TableCell>
              <TableCell>{when(r.created_at)}</TableCell>
              <TableCell>
                <StatusBadge status={r.status} />
              </TableCell>
              <TableCell className="text-right">
                <Button
                  size="sm"
                  variant={review ? "default" : "outline"}
                  onClick={() => onOpen(r.id)}
                >
                  {review ? "Review" : "Open"}
                </Button>
              </TableCell>
            </TableRow>
          ))}
          {rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={5} className="text-center text-sm text-muted-foreground">
                {empty}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </section>
  );
}

function ProfilePanel({
  profile,
  onSaved,
}: {
  profile: DoctorProfileRow;
  onSaved: () => Promise<void>;
}) {
  const [form, setForm] = useState({
    practice_name: profile.practice_name ?? "",
    practice_address: profile.practice_address ?? "",
    practice_phone: profile.practice_phone ?? "",
    practice_email: profile.practice_email ?? "",
  });
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setError(null);
    setNotice(null);
    try {
      await updateDoctorProfileFn({ data: form });
      setNotice("Profile saved.");
      await onSaved();
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <div className="grid max-w-2xl gap-4">
      {error && <Notice tone="error">{error}</Notice>}
      {notice && <Notice tone="ok">{notice}</Notice>}
      <dl className="grid grid-cols-2 gap-3 text-sm">
        {[
          ["Name", `${profile.title} ${profile.first_name} ${profile.last_name}`],
          ["HPCSA number", profile.hpcsa_number ?? "—"],
          ["Practice number", profile.practice_number ?? "—"],
          ["Qualification", profile.qualification ?? "—"],
          ["Speciality", profile.speciality ?? "—"],
          ["Prescribing", profile.prescribing_authorised ? "Authorised" : "Not authorised"],
        ].map(([k, v]) => (
          <div key={k}>
            <dt className="text-[0.65rem] font-semibold uppercase tracking-wide text-muted-foreground">
              {k}
            </dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-muted-foreground">
        Registration details are maintained and verified by a CannaPlug administrator. Contact
        details below can be updated by you.
      </p>
      {(["practice_name", "practice_address", "practice_phone", "practice_email"] as const).map(
        (k) => (
          <div key={k}>
            <Label htmlFor={`p-${k}`}>{k.replace("practice_", "Practice ")}</Label>
            <Input
              id={`p-${k}`}
              value={form[k]}
              onChange={(e) => setForm({ ...form, [k]: e.target.value })}
            />
          </div>
        ),
      )}
      <div>
        <Button onClick={() => void save()}>Save contact details</Button>
      </div>
    </div>
  );
}

function SignaturePanel({ profile }: { profile: DoctorProfileRow }) {
  const [type, setType] = useState<DocumentType>("MEDICAL_LETTER");
  const [data, setData] = useState<Awaited<ReturnType<typeof signingOptionsFn>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setData(null);
    signingOptionsFn({ data: { type } }).then(setData, (e) => setError(errorText(e)));
  }, [type]);
  const state = useMemo(() => (data ? data.options : []), [data]);
  return (
    <div className="grid max-w-2xl gap-4">
      {error && <Notice tone="error">{error}</Notice>}
      <div className="text-sm">
        <p>
          <ShieldCheck className="mr-1 inline" size={14} /> Signature enrolment:{" "}
          <strong>{profile.signature_status.replace("_", " ")}</strong>
          {profile.signature_provider ? ` (${profile.signature_provider})` : ""}
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          Documents are signed individually, only after you approve the exact document. A stored
          signature image is never reused. The signature level used for each document type is a
          compliance decision recorded by an administrator.
        </p>
      </div>
      <div className="max-w-xs">
        <Label htmlFor="sig-type">Document type</Label>
        <select
          id="sig-type"
          className={selectClass}
          value={type}
          onChange={(e) => setType(e.target.value as DocumentType)}
        >
          <option value="MEDICAL_LETTER">Medical letter</option>
          <option value="PRESCRIPTION_ORDER">Prescription / order</option>
        </select>
      </div>
      {data && (
        <div className="rounded-lg border border-border p-4 text-sm">
          <p>
            Required level: <strong>{ASSURANCE_LABELS[data.required]}</strong>{" "}
            {data.policyConfirmed ? (
              ""
            ) : (
              <Badge variant="destructive">not confirmed by compliance</Badge>
            )}
          </p>
          <ul className="mt-3 space-y-2">
            {state.map((o) => (
              <li key={o.provider} className="flex flex-wrap items-center gap-2">
                <Badge variant={o.usable ? "default" : "outline"}>
                  {o.usable ? "Available" : "Unavailable"}
                </Badge>
                <span>
                  {o.displayName} — {ASSURANCE_LABELS[o.assurance]}
                </span>
                {o.reason && <span className="text-xs text-muted-foreground">({o.reason})</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
