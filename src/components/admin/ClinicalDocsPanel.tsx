import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
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
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TemplatesPanel } from "@/components/clinical/TemplatesPanel";
import {
  Notice,
  StatusBadge,
  errorText,
  selectClass,
  when,
  whenTime,
} from "@/components/clinical/shared";
import {
  adminAssignPatientFn,
  adminListDocumentsFn,
  adminListEventsFn,
  adminOverviewFn,
  adminSaveDoctorFn,
  adminSearchMembersFn,
  adminSetDoctorStatusFn,
  adminSetPolicyFn,
  adminSetProviderFn,
  revokeDocumentFn,
} from "@/lib/clinical/clinical.functions";
import type {
  AdminDocumentRow,
  DoctorProfileRow,
  EventRow,
} from "@/lib/clinical/documents-data.server";
import {
  ASSURANCE_LABELS,
  documentTypeLabel,
  type AssuranceLevel,
  type DocumentType,
} from "@/lib/clinical/logic";

/**
 * Administrative oversight of clinical documents. Administrators configure the system and can revoke an
 * issued document (audited as an administrator action). They cannot create, edit, approve or sign a
 * document, and they cannot read clinical content: this panel only ever receives operational metadata.
 */

type Overview = Awaited<ReturnType<typeof adminOverviewFn>>;
const SECTIONS = ["Doctors", "Templates", "Documents", "Signatures", "Audit", "Retention"] as const;
type Section = (typeof SECTIONS)[number];

export function ClinicalDocsPanel() {
  const [section, setSection] = useState<Section>("Doctors");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [docs, setDocs] = useState<AdminDocumentRow[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [o, d, e] = await Promise.all([
        adminOverviewFn(),
        adminListDocumentsFn({ data: {} }),
        adminListEventsFn(),
      ]);
      setOverview(o);
      setDocs(d);
      setEvents(e);
    } catch (err) {
      setError(errorText(err));
    }
  }, []);
  useEffect(() => void load(), [load]);

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(done);
      await load();
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    }
  };

  return (
    <div className="grid gap-5">
      <div>
        <h1 className="font-display text-2xl font-extrabold uppercase">Clinical documents</h1>
        <p className="text-sm text-muted-foreground">
          Practitioners, approved templates, signature policy and oversight. Clinical content is
          never shown here.
        </p>
      </div>
      <nav className="flex flex-wrap gap-2" aria-label="Clinical documents sections">
        {SECTIONS.map((s) => (
          <Button
            key={s}
            size="sm"
            variant={section === s ? "default" : "outline"}
            onClick={() => setSection(s)}
          >
            {s}
          </Button>
        ))}
      </nav>
      {error && <Notice tone="error">{error}</Notice>}
      {notice && <Notice tone="ok">{notice}</Notice>}

      {section === "Doctors" && overview && <DoctorsSection overview={overview} act={act} />}
      {section === "Templates" && <TemplatesPanel role="admin" />}
      {section === "Documents" && <DocumentsSection rows={docs} act={act} />}
      {section === "Signatures" && overview && <SignaturesSection overview={overview} act={act} />}
      {section === "Audit" && overview && (
        <AuditSection events={events} verifications={overview.verifications} />
      )}
      {section === "Retention" && overview && <RetentionSection rows={overview.retention} />}
    </div>
  );
}

type Act = (fn: () => Promise<unknown>, done: string) => Promise<boolean>;

// ------------------------------------------------------------------ doctors

