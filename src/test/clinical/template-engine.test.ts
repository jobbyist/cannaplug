import { describe, expect, it } from "vitest";
import {
  ALLOWED_PLACEHOLDERS,
  TemplateError,
  defaultSchemaFor,
  extractPlaceholders,
  renderTemplate,
  sanitiseValue,
  validateTemplate,
  type RenderData,
} from "@/lib/clinical/template-engine";

const LETTER = `Letter {{document.document_id}} dated {{document.issue_date}}
Patient: {{member.full_name}} ({{member.member_id}}), born {{member.date_of_birth}}
{{clinical.statement}}
Valid until {{document.expiry_date}}
{{doctor.title}} {{doctor.full_name}}, HPCSA {{doctor.hpcsa_number}}`;

const RX = `Rx {{document.document_id}} {{document.issue_date}} until {{document.expiry_date}}
{{member.full_name}} {{member.member_id}} {{member.date_of_birth}}
{{prescription.medicine_name}} {{prescription.dosage_form}} {{prescription.strength}}
{{prescription.quantity_numeric}} ({{prescription.quantity_words}}) {{prescription.route}}
{{prescription.frequency}} {{prescription.duration}} {{prescription.repeats}}
{{prescription.indication}} {{prescription.directions}}
Generic: {{prescription.generic_name}}
{{prescription.special_instructions}}
{{doctor.full_name}} {{doctor.hpcsa_number}}`;

const data = (over: Partial<RenderData> = {}): RenderData => ({
  doctor: { title: "Dr", full_name: "Jane Smith", hpcsa_number: "MP0123456" },
  member: { full_name: "Test Member", member_id: "CP-M-ABCD1234", date_of_birth: "1990-05-17" },
  document: { document_id: "CP-MED-2026-000184", issue_date: "2026-10-02", expiry_date: null },
  clinical: { statement: "Practitioner wrote this." },
  ...over,
});

