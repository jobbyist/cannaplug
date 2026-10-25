import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderTemplate } from "@/lib/notifications/templates";

const ctx = { siteUrl: "https://cannaplug012.co.za" };
const CLINICAL = [
  "practitioner_request_assigned",
  "practitioner_document_waiting",
  "clinical_request_completed",
  "clinical_request_declined",
  "document_ready",
  "document_revoked",
] as const;

// Values that must never reach an email, even if some future caller puts them in the template data.
const POISON = {
  contact_name: "Thandiwe Mokoena",
  member_name: "Thandiwe Mokoena",
  document_type: "PRESCRIPTION",
  type: "MEDICAL_LETTER",
  diagnosis: "generalised anxiety disorder",
  condition: "chronic pain",
  medicine: "THC 20% flower",
  product: "THC 20% flower",
  dosage: "0.5 g twice daily",
  practitioner: "Dr Naidoo",
  doctor_name: "Dr Naidoo",
  reason: "contraindicated with warfarin",
  notes: "patient reports insomnia",
  id_number: "9001015800085",
};

describe("clinical notifications carry no clinical content", () => {
  for (const name of CLINICAL) {
    it(`${name}: subject, HTML and text contain none of the data`, () => {
      const r = renderTemplate(name, POISON, ctx)!;
      expect(r).not.toBeNull();
      const all = `${r.subject}\n${r.html}\n${r.text}\n${r.sms ?? ""}`.toLowerCase();
      for (const [k, v] of Object.entries(POISON)) expect(all, k).not.toContain(v.toLowerCase());
      for (const word of ["prescription", "diagnos", "medic", "dosage", "thc", "cbd", "dr "])
        expect(r.subject.toLowerCase(), word).not.toContain(word);
      expect(r.html).toContain("nothing from the document or request is included");
      // links go to the signed-in areas only, never to a document id
      const links = [...r.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!);
      for (const l of links.filter((l) => l.startsWith(ctx.siteUrl)))
        expect(l, l).toMatch(/\/(doctor|member\/documents|account|unsubscribe[^"]*)$|\/$/);
    });
  }

  it("staff_prescription_revoked shows the order number and nothing clinical", () => {
    const r = renderTemplate(
      "staff_prescription_revoked",
      { ...POISON, order_number: "CP-1042" },
      ctx,
    )!;
    expect(r.subject).toBe("Check order CP-1042 before packing");
    const all = `${r.subject}\n${r.html}\n${r.text}`.toLowerCase();
    for (const [k, v] of Object.entries(POISON)) expect(all, k).not.toContain(v.toLowerCase());
  });

  it("the database queues clinical emails with empty data only", () => {
    const sql = readFileSync("supabase/migrations/20261023007000_clinical_notify.sql", "utf8");
    const calls = [...sql.matchAll(/notification_enqueue(?:_staff)?\(([^;]*?)\);/gs)].map(
      (m) => m[1]!,
    );
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      // the data argument is either the literal empty object or the order's id and number only
      const data = c.match(/'\{\}'::jsonb|jsonb_build_object\(([^)]*)\)/)?.[0] ?? "";
      expect(data, c).toMatch(
        /^'\{\}'::jsonb$|^jsonb_build_object\('order_id', r\.order_id, 'order_number', r\.order_number\)$/,
      );
    }
  });
});
