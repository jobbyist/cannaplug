import { describe, expect, it } from "vitest";
import {
  budgetBands,
  cleanAnswers,
  experiencePoints,
  matchProducts,
  nextQuestion,
  pickDiverse,
  poolFor,
  rank,
  scoreCandidate,
  whyItFits,
  type Answers,
  type Candidate,
} from "@/lib/plug-match";
import { makesHealthClaim } from "@/lib/ai/plug-guard";

let n = 0;
const c = (o: Partial<Candidate>): Candidate => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  name: `Product ${n}`,
  category: "Flower",
  subcategory: "Greenhouse",
  strainType: "Indica",
  price: 50,
  regularPrice: null,
  unit: "g",
  imageUrl: null,
  isFeatured: false,
  sortOrder: 0,
  available: 5,
  ...o,
});
const FLOWER = [
  c({ name: "Purple Fritter", subcategory: "Greenhouse", strainType: "Indica", price: 50 }),
  c({ name: "Zweet Insanity", subcategory: "Greenhouse", strainType: "Sativa", price: 50 }),
  c({ name: "Velvet Moon", subcategory: "Greendoor", strainType: "Indica", price: 70 }),
  c({ name: "White Widow", subcategory: "Greendoor", strainType: "Hybrid", price: 70 }),
  c({
    name: "Kings Juice",
    subcategory: "Premium Indoor",
    strainType: "Indica-dominant hybrid",
    price: 100,
  }),
  c({ name: "White Runtz", subcategory: "Top Shelf", strainType: "Hybrid", price: 120 }),
  c({ name: "Astro Grape", subcategory: "Outdoor", strainType: null, price: 24 }),
];
const MENU = [
  ...FLOWER,
  c({
    name: "Sour OG",
    category: "Pre-rolls",
    subcategory: "Greenhouse",
    strainType: "Hybrid",
    price: 50,
    unit: "each",
  }),
  c({
    name: "Jelly Beans 100mg",
    category: "Edibles",
    subcategory: null,
    strainType: null,
    price: 90,
    unit: "each",
  }),
  c({
    name: "Afghan",
    category: "Concentrates",
    subcategory: null,
    strainType: "Indica",
    price: 150,
  }),
  c({
    name: "Big Crusher",
    category: "Accessories",
    subcategory: null,
    strainType: null,
    price: 140,
    unit: "each",
  }),
];
const base: Answers = { experience: "sometimes", format: "flower" };

describe("question flow", () => {
  it("step 1 always; step 2 offers only formats with stock (never accessories); every step has Not sure", () => {
    expect(nextQuestion(MENU, {}).question!.step).toBe("experience");
    const q = nextQuestion(MENU, { experience: "regular" }).question!;
    expect(q.step).toBe("format");
    expect(q.chips.map((x) => x.value)).toEqual(["flower", "preroll", "edible", "any"]); // no vape or CBD in stock
    expect(q.chips.find((x) => x.value === "any")!.count).toBe(10); // accessories excluded
  });
  it("New to it: concentrates and grades above Indoor are hidden (a ceiling, not a recommendation)", () => {
    const pool = poolFor(MENU, { experience: "new", format: "any" }).map((x) => x.name);
    expect(pool).not.toContain("Afghan");
    expect(pool).not.toContain("Kings Juice");
    expect(pool).not.toContain("White Runtz");
    expect(pool).toContain("Purple Fritter");
    expect(poolFor(MENU, { experience: "regular", format: "any" }).map((x) => x.name)).toContain(
      "Afghan",
    );
  });
  it("vibe chips use occasion words only and hide a vibe with nothing behind it", () => {
    const q = nextQuestion(MENU, { experience: "regular", format: "preroll" }).question!;
    expect(q.step).toBe("vibe");
    expect(q.chips.map((x) => x.label)).toEqual(["Social", "Not sure"]); // only a Hybrid pre-roll in stock
    for (const ch of nextQuestion(MENU, base).question!.chips)
      expect(/sleep|pain|anxiety|stress|relax/i.test(ch.label), ch.label).toBe(false);
  });
  it("3b appears only after a Not sure vibe; a step with nothing to choose is skipped automatically", () => {
    expect(nextQuestion(MENU, { ...base, vibe: "chill" }).question!.step).toBe("budget");
    expect(nextQuestion(MENU, { ...base, vibe: "unsure" }).question!.step).toBe("strain");
    // edibles carry no strain: vibe and strain are skipped straight to budget (or the match)
    const ed = nextQuestion(MENU, { experience: "regular", format: "edible" });
    expect(ed.question).toBeNull();
    expect(ed.answers).toMatchObject({ vibe: "unsure", strain: "none", budget: "any" });
  });
  it("CBD skips the vibe step", () => {
    const menu = [
      ...MENU,
      c({ name: "CBD Oil", category: "CBD", strainType: null, price: 250, unit: "each" }),
    ];
    const r = nextQuestion(menu, { experience: "new", format: "cbd" });
    expect(r.answers.vibe).toBe("unsure");
    expect(r.question?.step ?? null).not.toBe("vibe");
  });
});