function DoctorsSection({ overview, act }: { overview: Overview; act: Act }) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<DoctorProfileRow | null>(null);
  const [statusFor, setStatusFor] = useState<DoctorProfileRow | null>(null);
  const [patientsFor, setPatientsFor] = useState<DoctorProfileRow | null>(null);
  return (
    <section className="grid gap-4">
      <div>
        <Button onClick={() => setAdding(true)}>Add practitioner</Button>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Practitioner</TableHead>
            <TableHead>HPCSA no.</TableHead>
            <TableHead>Registration</TableHead>
            <TableHead>Prescribing</TableHead>
            <TableHead>Signature</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {overview.doctors.map((d) => (
            <TableRow key={d.id}>
              <TableCell className="font-medium">
                {d.title} {d.first_name} {d.last_name}
                {!d.is_active && (
                  <Badge variant="outline" className="ml-2">
                    inactive
                  </Badge>
                )}
              </TableCell>
              <TableCell>{d.hpcsa_number ?? "—"}</TableCell>
              <TableCell>
                <Badge
                  variant={
                    d.verification_status === "verified"
                      ? "default"
                      : d.verification_status === "pending"
                        ? "secondary"
                        : "destructive"
                  }
                >
                  {d.verification_status}
                </Badge>
              </TableCell>
              <TableCell>{d.prescribing_authorised ? "Authorised" : "No"}</TableCell>
              <TableCell>
                {d.signature_status.replace("_", " ")}
                {d.signature_provider ? ` · ${d.signature_provider}` : ""}
              </TableCell>
              <TableCell className="flex flex-wrap justify-end gap-1">
                <Button size="sm" variant="outline" onClick={() => setEditing(d)}>
                  Edit
                </Button>
                <Button size="sm" variant="outline" onClick={() => setStatusFor(d)}>
                  Verification
                </Button>
                <Button size="sm" variant="outline" onClick={() => setPatientsFor(d)}>
                  Patients
                </Button>
              </TableCell>
            </TableRow>
          ))}
          {overview.doctors.length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
                No practitioners yet.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      <p className="text-xs text-muted-foreground">
        A registration number is only text until it has been checked against the HPCSA register.
        Another administrator must verify you if you are also a practitioner.
      </p>
      <DoctorForm open={adding} onClose={() => setAdding(false)} existing={null} act={act} />
      <DoctorForm
        open={editing !== null}
        onClose={() => setEditing(null)}
        existing={editing}
        act={act}
      />
      <StatusDialog
        doctor={statusFor}
        providers={overview.providers.map((p) => p.provider)}
        onClose={() => setStatusFor(null)}
        act={act}
      />
      <PatientsDialog doctor={patientsFor} onClose={() => setPatientsFor(null)} act={act} />
    </section>
  );
}

const DOCTOR_FIELDS = [
  ["title", "Title"],
  ["first_name", "First name"],
  ["last_name", "Last name"],
  ["hpcsa_number", "HPCSA registration number"],
  ["practice_number", "Practice number"],
  ["qualification", "Qualification"],
  ["speciality", "Speciality"],
  ["practice_name", "Practice name"],
  ["practice_address", "Practice address"],
  ["practice_phone", "Practice phone"],
  ["practice_email", "Practice email"],
] as const;

