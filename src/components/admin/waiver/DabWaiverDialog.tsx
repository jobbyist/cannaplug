import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createDabWaiverFn } from "@/lib/waiver.functions";
import {
  CONDITIONS,
  WAIVER_ABOUT_INTRO,
  WAIVER_CLAUSES,
  WAIVER_INTRO,
  WAIVER_POPIA,
  WAIVER_RISKS,
  declineLabel,
} from "@/lib/waiver-text";
import { SignaturePad } from "./SignaturePad";

export type SignedWaiver = { id: string; customerName: string };

type YesNo = "no" | "yes" | "";

function YesNoField({
  label,
  value,
  onChange,
  name,
}: {
  label: string;
  value: YesNo;
  onChange: (v: YesNo) => void;
  name: string;
}) {
  return (
    <fieldset className="space-y-1">
      <legend className="text-sm font-medium">{label}</legend>
      <div className="flex gap-4 text-sm">
        {(["no", "yes"] as const).map((v) => (
          <label key={v} className="flex items-center gap-1.5">
            <input
              type="radio"
              name={name}
              checked={value === v}
              onChange={() => onChange(v)}
              className="h-4 w-4"
            />
            {v === "yes" ? "Yes" : "No"}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");

/** Till form: the customer fills sections 1 to 6 on the tablet, then staff complete section 7. */
export function DabWaiverDialog({
  open,
  onOpenChange,
  onSigned,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSigned: (w: SignedWaiver) => void;
}) {
  const [name, setName] = useState("");
  const [dob, setDob] = useState("");
  const [idNo, setIdNo] = useState("");
  const [age, setAge] = useState(false);
  const [alcohol, setAlcohol] = useState<YesNo>("");
  const [hours, setHours] = useState("");
  const [drugs, setDrugs] = useState<YesNo>("");
  const [drugDetails, setDrugDetails] = useState("");
  const [meds, setMeds] = useState<YesNo>("");
  const [medDetails, setMedDetails] = useState("");
  const [influence, setInfluence] = useState<YesNo>("");
  const [conditions, setConditions] = useState<string[]>([]);
  const [condDetails, setCondDetails] = useState("");
  const [ecName, setEcName] = useState("");
  const [ecRel, setEcRel] = useState("");
  const [ecPhone, setEcPhone] = useState("");
  const [ecAlt, setEcAlt] = useState("");
  const [agree, setAgree] = useState(false);
  const [popia, setPopia] = useState(false);
  const [signature, setSignature] = useState<string | null>(null);
  const [signs, setSigns] = useState<YesNo>("");
  const [staffDetails, setStaffDetails] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [declined, setDeclined] = useState<string[] | null>(null);
  const [padKey, setPadKey] = useState(0);

  const toggle = (id: string) =>
    setConditions((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));

  const answered = alcohol && drugs && meds && influence && signs;
  const missing: string | null = (() => {
    if (name.trim().length < 2) return "Enter the customer's full name.";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) return "Enter the date of birth.";
    if (idNo.trim().length < 4) return "Enter the ID or passport number.";
    if (!answered) return "Answer every yes/no question, including the staff check.";
    if (alcohol === "yes" && hours.trim() === "")
      return "Say how many hours ago the last drink was.";
    if (drugs === "yes" && !drugDetails.trim()) return "Say what drugs and when.";
    if (meds === "yes" && !medDetails.trim()) return "Say which medicine.";
    if (conditions.length > 0 && !condDetails.trim())
      return "Give details of the conditions ticked.";
    if (ecName.trim().length < 2 || ecPhone.trim().length < 7)
      return "Enter an emergency contact name and number.";
    if (signs === "yes" && !staffDetails.trim()) return "Describe the signs you noted.";
    if (!age || !agree || !popia) return "The customer must tick all three confirmations.";
    if (!signature) return "The customer must sign.";
    return null;
  })();

  const reset = () => {
    setName("");
    setDob("");
    setIdNo("");
    setAge(false);
    setAlcohol("");
    setHours("");
    setDrugs("");
    setDrugDetails("");
    setMeds("");
    setMedDetails("");
    setInfluence("");
    setConditions([]);
    setCondDetails("");
    setEcName("");
    setEcRel("");
    setEcPhone("");
    setEcAlt("");
    setAgree(false);
    setPopia(false);
    setSignature(null);
    setSigns("");
    setStaffDetails("");
    setError(null);
    setDeclined(null);
    setPadKey((k) => k + 1);
  };

  const submit = async () => {
    if (missing || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await createDabWaiverFn({
        data: {
          customer_name: name.trim(),
          date_of_birth: dob,
          id_number: idNo.trim(),
          age_confirmed: age,
          popia_consent: popia,
          alcohol: { had: alcohol === "yes", hours_ago: alcohol === "yes" ? Number(hours) : null },
          drugs: { had: drugs === "yes", details: drugs === "yes" ? drugDetails.trim() : null },
          medication: { had: meds === "yes", details: meds === "yes" ? medDetails.trim() : null },
          under_influence: influence === "yes",
          conditions: conditions as (
            "asthma" | "heart" | "epilepsy" | "low_bp" | "anxiety" | "pregnant" | "other"
          )[],
          condition_details: condDetails.trim() || null,
          emergency: {
            name: ecName.trim(),
            relationship: ecRel.trim() || null,
            phone: ecPhone.trim(),
            alt_phone: ecAlt.trim() || null,
          },
          signature,
          staff_noted_signs: signs === "yes",
          staff_details: signs === "yes" ? staffDetails.trim() : null,
        },
      });
      if (res.status === "declined") {
        setDeclined(res.decline_reasons);
        return;
      }
      onSigned({ id: res.id, customerName: name.trim() });
      reset();
      onOpenChange(false);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const text = "text-sm";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto" data-testid="waiver-dialog">
        <DialogHeader>
          <DialogTitle>Dab hit waiver</DialogTitle>
          <DialogDescription>{WAIVER_INTRO}</DialogDescription>
        </DialogHeader>

        {declined ? (
          <div className="space-y-3" data-testid="waiver-declined">
            <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
              This customer cannot be served a dab hit today:{" "}
              <b>{declined.map(declineLabel).join("; ")}</b>. The waiver has been saved as declined.
              Take the dab hit off the basket and offer something else.
            </p>
            <Button
              onClick={() => {
                reset();
                onOpenChange(false);
              }}
            >
              Close
            </Button>
          </div>
        ) : (
          <div className="space-y-5">
            <section className="space-y-2">
              <h3 className="font-semibold">1. Customer details</h3>
              <Label htmlFor="w-name">Full name</Label>
              <Input
                id="w-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={120}
              />
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="w-dob">Date of birth</Label>
                  <Input
                    id="w-dob"
                    type="date"
                    value={dob}
                    onChange={(e) => setDob(e.target.value)}
                  />
                </div>
                <div>
                  <Label htmlFor="w-id">ID / passport no.</Label>
                  <Input
                    id="w-id"
                    value={idNo}
                    onChange={(e) => setIdNo(e.target.value)}
                    maxLength={40}
                  />
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={age} onCheckedChange={(v) => setAge(v === true)} />I confirm that
                I am 18 years of age or older.
              </label>
            </section>

            <section className="space-y-3">
              <h3 className="font-semibold">
                2. Alcohol, drugs, medication &amp; medical screening
              </h3>
              <YesNoField
                name="alcohol"
                label="Have you consumed any alcoholic drink today?"
                value={alcohol}
                onChange={setAlcohol}
              />
              {alcohol === "yes" && (
                <div>
                  <Label htmlFor="w-hours">How many hours ago was your last drink?</Label>
                  <Input
                    id="w-hours"
                    type="number"
                    min={0}
                    max={72}
                    value={hours}
                    onChange={(e) => setHours(e.target.value)}
                  />
                </div>
              )}
              <YesNoField
                name="drugs"
                label="Have you taken any recreational or illegal drugs today or in the last 24 hours?"
                value={drugs}
                onChange={setDrugs}
              />
              {drugs === "yes" && (
                <Input
                  placeholder="What and when"
                  value={drugDetails}
                  onChange={(e) => setDrugDetails(e.target.value)}
                  maxLength={300}
                />
              )}
              <YesNoField
                name="meds"
                label="Have you taken any prescription or over-the-counter medicine today?"
                value={meds}
                onChange={setMeds}
              />
              {meds === "yes" && (
                <Input
                  placeholder="Which medicine"
                  value={medDetails}
                  onChange={(e) => setMedDetails(e.target.value)}
                  maxLength={300}
                />
              )}
              <YesNoField
                name="influence"
                label="Are you currently under the influence of alcohol, medication, drugs, or any other substance that may affect you?"
                value={influence}
                onChange={setInfluence}
              />
              <fieldset className="space-y-1">
                <legend className="text-sm font-medium">
                  Do you have any of these conditions? (tick all that apply)
                </legend>
                {CONDITIONS.map((c) => (
                  <label key={c.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={conditions.includes(c.id)}
                      onCheckedChange={() => toggle(c.id)}
                    />
                    {c.label}
                  </label>
                ))}
              </fieldset>
              {conditions.length > 0 && (
                <Input
                  placeholder="Please give details"
                  value={condDetails}
                  onChange={(e) => setCondDetails(e.target.value)}
                  maxLength={500}
                />
              )}
            </section>

            <section className="space-y-2">
              <h3 className="font-semibold">3. Emergency contact</h3>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="w-ecn">Name</Label>
                  <Input
                    id="w-ecn"
                    value={ecName}
                    onChange={(e) => setEcName(e.target.value)}
                    maxLength={120}
                  />
                </div>
                <div>
                  <Label htmlFor="w-ecr">Relationship</Label>
                  <Input
                    id="w-ecr"
                    value={ecRel}
                    onChange={(e) => setEcRel(e.target.value)}
                    maxLength={60}
                  />
                </div>
                <div>
                  <Label htmlFor="w-ecp">Contact number</Label>
                  <Input
                    id="w-ecp"
                    inputMode="tel"
                    value={ecPhone}
                    onChange={(e) => setEcPhone(e.target.value)}
                    maxLength={30}
                  />
                </div>
                <div>
                  <Label htmlFor="w-eca">Alt. number</Label>
                  <Input
                    id="w-eca"
                    inputMode="tel"
                    value={ecAlt}
                    onChange={(e) => setEcAlt(e.target.value)}
                    maxLength={30}
                  />
                </div>
              </div>
            </section>

            <section className="space-y-2">
              <h3 className="font-semibold">4. About dab hits: what you are consenting to</h3>
              <p className={text}>{WAIVER_ABOUT_INTRO}</p>
              <ul className="ml-5 list-disc text-sm">
                {WAIVER_RISKS.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </section>

            <section className="space-y-2">
              <h3 className="font-semibold">5. Assumption of risk, release &amp; indemnity</h3>
              <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border p-3 text-sm">
                <p>By signing this form, I declare and agree that:</p>
                {WAIVER_CLAUSES.map(([n, t]) => (
                  <p key={n}>
                    <b>{n}</b> {t}
                  </p>
                ))}
              </div>
              <label className="flex items-start gap-2 text-sm">
                <Checkbox
                  className="mt-0.5"
                  checked={agree}
                  onCheckedChange={(v) => setAgree(v === true)}
                />
                I have read and agree to sections 4 and 5.
              </label>
              <label className="flex items-start gap-2 text-sm">
                <Checkbox
                  className="mt-0.5"
                  checked={popia}
                  onCheckedChange={(v) => setPopia(v === true)}
                />
                {WAIVER_POPIA}
              </label>
            </section>

            <section className="space-y-2">
              <h3 className="font-semibold">6. Customer signature</h3>
              <SignaturePad onChange={setSignature} resetKey={padKey} />
            </section>

            <section className="space-y-2 rounded-md bg-muted/40 p-3">
              <h3 className="font-semibold">7. Staff section (staff only)</h3>
              <YesNoField
                name="signs"
                label="Any visible signs of intoxication or concern noted before allowing this customer to proceed?"
                value={signs}
                onChange={setSigns}
              />
              {signs === "yes" && (
                <Input
                  placeholder="Details"
                  value={staffDetails}
                  onChange={(e) => setStaffDetails(e.target.value)}
                  maxLength={1000}
                />
              )}
              <p className="text-xs text-muted-foreground">
                If you answer Yes, the customer is not served a dab hit today. Incidents are
                recorded afterwards by a manager from the Waivers tab (or by you within 24 hours).
              </p>
            </section>

            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            {missing && <p className="text-xs text-muted-foreground">{missing}</p>}
            <Button onClick={() => void submit()} disabled={!!missing || busy} className="w-full">
              {busy ? "Saving…" : "Sign and save waiver"}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