describe("budget bands", () => {
  it("three bands from today's in-stock prices for the format, per gram for flower, never empty", () => {
    const bands = budgetBands(poolFor(MENU, { experience: "regular", format: "flower" }));
    expect(bands.map((b) => b.label)).toEqual(["Up to R50/g", "R50–R70/g", "R70+/g"]);
    expect(bands.every((b) => b.count > 0)).toBe(true);
    expect(bands.reduce((s, b) => s + b.count, 0)).toBe(7); // every product in exactly one band
  });
  it("one price → one band; per item for formats sold by the item", () => {
    expect(
      budgetBands([c({ price: 90, unit: "each" }), c({ price: 90, unit: "each" })]),
    ).toHaveLength(1);
    const ed = budgetBands([
      c({ price: 20, unit: "each" }),
      c({ price: 90, unit: "each" }),
      c({ price: 250, unit: "each" }),
    ]);
    expect(ed[0]!.label).toBe("Up to R20");
  });
});

describe("scoring (spec)", () => {
  const band = { key: "low" as const, min: 40, max: 60, label: "R40–R60", count: 1 };
  it("strain 40 / Hybrid neighbour 20 / no strain 10 / opposite 0; no preference 20", () => {
    const s = (strainType: string | null, a: Answers) =>
      scoreCandidate(c({ strainType, price: 1000, available: 0, subcategory: null }), a, band);
    const want: Answers = { vibe: "chill" };
    expect(s("Indica", want)).toBe(40 + 8);
    expect(s("Hybrid", want)).toBe(20 + 8);
    expect(s(null, want)).toBe(10 + 8);
    expect(s("Sativa", want)).toBe(0 + 8);
    expect(s("Sativa", { vibe: "social" })).toBe(20 + 8);
    expect(s("Sativa", {})).toBe(20 + 8);
  });
  it("budget 30 at the middle of the band, less towards the edges, 0 outside", () => {
    const p = (price: number) =>
      scoreCandidate(c({ price, strainType: null, available: 0, subcategory: null }), {}, band);
    expect(p(50) - p(1000)).toBe(30);
    expect(p(60) - p(1000)).toBe(20);
    expect(p(61) - p(1000)).toBe(0);
  });
  it("experience 15: New favours lower grades, Regular higher; stock depth capped at 10; shop's pick 5", () => {
    const g = (r: number) => ({ rank: r, of: 8 });
    expect(experiencePoints("new", g(0))).toBe(15);
    expect(experiencePoints("new", g(7))).toBe(0);
    expect(experiencePoints("regular", g(7))).toBe(15);
    expect(experiencePoints("sometimes", null)).toBe(8);
    const deep = scoreCandidate(c({ available: 50 }), {}, null);
    const shallow = scoreCandidate(c({ available: 2 }), {}, null);
    expect(deep - shallow).toBe(8);
    expect(
      scoreCandidate(c({ isFeatured: true }), {}, null) - scoreCandidate(c({}), {}, null),
    ).toBe(5);
    expect(
      scoreCandidate(c({ regularPrice: 60 }), {}, null) - scoreCandidate(c({}), {}, null),
    ).toBe(5);
  });
  it("ties break by sort order, then name: the same answers and stock always give the same order", () => {
    const tied = [
      c({ name: "Bravo", sortOrder: 2 }),
      c({ name: "Alpha", sortOrder: 2 }),
      c({ name: "Zulu", sortOrder: 1 }),
    ];
    expect(rank(tied, {}, null).map((r) => r.c.name)).toEqual(["Zulu", "Alpha", "Bravo"]);
    expect(rank([...tied].reverse(), {}, null).map((r) => r.c.name)).toEqual([
      "Zulu",
      "Alpha",
      "Bravo",
    ]);
  });
  it("three different products; 2nd and 3rd favour a different grade or strain from the first", () => {
    const list = [
      c({ name: "A", subcategory: "Greenhouse", strainType: "Indica", available: 10 }),
      c({ name: "B", subcategory: "Greenhouse", strainType: "Indica", available: 9 }),
      c({ name: "C", subcategory: "Greendoor", strainType: "Indica", available: 1 }),
    ];
    expect(pickDiverse(rank(list, {}, null)).map((r) => r.c.name)).toEqual(["A", "C", "B"]);
  });
});