function DoctorForm({
  open,
  onClose,
  existing,
  act,
}: {
  open: boolean;
  onClose: () => void;
  existing: DoctorProfileRow | null;
  act: Act;
}) {
  const [form, setForm] = useState<Record<string, string>>({});
  const [memberQuery, setMemberQuery] = useState("");
  const [members, setMembers] = useState<{ id: string; full_name: string | null }[]>([]);
  const [userId, setUserId] = useState("");
  useEffect(() => {
    if (!open) return;
    setForm(
      existing
        ? Object.fromEntries(
            DOCTOR_FIELDS.map(([k]) => [
              k,
              String((existing as unknown as Record<string, string | null>)[k] ?? ""),
            ]),
          )
        : { title: "Dr" },
    );
    setUserId(existing?.user_id ?? "");
    setMemberQuery("");
    setMembers([]);
  }, [open, existing]);
  const search = async () =>
    setMembers(await adminSearchMembersFn({ data: { query: memberQuery } }).catch(() => []));
  const save = async () => {
    const data = Object.fromEntries(
      Object.entries(form)
        .filter(
          ([k, v]) =>
            v.trim() !== "" ||
            (existing &&
              DOCTOR_FIELDS.some(([f]) => f === k) &&
              (existing as unknown as Record<string, string | null>)[k]),
        )
        .map(([k, v]) => [k, v.trim() === "" ? null : v.trim()]),
    );
    if (
      await act(
        () => adminSaveDoctorFn({ data: { userId, ...data } as never }),
        "Practitioner saved. Changing registration details resets verification to pending.",
      )
    )
      onClose();
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{existing ? "Edit practitioner" : "Add practitioner"}</DialogTitle>
          <DialogDescription>
            The practitioner signs in with their own CannaPlug account.
          </DialogDescription>
        </DialogHeader>
        {!existing && (
          <div className="grid gap-2">
            <Label htmlFor="d-search">Find their account by name</Label>
            <div className="flex gap-2">
              <Input
                id="d-search"
                value={memberQuery}
                onChange={(e) => setMemberQuery(e.target.value)}
              />
              <Button variant="outline" onClick={() => void search()}>
                Search
              </Button>
            </div>
            <select
              className={selectClass}
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              aria-label="Account"
            >
              <option value="">Select account…</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.full_name ?? m.id}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          {DOCTOR_FIELDS.map(([k, label]) => (
            <div key={k}>
              <Label htmlFor={`df-${k}`}>{label}</Label>
              <Input
                id={`df-${k}`}
                value={form[k] ?? ""}
                onChange={(e) => setForm({ ...form, [k]: e.target.value })}
              />
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!userId} onClick={() => void save()}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StatusDialog({
  doctor,
  providers,
  onClose,
  act,
}: {
  doctor: DoctorProfileRow | null;
  providers: string[];
  onClose: () => void;
  act: Act;
}) {
  const [status, setStatus] = useState("pending");
  const [note, setNote] = useState("");
  const [prescribing, setPrescribing] = useState(false);
  const [sigStatus, setSigStatus] = useState("not_enrolled");
  const [provider, setProvider] = useState("");
  const [ref, setRef] = useState("");
  useEffect(() => {
    if (!doctor) return;
    setStatus(doctor.verification_status);
    setPrescribing(doctor.prescribing_authorised);
    setSigStatus(doctor.signature_status);
    setProvider(doctor.signature_provider ?? "");
    setNote("");
    setRef("");
  }, [doctor]);
  return (
    <Dialog open={doctor !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Verification — {doctor?.title} {doctor?.first_name} {doctor?.last_name}
          </DialogTitle>
          <DialogDescription>
            Mark a practitioner verified only after checking their registration number on the HPCSA
            register. Prescribing authorisation is separate and explicit.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div>
            <Label htmlFor="st">Registration status</Label>
            <select
              id="st"
              className={selectClass}
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              {["pending", "verified", "suspended", "revoked"].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={prescribing}
              disabled={status !== "verified"}
              onCheckedChange={(v) => setPrescribing(v === true)}
            />{" "}
            Authorised to issue prescriptions
          </label>
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <Label htmlFor="ss">Signature enrolment</Label>
              <select
                id="ss"
                className={selectClass}
                value={sigStatus}
                onChange={(e) => setSigStatus(e.target.value)}
              >
                {["not_enrolled", "enrolled", "suspended"].map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="sp">Provider</Label>
              <select
                id="sp"
                className={selectClass}
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
              >
                <option value="">—</option>
                {providers.map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="sr">Provider reference</Label>
              <Input id="sr" value={ref} onChange={(e) => setRef(e.target.value)} />
            </div>
          </div>
          <div>
            <Label htmlFor="sn">Note</Label>
            <Textarea
              id="sn"
              rows={2}
              maxLength={500}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={async () =>
              doctor &&
              (await act(
                () =>
                  adminSetDoctorStatusFn({
                    data: {
                      doctorId: doctor.id,
                      status: status as "pending",
                      note: note || null,
                      prescribing,
                      signatureStatus: sigStatus as "enrolled",
                      signatureProvider: provider || null,
                      signatureProviderRef: ref || null,
                    },
                  }),
                "Practitioner updated.",
              )) &&
              onClose()
            }
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PatientsDialog({
  doctor,
  onClose,
  act,
}: {
  doctor: DoctorProfileRow | null;
  onClose: () => void;
  act: Act;
}) {
  const [query, setQuery] = useState("");
  const [members, setMembers] = useState<{ id: string; full_name: string | null }[]>([]);
  useEffect(() => {
    setQuery("");
    setMembers([]);
  }, [doctor]);
  return (
    <Dialog open={doctor !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Assign patients — {doctor?.first_name} {doctor?.last_name}
          </DialogTitle>
          <DialogDescription>
            A practitioner can only create documents for members assigned to them. Assignment shows
            them the member&apos;s name and date of birth.
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          <Input
            aria-label="Member name"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Member name"
          />
          <Button
            variant="outline"
            onClick={async () =>
              setMembers(await adminSearchMembersFn({ data: { query } }).catch(() => []))
            }
          >
            Search
          </Button>
        </div>
        <ul className="grid max-h-64 gap-2 overflow-y-auto">
          {members.map((m) => (
            <li
              key={m.id}
              className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm"
            >
              <span>{m.full_name ?? m.id}</span>
              <span className="flex gap-1">
                <Button
                  size="sm"
                  onClick={() =>
                    doctor &&
                    void act(
                      () =>
                        adminAssignPatientFn({
                          data: { doctorId: doctor.id, memberId: m.id, assign: true },
                        }),
                      "Patient assigned.",
                    )
                  }
                >
                  Assign
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    doctor &&
                    void act(
                      () =>
                        adminAssignPatientFn({
                          data: { doctorId: doctor.id, memberId: m.id, assign: false },
                        }),
                      "Assignment ended.",
                    )
                  }
                >
                  End
                </Button>
              </span>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ documents

function DocumentsSection({ rows, act }: { rows: AdminDocumentRow[]; act: Act }) {
  const [revoking, setRevoking] = useState<AdminDocumentRow | null>(null);
  const [reason, setReason] = useState("");
  return (
    <section className="grid gap-3">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Document</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Practitioner</TableHead>
            <TableHead>Member</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Signature</TableHead>
            <TableHead>Issued</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id}>
              <TableCell className="font-medium">
                {r.document_id}
                <span className="block text-[0.7rem] font-normal text-muted-foreground">
                  template v{r.template_version} · doc v{r.document_version}
                </span>
              </TableCell>
              <TableCell>{documentTypeLabel(r.document_type)}</TableCell>
              <TableCell>{r.practitioner}</TableCell>
              <TableCell>{r.member_ref}</TableCell>
              <TableCell>
                <StatusBadge status={r.status} />
                {r.revocation_reason && (
                  <span className="block text-[0.7rem] text-muted-foreground">
                    {r.revocation_reason}
                  </span>
                )}
              </TableCell>
              <TableCell>
                {r.signature_status
                  ? `${r.signature_status.toLowerCase()}${r.assurance ? ` · ${r.assurance.toLowerCase()}` : ""}`
                  : "—"}
              </TableCell>
              <TableCell>{when(r.issued_at)}</TableCell>
              <TableCell className="text-right">
                {["SIGNED", "ISSUED", "EXPIRED"].includes(r.status) && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setRevoking(r);
                      setReason("");
                    }}
                  >
                    Revoke
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
          {rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={8} className="text-center text-sm text-muted-foreground">
                No documents yet.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      <p className="text-xs text-muted-foreground">
        Administrators cannot open, edit, approve or sign documents. Revocation is recorded in the
        audit trail as an administrator action.
      </p>
      <Dialog open={revoking !== null} onOpenChange={(o) => !o && setRevoking(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke {revoking?.document_id}</DialogTitle>
            <DialogDescription>
              The document will immediately verify as revoked and the member can no longer open it.
              This cannot be undone; the practitioner can issue a corrected version.
            </DialogDescription>
          </DialogHeader>
          <Label htmlFor="rv">Reason</Label>
          <Textarea
            id="rv"
            rows={3}
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevoking(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={reason.trim().length < 3}
              onClick={async () =>
                revoking &&
                (await act(
                  () => revokeDocumentFn({ data: { documentId: revoking.id, reason } }),
                  "Document revoked.",
                )) &&
                setRevoking(null)
              }
            >
              Revoke
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

// ------------------------------------------------------------------ signatures

function SignaturesSection({ overview, act }: { overview: Overview; act: Act }) {
  const [provider, setProvider] = useState<Overview["providers"][number] | null>(null);
  const [policy, setPolicy] = useState<Overview["policy"][number] | null>(null);
  return (
    <section className="grid gap-6">
      <Notice tone="warn">
        These settings record compliance decisions. A method must only be recorded as advanced or
        qualified after the practitioner, compliance advisor or legal counsel has confirmed that the
        actual provider and method satisfy the applicable South African requirements. Prescriptions
        can never be signed with a simple electronic signature. Nothing is usable until it has been
        confirmed here.
      </Notice>
      <div>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide">
          Required level per document type
        </h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Document</TableHead>
              <TableHead>Required</TableHead>
              <TableHead>Confirmed</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {overview.policy.map((p) => (
              <TableRow key={p.document_type}>
                <TableCell>{documentTypeLabel(p.document_type)}</TableCell>
                <TableCell>{ASSURANCE_LABELS[p.required_assurance]}</TableCell>
                <TableCell>
                  {p.confirmed_at ? (
                    <>
                      <Badge>confirmed</Badge>{" "}
                      <span className="text-xs text-muted-foreground">{p.confirmation_note}</span>
                    </>
                  ) : (
                    <Badge variant="destructive">not confirmed</Badge>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <Button size="sm" variant="outline" onClick={() => setPolicy(p)}>
                    Set
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide">Signature methods</h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Method</TableHead>
              <TableHead>Recorded level</TableHead>
              <TableHead>Enabled</TableHead>
              <TableHead>Confirmation</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {overview.providers.map((p) => (
              <TableRow key={p.provider}>
                <TableCell className="font-medium">
                  {p.display_name}
                  <span className="block text-[0.7rem] font-normal text-muted-foreground">
                    {p.provider}
                  </span>
                </TableCell>
                <TableCell>{ASSURANCE_LABELS[p.assurance_level]}</TableCell>
                <TableCell>
                  {p.enabled ? <Badge>enabled</Badge> : <Badge variant="outline">disabled</Badge>}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {p.confirmed_at
                    ? `${whenTime(p.confirmed_at)} — ${p.confirmation_note ?? ""}`
                    : "—"}
                </TableCell>
                <TableCell className="text-right">
                  <Button size="sm" variant="outline" onClick={() => setProvider(p)}>
                    Configure
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ConfirmDialog
        open={provider !== null}
        title={`Configure ${provider?.display_name ?? ""}`}
        initial={provider?.assurance_level ?? "SIMPLE"}
        showEnabled
        enabledInitial={provider?.enabled ?? false}
        onClose={() => setProvider(null)}
        onSave={async (level, enabled, note) =>
          provider &&
          (await act(
            () =>
              adminSetProviderFn({
                data: { provider: provider.provider, assurance: level, enabled, note },
              }),
            "Signature method updated.",
          )) &&
          setProvider(null)
        }
      />
      <ConfirmDialog
        open={policy !== null}
        title={`Required signature level — ${policy ? documentTypeLabel(policy.document_type) : ""}`}
        initial={policy?.required_assurance ?? "SIMPLE"}
        minLevel={policy?.document_type === "PRESCRIPTION_ORDER" ? "ADVANCED" : "SIMPLE"}
        onClose={() => setPolicy(null)}
        onSave={async (level, _e, note) =>
          policy &&
          (await act(
            () =>
              adminSetPolicyFn({
                data: { type: policy.document_type as DocumentType, required: level, note },
              }),
            "Signature requirement recorded.",
          )) &&
          setPolicy(null)
        }
      />
    </section>
  );
}

function ConfirmDialog({
  open,
  title,
  initial,
  minLevel,
  showEnabled,
  enabledInitial,
  onClose,
  onSave,
}: {
  open: boolean;
  title: string;
  initial: AssuranceLevel;
  minLevel?: AssuranceLevel;
  showEnabled?: boolean;
  enabledInitial?: boolean;
  onClose: () => void;
  onSave: (level: AssuranceLevel, enabled: boolean, note: string) => unknown;
}) {
  const [level, setLevel] = useState<AssuranceLevel>(initial);
  const [enabled, setEnabled] = useState(false);
  const [note, setNote] = useState("");
  useEffect(() => {
    setLevel(initial);
    setEnabled(enabledInitial ?? false);
    setNote("");
  }, [open, initial, enabledInitial]);
  const levels = (["SIMPLE", "ADVANCED", "QUALIFIED"] as const).filter(
    (l) => minLevel !== "ADVANCED" || l !== "SIMPLE",
  );
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Record who confirmed this (practitioner, compliance advisor or counsel), when, and the
            basis. This is stored with your name.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div>
            <Label htmlFor="cl">Level</Label>
            <select
              id="cl"
              className={selectClass}
              value={level}
              onChange={(e) => setLevel(e.target.value as AssuranceLevel)}
            >
              {levels.map((l) => (
                <option key={l} value={l}>
                  {ASSURANCE_LABELS[l]}
                </option>
              ))}
            </select>
          </div>
          {showEnabled && (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={enabled} onCheckedChange={(v) => setEnabled(v === true)} /> Enabled
              for signing
            </label>
          )}
          <div>
            <Label htmlFor="cn">Confirmation (who, when, basis)</Label>
            <Textarea
              id="cn"
              rows={3}
              maxLength={1000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={note.trim().length < 10 && (enabled || level !== "SIMPLE" || !showEnabled)}
            onClick={() => void onSave(level, enabled, note)}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ audit + retention

function AuditSection({
  events,
  verifications,
}: {
  events: EventRow[];
  verifications: Overview["verifications"];
}) {
  return (
    <section className="grid gap-6">
      <div>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide">
          Document events (append-only)
        </h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Document</TableHead>
              <TableHead>Event</TableHead>
              <TableHead>By</TableHead>
              <TableHead>Address</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {events.map((e) => (
              <TableRow key={e.id}>
                <TableCell>{whenTime(e.created_at)}</TableCell>
                <TableCell>{e.document_id}</TableCell>
                <TableCell>{e.event_type.replaceAll("_", " ").toLowerCase()}</TableCell>
                <TableCell>{e.actor_role}</TableCell>
                <TableCell>{e.ip_address ?? "—"}</TableCell>
              </TableRow>
            ))}
            {events.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-sm text-muted-foreground">
                  No events yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <div>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide">Public verifications</h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Result</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {verifications.map((v, i) => (
              <TableRow key={`${v.document_id}-${i}`}>
                <TableCell>{whenTime(v.verified_at)}</TableCell>
                <TableCell>{v.verification_status}</TableCell>
              </TableRow>
            ))}
            {verifications.length === 0 && (
              <TableRow>
                <TableCell colSpan={2} className="text-center text-sm text-muted-foreground">
                  No verifications yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

function RetentionSection({ rows }: { rows: Overview["retention"] }) {
  return (
    <section className="grid gap-3">
      <Notice tone="warn">
        These retention periods are proposals awaiting confirmation by the practitioner and legal
        counsel. The system never deletes clinical records: revocation is not deletion, and no purge
        function exists.
      </Notice>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Record class</TableHead>
            <TableHead>Proposed minimum (years)</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Basis</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.record_class}>
              <TableCell className="font-medium">{r.record_class.replaceAll("_", " ")}</TableCell>
              <TableCell>{r.proposed_min_years}</TableCell>
              <TableCell>
                <Badge variant="secondary">{r.status.toLowerCase()}</Badge>
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">{r.basis}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}