describe("template engine", () => {
  it("extracts placeholders in order without duplicates", () => {
    expect(extractPlaceholders("{{ a.b }} {{c.d}} {{a.b}}")).toEqual(["a.b", "c.d"]);
  });

  it("exposes exactly the whitelisted placeholder set, including every prescription field", () => {
    for (const k of [
      "doctor.title",
      "doctor.full_name",
      "doctor.hpcsa_number",
      "doctor.practice_number",
      "member.full_name",
      "member.member_id",
      "member.date_of_birth",
      "document.issue_date",
      "document.expiry_date",
      "document.document_id",
      "prescription.medicine_name",
      "prescription.dosage_form",
      "prescription.strength",
      "prescription.quantity_numeric",
      "prescription.quantity_words",
      "prescription.directions",
      "prescription.route",
      "prescription.frequency",
      "prescription.duration",
      "prescription.repeats",
    ])
      expect(ALLOWED_PLACEHOLDERS).toContain(k);
  });

  describe("validation", () => {
    it("accepts a well formed letter and prescription", () => {
      expect(
        validateTemplate("MEDICAL_LETTER", LETTER, defaultSchemaFor("MEDICAL_LETTER", LETTER)),
      ).toEqual([]);
      expect(
        validateTemplate("PRESCRIPTION_ORDER", RX, defaultSchemaFor("PRESCRIPTION_ORDER", RX)),
      ).toEqual([]);
    });

    it.each([
      ["script tag", LETTER + "<script>alert(1)</script>"],
      ["html tag", LETTER + "<b>bold</b>"],
      ["angle bracket alone", LETTER + " a > b"],
      ["control character", LETTER + "\u0007"],
      ["unknown placeholder", LETTER + " {{member.id_number}}"],
      ["expression syntax", LETTER + " {{ 1 + 1 }}"],
      ["unbalanced braces", LETTER + " {{ nope"],
      ["javascript-looking value placeholder", LETTER + " {{constructor.constructor}}"],
    ])("rejects %s", (_n, content) => {
      expect(
        validateTemplate("MEDICAL_LETTER", content, defaultSchemaFor("MEDICAL_LETTER", content))
          .length,
      ).toBeGreaterThan(0);
    });

    it("rejects a letter containing prescription fields and a prescription containing letter fields", () => {
      const a = LETTER + " {{prescription.strength}}";
      expect(
        validateTemplate("MEDICAL_LETTER", a, defaultSchemaFor("MEDICAL_LETTER", a)),
      ).toContain("A medical letter cannot contain prescription fields");
      const b = RX + " {{clinical.statement}}";
      expect(
        validateTemplate("PRESCRIPTION_ORDER", b, defaultSchemaFor("PRESCRIPTION_ORDER", b)),
      ).toContain("A prescription cannot contain clinical.* letter fields");
    });

    it("requires every mandatory prescription field and the expiry date", () => {
      const short = RX.replace("{{prescription.strength}}", "");
      const problems = validateTemplate(
        "PRESCRIPTION_ORDER",
        short,
        defaultSchemaFor("PRESCRIPTION_ORDER", short),
      );
      expect(problems).toContain("A prescription template must contain {{prescription.strength}}");
    });

    it("requires clinical placeholders to be marked required", () => {
      const schema = defaultSchemaFor("MEDICAL_LETTER", LETTER);
      schema.placeholders = schema.placeholders.map((p) =>
        p.key === "clinical.statement" ? { ...p, required: false } : p,
      );
      expect(validateTemplate("MEDICAL_LETTER", LETTER, schema).join()).toMatch(
        /must be marked required/,
      );
    });

    it("marks every clinical/prescription value required in the derived schema, except the optional ones", () => {
      const schema = defaultSchemaFor("PRESCRIPTION_ORDER", RX);
      const req = Object.fromEntries(schema.placeholders.map((p) => [p.key, p.required]));
      expect(req["prescription.medicine_name"]).toBe(true);
      expect(req["prescription.repeats"]).toBe(true);
      expect(req["prescription.indication"]).toBe(true);
      expect(req["document.expiry_date"]).toBe(true);
      expect(req["prescription.generic_name"]).toBe(false);
      expect(req["prescription.special_instructions"]).toBe(false);
    });

    it("requires identity fields on every template", () => {
      const c = "{{clinical.statement}} some wording here for length";
      expect(
        validateTemplate("MEDICAL_LETTER", c, defaultSchemaFor("MEDICAL_LETTER", c)).join(),
      ).toMatch(/doctor.hpcsa_number/);
    });
  });

  describe("rendering", () => {
    it("substitutes values and formats dates", () => {
      const out = renderTemplate(LETTER, defaultSchemaFor("MEDICAL_LETTER", LETTER), data());
      expect(out).toContain("Letter CP-MED-2026-000184 dated 02 October 2026");
      expect(out).toContain("born 17 May 1990");
      expect(out).toContain("Practitioner wrote this.");
      expect(out).not.toContain("{{");
    });

    it("drops a line whose only placeholder is an empty optional value (no dangling label)", () => {
      const out = renderTemplate(LETTER, defaultSchemaFor("MEDICAL_LETTER", LETTER), data());
      expect(out).not.toContain("Valid until");
    });

    it("keeps the label when the optional value is present", () => {
      const out = renderTemplate(
        LETTER,
        defaultSchemaFor("MEDICAL_LETTER", LETTER),
        data({
          document: { document_id: "X", issue_date: "2026-10-02", expiry_date: "2027-01-31" },
        }),
      );
      expect(out).toContain("Valid until 31 January 2027");
    });

    it("refuses to render with a required clinical value missing, listing each one", () => {
      let err: unknown;
      try {
        renderTemplate(LETTER, defaultSchemaFor("MEDICAL_LETTER", LETTER), data({ clinical: {} }));
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(TemplateError);
      expect((err as TemplateError).message).toMatch(/clinical\.statement/);
    });

    it("never defaults a prescription value", () => {
      const rxData = data({ prescription: { medicine_name: "X" } });
      expect(() => renderTemplate(RX, defaultSchemaFor("PRESCRIPTION_ORDER", RX), rxData)).toThrow(
        /strength/,
      );
    });

    it("renders numbers without float noise, including zero repeats", () => {
      const rxData: RenderData = {
        doctor: { full_name: "Dr J", hpcsa_number: "MP1" },
        member: { full_name: "M", member_id: "CP-M-1", date_of_birth: "1990-01-01" },
        document: {
          document_id: "CP-RX-2026-000001",
          issue_date: "2026-10-02",
          expiry_date: "2026-12-01",
        },
        prescription: {
          medicine_name: "Med",
          dosage_form: "Form",
          strength: "S",
          quantity_numeric: 5,
          quantity_words: "five",
          route: "R",
          frequency: "F",
          duration: "D",
          repeats: 0,
          indication: "I",
          directions: "Dir",
        },
      };
      const out = renderTemplate(RX, defaultSchemaFor("PRESCRIPTION_ORDER", RX), rxData);
      expect(out).toContain("5 (five)");
      expect(out).toContain("0");
      expect(out).not.toContain("Generic:");
    });

    it("does not execute or interpret anything in a value", () => {
      const out = renderTemplate(
        LETTER,
        defaultSchemaFor("MEDICAL_LETTER", LETTER),
        data({
          clinical: { statement: "Total {{member.full_name}} ${1+1} __proto__ constructor" },
        }),
      );
      expect(out).toContain("Total {{member.full_name}} ${1+1} __proto__ constructor");
    });

    it("rejects markup in a value", () => {
      expect(() =>
        renderTemplate(
          LETTER,
          defaultSchemaFor("MEDICAL_LETTER", LETTER),
          data({ clinical: { statement: "<img src=x onerror=alert(1)>" } }),
        ),
      ).toThrow(TemplateError);
    });

    it("is deterministic and normalises line endings and blank runs", () => {
      const schema = defaultSchemaFor("MEDICAL_LETTER", LETTER);
      const a = renderTemplate(
        LETTER,
        schema,
        data({ clinical: { statement: "line one\r\n\r\n\r\n\r\nline two   " } }),
      );
      const b = renderTemplate(
        LETTER,
        schema,
        data({ clinical: { statement: "line one\r\n\r\n\r\n\r\nline two   " } }),
      );
      expect(a).toBe(b);
      expect(a).not.toMatch(/\r/);
      expect(a).not.toMatch(/\n{3,}/);
    });

    it("renders an unknown placeholder as an error, not as text", () => {
      expect(() =>
        renderTemplate(
          "Hello {{member.id_number}} and more words here",
          { placeholders: [] },
          data(),
        ),
      ).toThrow(TemplateError);
    });
  });

  describe("sanitiseValue", () => {
    it("strips control characters and collapses whitespace", () => {
      expect(sanitiseValue("member.full_name", "  A\u0000B \t C  ")).toBe("AB C");
    });
    it("keeps line breaks only for designated free-text fields", () => {
      expect(sanitiseValue("clinical.statement", "a\nb")).toBe("a\nb");
      expect(sanitiseValue("member.full_name", "a\nb")).toBe("a b");
    });
    it("treats null/undefined/objects as empty", () => {
      expect(sanitiseValue("member.full_name", null)).toBe("");
      expect(sanitiseValue("member.full_name", { a: 1 })).toBe("");
    });
  });
});