describe("matching and relaxation", () => {
  it("matches inside the band and the strain, up to 3, with a facts-only why-it-fits line", () => {
    const r = matchProducts(MENU, { ...base, vibe: "chill", budget: "low" });
    expect(r.status).toBe("matched");
    if (r.status !== "matched") return;
    expect(r.relaxed).toBeNull();
    expect(r.cards.map((x) => x.name)).toEqual(["Purple Fritter"]);
    expect(r.cards[0]!.why).toBe(
      "Indica, as you asked · Greenhouse grade · inside your up-to-R50 budget",
    );
    for (const card of r.cards) expect(makesHealthClaim(card.why)).toBe(false);
  });
  it("relax 1: drop the strain and say so", () => {
    const r = matchProducts(MENU, { ...base, vibe: "daytime", budget: "mid" }); // no Sativa at R50-70 except at R50 (low)
    expect(r).toMatchObject({ status: "matched", relaxed: "strain" });
    if (r.status === "matched")
      expect(r.note).toMatch(
        /^No Sativa in your budget today, but this (Hybrid|Indica) is close\.$/,
      );
  });
  it("relax 2: widen the budget by one band and say so; never the format", () => {
    const menu = [
      c({ name: "Only Pricey", price: 100 }),
      c({ name: "Cheap gone", price: 20 }),
      c({ name: "Mid", price: 60 }),
    ];
    const r = matchProducts(
      menu,
      { experience: "regular", format: "flower", budget: "low" },
      { exclude: [menu[1]!.id] },
    );
    expect(r).toMatchObject({
      status: "matched",
      relaxed: "budget",
      note: "Slightly over your budget, but worth a look.",
    });
    if (r.status === "matched") expect(r.cards[0]).toMatchObject({ name: "Mid", overBudget: true });
  });
  it("empty is honest: names the formats that do have stock, never swaps format silently", () => {
    const r = matchProducts(MENU, { experience: "regular", format: "vape" });
    expect(r).toEqual({
      status: "empty",
      note: "No vapes in stock right now.",
      otherFormats: [
        { value: "flower", label: "Flower" },
        { value: "preroll", label: "Pre-roll" },
        { value: "edible", label: "Edible or drink" },
      ],
    });
  });
  it("Show me another excludes what was already shown", () => {
    const first = matchProducts(MENU, { ...base, vibe: "chill", budget: "any" }, { limit: 1 });
    if (first.status !== "matched") throw new Error("expected a match");
    const next = matchProducts(
      MENU,
      { ...base, vibe: "chill", budget: "any" },
      { exclude: [first.cards[0]!.id], limit: 1 },
    );
    if (next.status !== "matched") throw new Error("expected another");
    expect(next.cards[0]!.id).not.toBe(first.cards[0]!.id);
  });
  it("whyItFits mentions a special and never health words", () => {
    const w = whyItFits(
      c({ regularPrice: 80, price: 60, subcategory: "Greendoor" }),
      {},
      null,
      false,
    );
    expect(w).toContain("on special (usually R80)");
  });
});

describe("answers from the browser", () => {
  it("keeps known keys and values only, in order; prices, ids or stock are dropped", () => {
    expect(
      cleanAnswers({
        experience: "new",
        format: "flower",
        budget: "low",
        price: 1,
        available: 99,
        id: "x",
        vibe: "sleepy",
      }),
    ).toEqual({ experience: "new", format: "flower", budget: "low" });
    expect(cleanAnswers({ format: "flower" })).toEqual({}); // later answers need the earlier ones
    expect(cleanAnswers("nope")).toEqual({});
  });
});
