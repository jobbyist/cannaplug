import logo from "@/assets/cannaplug-logo.png";
import {
  WAIVER_ABOUT_INTRO,
  WAIVER_CLAUSES,
  WAIVER_FOOTER,
  WAIVER_INTRO,
  WAIVER_POPIA,
  WAIVER_RISKS,
  WAIVER_TITLE,
  conditionLabel,
  declineLabel,
} from "@/lib/waiver-text";
import type { WaiverRecord } from "@/lib/waiver-data.server";

type Business = {
  trading_name: string;
  legal_name: string;
  address: string;
  phone: string | null;
  email: string | null;
};

const sast = (iso: string) =>
  new Date(iso).toLocaleString("en-ZA", {
    timeZone: "Africa/Johannesburg",
    dateStyle: "medium",
    timeStyle: "short",
  });

const yn = (v: boolean) => (v ? "Yes" : "No");

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex gap-2 border-b border-[#E5E7EB] py-1">
      <span className="w-44 shrink-0 text-[#6B7280]">{label}</span>
      <span className="font-medium">{value || "—"}</span>
    </div>
  );
}

function H({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-1 mt-4 border-b-2 border-[#16A34A] pb-0.5 text-[11px] font-bold uppercase tracking-wide text-[#0B3D20]">
      {children}
    </h2>
  );
}

/** The signed waiver as a branded A4 page. Managers and admins only (the data call enforces it). */
export function WaiverView({
  waiver,
  business,
}: {
  waiver: WaiverRecord;
  business: Business | null;
}) {
  const s = waiver.screening;
  return (
    <article
      data-testid="waiver"
      className="mx-auto w-[180mm] bg-white text-[11px] leading-snug text-[#111111]"
      style={{ fontFamily: "Inter, Arial, sans-serif" }}
    >
      <header className="text-center">
        <img src={logo} alt="Cannaplug" className="mx-auto mb-1 w-40" />
        {business && (
          <p className="text-[10px] text-[#6B7280]">
            {business.legal_name} · {business.address}
          </p>
        )}
        <h1 className="mt-2 text-sm font-bold uppercase text-[#0B3D20]">{WAIVER_TITLE}</h1>
        <p
          className={`mt-1 inline-block rounded px-2 py-0.5 text-[10px] font-bold uppercase ${
            waiver.status === "valid"
              ? "bg-[#DCFCE7] text-[#166534]"
              : "bg-[#FEE2E2] text-[#991B1B]"
          }`}
        >
          {waiver.status === "valid" ? "Valid" : "Declined"}
          {waiver.flagged ? " · Flagged" : ""}
        </p>
      </header>
      <p className="mt-2 text-[10px] text-[#374151]">{WAIVER_INTRO}</p>

      {waiver.decline_reasons.length > 0 && (
        <p className="mt-2 rounded border border-[#FCA5A5] bg-[#FEF2F2] p-1.5 text-[10px]">
          Not allowed to proceed: {waiver.decline_reasons.map(declineLabel).join("; ")}
        </p>
      )}

      <H>1. Customer details</H>
      <Row label="Full name" value={waiver.customer_name} />
      <Row label="Date of birth" value={waiver.date_of_birth} />
      <Row label="ID / passport no." value={waiver.id_number} />
      <Row label="Signed (SAST)" value={sast(waiver.signed_at)} />
      <Row label="18 or older" value={yn(waiver.age_confirmed)} />

      <H>2. Alcohol, drugs, medication &amp; medical screening</H>
      <Row
        label="Alcohol today"
        value={s.alcohol.had ? `Yes, ${s.alcohol.hours_ago ?? "?"} hour(s) ago` : "No"}
      />
      <Row
        label="Drugs in last 24 hours"
        value={s.drugs.had ? `Yes: ${s.drugs.details ?? ""}` : "No"}
      />
      <Row
        label="Medicine today"
        value={s.medication.had ? `Yes: ${s.medication.details ?? ""}` : "No"}
      />
      <Row label="Under the influence" value={yn(s.under_influence)} />
      <Row
        label="Conditions"
        value={s.conditions.length ? s.conditions.map(conditionLabel).join(", ") : "None ticked"}
      />
      {s.condition_details && <Row label="Details" value={s.condition_details} />}

      <H>3. Emergency contact</H>
      <Row label="Name" value={waiver.emergency.name} />
      <Row label="Relationship" value={waiver.emergency.relationship} />
      <Row label="Contact number" value={waiver.emergency.phone} />
      <Row label="Alt. number" value={waiver.emergency.alt_phone} />

      <H>4. About dab hits: what you are consenting to</H>
      <p>{WAIVER_ABOUT_INTRO}</p>
      <ul className="ml-4 mt-1 list-disc">
        {WAIVER_RISKS.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>

      <H>5. Assumption of risk, release &amp; indemnity</H>
      <p className="mb-1">By signing this form, I declare and agree that:</p>
      {WAIVER_CLAUSES.map(([n, t]) => (
        <p key={n} className="mb-0.5">
          <b>{n}</b> {t}
        </p>
      ))}
      <p className="mt-1 italic">{WAIVER_POPIA} (Consent given.)</p>

      <H>6. Customer signature</H>
      <Row label="Customer name" value={waiver.customer_name} />
      {waiver.signature ? (
        <img
          src={waiver.signature}
          alt="Customer signature"
          className="mt-1 h-20 rounded border border-[#E5E7EB] bg-white"
        />
      ) : (
        <p className="mt-1 text-[#6B7280]">No signature (declined before signing).</p>
      )}

      <H>7. Staff section</H>
      <Row label="Staff member" value={waiver.staff_name} />
      <Row label="Signs of intoxication or concern" value={yn(waiver.staff_noted_signs)} />
      {waiver.staff_details && <Row label="Details" value={waiver.staff_details} />}
      {waiver.incident ? (
        <>
          <Row label="Incident" value={waiver.incident.text} />
          <Row
            label="Emergency services contacted"
            value={yn(waiver.incident.emergency_services)}
          />
          <Row label="Emergency contact notified" value={yn(waiver.incident.emergency_contact)} />
          <Row label="Incident time" value={waiver.incident.time} />
          <Row label="Additional notes" value={waiver.incident.notes} />
        </>
      ) : (
        <Row label="Incident" value="None recorded" />
      )}
      <Row label="Till receipt" value={waiver.receipt_number} />
      <Row label="Kept until" value={sast(waiver.retain_until)} />

      <p className="mt-4 text-center text-[9px] text-[#6B7280]">{WAIVER_FOOTER}</p>
    </article>
  );
}
