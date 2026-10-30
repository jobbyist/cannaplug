/**
 * Ask The Plug: the guided match (pure, deterministic, unit-tested). Spec: "Question Flow, Matching Logic & Stock
 * Guardrails" (30 Oct 2026).
 *
 *   Step 1  experience  → grade ceiling + which formats are offered
 *   Step 2  format      → category filter (only formats with stock behind them)
 *   Step 3  vibe        → strain preference (occasion words only, never health words); skipped for CBD
 *   Step 3b strain      → only when the vibe is "Not sure"
 *   Step 4  budget      → three bands cut from today's in-stock prices for the chosen format
 *   Step 5  up to 3 products
 *
 * The candidates handed to these functions have ALREADY passed the database's hard filters (plug_match_candidates:
 * active, sold online, live availability at or above the safety buffer, no practitioner recommendation needed), read
 * at the moment of the request. Nothing here can relax those. The AI model is not involved at all.
 */
import { CATEGORY_ORDER, SUBCATEGORY_ORDER, normKey } from "@/lib/catalogue-taxonomy";
import { strainOf, type Strain } from "@/lib/shop-filter";

export type Experience = "new" | "sometimes" | "regular";
export type Format = "flower" | "preroll" | "edible" | "vape" | "cbd" | "any";
export type Vibe = "chill" | "social" | "daytime" | "unsure";
export type StrainChoice = Strain | "none";
export type BudgetKey = "low" | "mid" | "high" | "any";

export type Answers = {
  experience?: Experience;
  format?: Format;
  vibe?: Vibe;
  strain?: StrainChoice;
  budget?: BudgetKey;
};

/** A product that passed the database's hard filters, read at the moment of the request. */
export type Candidate = {
  id: string;
  name: string;
  category: string;
  subcategory: string | null;
  strainType: string | null;
  price: number;
  regularPrice: number | null;
  unit: string | null;
  imageUrl: string | null;
  isFeatured: boolean;
  sortOrder: number;
  available: number;
};

export const FORMAT_CATEGORIES: Record<Exclude<Format, "any">, string[]> = {
  flower: ["Flower"],
  preroll: ["Pre-rolls"],
  edible: ["Edibles", "Drinks"],
  vape: ["Vapes"],
  cbd: ["CBD"],
};
const NOT_FOR_NEWCOMERS = ["Concentrates"];
/** Grades above Indoor are hidden for "New to it" (a ceiling, not a recommendation). */
const HIGH_GRADES = ["premium indoor", "hydro", "top shelf"];

export const FORMAT_LABEL: Record<Format, string> = {
  flower: "Flower",
  preroll: "Pre-roll",
  edible: "Edible or drink",
  vape: "Vape",
  cbd: "CBD (no high)",
  any: "Not sure",
};
/** Plural noun for "No … in stock right now". */
export const FORMAT_NOUN: Record<Format, string> = {
  flower: "flower",
  preroll: "pre-rolls",
  edible: "edibles or drinks",
  vape: "vapes",
  cbd: "CBD products",
  any: "products",
};
export const EXPERIENCE_LABEL: Record<Experience, string> = {
  new: "New to it",
  sometimes: "Now and then",
  regular: "Regular",
};
export const VIBE_LABEL: Record<Vibe, string> = {
  chill: "Chill night in",
  social: "Social",
  daytime: "Daytime and creative",
  unsure: "Not sure",
};
/** Occasion → strain label, most-likely first. No health words anywhere in the flow. */
export const VIBE_STRAIN: Record<Exclude<Vibe, "unsure">, Strain> = {
  chill: "Indica",
  social: "Hybrid",
  daytime: "Sativa",
};

// ---- filters ---------------------------------------------------------------------------------------------------------

/** Categories a format covers; "Not sure" means every bud format the shop sells (never accessories). */
export function formatCategories(format: Format | undefined): string[] {
  if (!format || format === "any") return CATEGORY_ORDER.filter((c) => c !== "Accessories");
  return FORMAT_CATEGORIES[format];
}

export function formatOf(category: string): Exclude<Format, "any"> | null {
  const k = normKey(category);
  for (const [f, cats] of Object.entries(FORMAT_CATEGORIES))
    if (cats.some((c) => normKey(c) === k)) return f as Exclude<Format, "any">;
  return null;
}

/** 0-based position of a product's grade in its category's ladder (Outdoor … Top Shelf), or null. */
export function gradeRank(
  c: Pick<Candidate, "category" | "subcategory">,
): { rank: number; of: number } | null {
  const ladder = Object.entries(SUBCATEGORY_ORDER).find(
    ([cat]) => normKey(cat) === normKey(c.category),
  )?.[1];
  if (!ladder || !c.subcategory) return null;
  const i = ladder.findIndex((g) => normKey(g) === normKey(c.subcategory));
  return i < 0 ? null : { rank: i, of: ladder.length };
}

/** Within the experience ceiling: "New to it" hides concentrates and grades above Indoor. */
export function withinCeiling(c: Candidate, experience: Experience | undefined): boolean {
  if (experience !== "new") return true;
  if (NOT_FOR_NEWCOMERS.some((x) => normKey(x) === normKey(c.category))) return false;
  return !HIGH_GRADES.includes(normKey(c.subcategory));
}

/** The pool for the answers so far: format categories and the experience ceiling (hard, never relaxed). */
export function poolFor(cands: Candidate[], a: Answers): Candidate[] {
  const cats = formatCategories(a.format).map(normKey);
  return cands.filter((c) => cats.includes(normKey(c.category)) && withinCeiling(c, a.experience));
}

export function wantedStrain(a: Answers): Strain | null {
  if (a.vibe && a.vibe !== "unsure") return VIBE_STRAIN[a.vibe];
  if (a.strain && a.strain !== "none") return a.strain;
  return null;
}

// ---- budget bands ----------------------------------------------------------------------------------------------------

export type Band = {
  key: Exclude<BudgetKey, "any">;
  min: number;
  max: number;
  label: string;
  count: number;
  /** "Not sure": the whole price range, never named as a budget. */
  any?: boolean;
};

const rand = (n: number) => (Number.isInteger(n) ? `R${n}` : `R${n.toFixed(2)}`);
/** "/g" when every product in the pool is sold per gram, else per item (no suffix). */
export function perUnit(pool: Candidate[]): string {
  return pool.length && pool.every((c) => normKey(c.unit) === "g") ? "/g" : "";
}

/**
 * Lower, middle and upper third of today's in-stock prices for the pool, so every band holds products. Fewer distinct
 * prices give fewer bands. Bands never overlap: low ≤ q1 < mid ≤ q2 < high.
 */
export function budgetBands(pool: Candidate[]): Band[] {
  const prices = pool.map((c) => c.price).sort((a, b) => a - b);
  if (!prices.length) return [];
  const unit = perUnit(pool);
  const distinct = [...new Set(prices)];
  const min = prices[0]!;
  const max = prices[prices.length - 1]!;
  if (distinct.length === 1)
    return [{ key: "low", min, max, label: `${rand(min)}${unit}`, count: prices.length }];
  const q1 = prices[Math.floor((prices.length - 1) / 3)]!;
  const q2 = prices[Math.floor((2 * (prices.length - 1)) / 3)]!;
  const raw: Band[] = [
    { key: "low", min, max: q1, label: `Up to ${rand(q1)}${unit}`, count: 0 },
    { key: "mid", min: q1, max: q2, label: `${rand(q1)}–${rand(q2)}${unit}`, count: 0 },
    { key: "high", min: q2, max, label: `${rand(q2)}+${unit}`, count: 0 },
  ];
  const inBand = (b: Band, p: number) => (b.key === "low" ? p <= b.max : p > b.min && p <= b.max);
  for (const b of raw) b.count = prices.filter((p) => inBand(b, p)).length;
  return raw.filter((b) => b.count > 0 && (b.key === "low" || b.max > b.min));
}

/** Whether a price falls inside a band (bands are half-open above the lowest one). */
export function inBand(b: Pick<Band, "key" | "min" | "max">, price: number): boolean {
  return b.key === "low" ? price >= b.min && price <= b.max : price > b.min && price <= b.max;
}

export function bandFor(pool: Candidate[], key: BudgetKey | undefined): Band | null {
  const bands = budgetBands(pool);
  if (!bands.length) return null;
  if (!key || key === "any")
    return {
      key: "low",
      min: bands[0]!.min,
      max: bands[bands.length - 1]!.max,
      label: "any budget",
      count: pool.length,
      any: true,
    };
  return bands.find((b) => b.key === key) ?? null;
}

// ---- questions -------------------------------------------------------------------------------------------------------

export type Chip = { value: string; label: string; count: number };
export type Question = {
  step: "experience" | "format" | "vibe" | "strain" | "budget";
  say: string;
  chips: Chip[];
};

/** What the server says before each question, so the flow reads like a chat with a friend behind the counter. */
const ACK: Record<Experience, string> = {
  new: "Love that, we'll keep it easy-going.",
  sometimes: "Nice one.",
  regular: "A regular, respect.",
};
const FORMAT_ACK: Record<Format, string> = {
  flower: "Flower it is.",
  preroll: "Pre-rolls, easy.",
  edible: "Edibles or drinks, nice.",
  vape: "A vape, sure.",
  cbd: "CBD, no high.",
  any: "No stress, I'll look across the menu.",
};

/**
 * The next question for these answers, with only the chips that have in-stock products behind them. A step whose
 * only remaining chip is "Not sure" is answered automatically and skipped. Returns null once it is time to match.
 */
export function nextQuestion(
  cands: Candidate[],
  a: Answers,
): { question: Question | null; answers: Answers } {
  const ans: Answers = { ...a };
  if (!ans.experience)
    return {
      question: {
        step: "experience",
        say: "Let's find your match 🔌 A few quick taps and I'll check what's on the shelf right now. First up: how familiar are you with cannabis?",
        chips: (["new", "sometimes", "regular"] as const).map((v) => ({
          value: v,
          label: EXPERIENCE_LABEL[v],
          count: poolFor(cands, { experience: v }).length,
        })),
      },
      answers: ans,
    };
  if (!ans.format) {
    const chips: Chip[] = (Object.keys(FORMAT_CATEGORIES) as Exclude<Format, "any">[])
      .map((f) => ({
        value: f as string,
        label: FORMAT_LABEL[f],
        count: poolFor(cands, { ...ans, format: f }).length,
      }))
      .filter((c) => c.count > 0);
    const any = poolFor(cands, { ...ans, format: "any" }).length;
    if (any > 0) chips.push({ value: "any", label: FORMAT_LABEL.any, count: any });
    return {
      question: { step: "format", say: `${ACK[ans.experience]} What would you like?`, chips },
      answers: ans,
    };
  }
  const pool = poolFor(cands, ans);
  if (!ans.vibe && ans.format !== "cbd") {
    const chips: Chip[] = (["chill", "social", "daytime"] as const)
      .map((v) => ({
        value: v,
        label: VIBE_LABEL[v],
        count: pool.filter((c) => strainOf(c.strainType) === VIBE_STRAIN[v]).length,
      }))
      .filter((c) => c.count > 0);
    if (chips.length)
      return {
        question: {
          step: "vibe",
          say: `${FORMAT_ACK[ans.format]} What's the vibe?`,
          chips: [...chips, { value: "unsure", label: VIBE_LABEL.unsure, count: pool.length }],
        },
        answers: ans,
      };
    ans.vibe = "unsure"; // nothing labelled behind any vibe: skip without asking
  }
  if (ans.format === "cbd" && !ans.vibe) ans.vibe = "unsure";
  if (ans.vibe === "unsure" && !ans.strain && ans.format !== "cbd") {
    const chips: Chip[] = (["Indica", "Sativa", "Hybrid"] as const)
      .map((s) => ({
        value: s,
        label: s,
        count: pool.filter((c) => strainOf(c.strainType) === s).length,
      }))
      .filter((c) => c.count > 0);
    if (chips.length)
      return {
        question: {
          step: "strain",
          say: "No stress. Indica, sativa or hybrid? (They're traditional labels, so think of it as a starting point.)",
          chips: [...chips, { value: "none", label: "No preference", count: pool.length }],
        },
        answers: ans,
      };
    ans.strain = "none";
  }
  if (!ans.budget) {
    const bands = budgetBands(pool);
    if (bands.length > 1) {
      const unit = perUnit(pool);
      return {
        question: {
          step: "budget",
          say: `Last one: what's your budget${unit === "/g" ? " per gram" : ""}?`,
          chips: [
            ...bands.map((b) => ({ value: b.key, label: b.label, count: b.count })),
            { value: "any", label: "Not sure", count: pool.length },
          ],
        },
        answers: ans,
      };
    }
    ans.budget = "any";
  }
  return { question: null, answers: ans };
}

// ---- scoring ---------------------------------------------------------------------------------------------------------

/** 0..15: "New to it" favours lower grades, "Regular" higher grades, "Now and then" the middle. No grade: 8. */
export function experiencePoints(
  experience: Experience | undefined,
  grade: { rank: number; of: number } | null,
) {
  if (!grade || grade.of < 2) return 8;
  const t = grade.rank / (grade.of - 1);
  if (experience === "new") return Math.round(15 * (1 - t));
  if (experience === "regular") return Math.round(15 * t);
  return Math.round(15 * (1 - Math.abs(t - 0.5) * 2));
}

/** The spec's score (0..100): strain 40, budget 30, experience 15, stock depth 10, shop's pick 5. */
export function scoreCandidate(p: Candidate, a: Answers, band: Band | null): number {
  const strain = strainOf(p.strainType);
  const want = wantedStrain(a);
  const strainPts = !want
    ? 20
    : !strain
      ? 10
      : strain === want
        ? 40
        : strain === "Hybrid" || want === "Hybrid"
          ? 20
          : 0;
  let budgetPts = 0;
  if (band && inBand(band, p.price)) {
    const mid = (band.min + band.max) / 2;
    const half = (band.max - band.min) / 2 || 1;
    budgetPts = Math.max(0, Math.round(30 - (10 * Math.abs(p.price - mid)) / half));
  }
  const expPts = experiencePoints(a.experience, gradeRank(p));
  const stockPts = Math.min(Math.max(p.available, 0), 10);
  const onSale = p.regularPrice != null && p.regularPrice > p.price;
  const pickPts = p.isFeatured || onSale ? 5 : 0;
  return strainPts + budgetPts + expPts + stockPts + pickPts;
}

/** Score desc, then sort order, then name, so results never shuffle between visits. */
export function rank(cands: Candidate[], a: Answers, band: Band | null) {
  return cands
    .map((c) => ({ c, score: scoreCandidate(c, a, band) }))
    .sort(
      (x, y) =>
        y.score - x.score ||
        x.c.sortOrder - y.c.sortOrder ||
        x.c.name.localeCompare(y.c.name, "en") ||
        x.c.id.localeCompare(y.c.id),
    );
}

/** Up to n different products; the 2nd and 3rd favour a different grade or strain from the first, for real choice. */
export function pickDiverse<T extends { c: Candidate }>(ranked: T[], n = 3): T[] {
  if (!ranked.length) return [];
  const first = ranked[0]!;
  const out = [first];
  const key = (c: Candidate) => `${normKey(c.subcategory)}|${strainOf(c.strainType) ?? ""}`;
  const rest = ranked.slice(1);
  while (out.length < n && rest.length) {
    const i = rest.findIndex(
      (r) => key(r.c) !== key(first.c) && !out.some((o) => o.c.id === r.c.id),
    );
    const next = rest.splice(i >= 0 ? i : 0, 1)[0]!;
    if (!out.some((o) => o.c.id === next.c.id)) out.push(next);
  }
  return out;
}

// ---- matching with honest relaxation ---------------------------------------------------------------------------------

export type Relaxed = null | "strain" | "budget";
export type MatchCard = Candidate & { score: number; why: string; overBudget: boolean };
export type MatchResult =
  | { status: "matched"; relaxed: Relaxed; note: string | null; cards: MatchCard[] }
  | { status: "empty"; note: string; otherFormats: { value: Format; label: string }[] };

const bandWords = (b: Band | null) =>
  !b || b.any
    ? null
    : b.key === "low"
      ? `your up-to-${rand(b.max)} budget`
      : `your ${b.label} budget`;

/** "Indica · Greenhouse grade · inside your up-to-R60 budget". Facts only: no effect or health words. */
export function whyItFits(
  c: Candidate,
  a: Answers,
  band: Band | null,
  overBudget: boolean,
): string {
  const parts: string[] = [];
  const strain = strainOf(c.strainType);
  const want = wantedStrain(a);
  if (strain) parts.push(want && strain === want ? `${strain}, as you asked` : strain);
  if (c.subcategory) parts.push(`${c.subcategory} grade`);
  if (a.experience === "new" && gradeRank(c) && experiencePoints("new", gradeRank(c)) >= 10)
    parts.push("an easy-going grade to start with");
  const bw = bandWords(band);
  if (overBudget) parts.push("slightly over your budget");
  else if (bw) parts.push(`inside ${bw}`);
  if (c.regularPrice != null && c.regularPrice > c.price)
    parts.push(`on special (usually ${rand(c.regularPrice)})`);
  return parts.length ? parts.join(" · ") : "In stock now and in your format";
}

/**
 * Up to 3 cards. When nothing fits: drop the strain preference first, then widen the budget by one band, and say so.
 * The format is never changed silently: an empty result names the formats that do have stock instead.
 */
export function matchProducts(
  cands: Candidate[],
  a: Answers,
  opts: { exclude?: string[]; limit?: number } = {},
): MatchResult {
  const exclude = new Set(opts.exclude ?? []);
  const limit = opts.limit ?? 3;
  const pool = poolFor(cands, a);
  const band = bandFor(pool, a.budget);
  const want = wantedStrain(a);
  const bands = budgetBands(pool);
  const live = pool.filter((c) => !exclude.has(c.id));
  const fitsBudget = (c: Candidate) => !band || inBand(band, c.price);
  const fitsStrain = (c: Candidate) => !want || strainOf(c.strainType) === want;

  const make = (list: Candidate[], relaxed: Relaxed, note: string | null): MatchResult => {
    const picks = pickDiverse(rank(list, a, band), limit);
    return {
      status: "matched",
      relaxed,
      note,
      cards: picks.map(({ c, score }) => {
        const over = band ? !inBand(band, c.price) && c.price > band.max : false;
        return { ...c, score, overBudget: over, why: whyItFits(c, a, band, over) };
      }),
    };
  };

  const exact = live.filter((c) => fitsBudget(c) && fitsStrain(c));
  if (exact.length) return make(exact, null, null);

  const anyStrain = live.filter(fitsBudget);
  if (want && anyStrain.length) {
    const top = rank(anyStrain, a, band)[0]!.c;
    const topStrain = strainOf(top.strainType);
    return make(
      anyStrain,
      "strain",
      `No ${want} ${band && !band.any ? "in your budget " : ""}today, but ${topStrain ? `this ${topStrain} is close` : "these are close"}.`,
    );
  }

  if (band && !band.any) {
    // Strain is already dropped here (step 1 of relaxing); now one band up.
    const i = bands.findIndex((b) => b.key === band.key);
    const wider = bands[i + 1];
    if (wider) {
      const widened = live.filter((c) => c.price >= band.min && c.price <= wider.max);
      if (widened.length)
        return make(widened, "budget", "Slightly over your budget, but worth a look.");
    }
  }

  const others = (Object.keys(FORMAT_CATEGORIES) as Exclude<Format, "any">[])
    .filter(
      (f) =>
        f !== a.format &&
        poolFor(cands, { ...(a.experience ? { experience: a.experience } : {}), format: f }).some(
          (c) => !exclude.has(c.id),
        ),
    )
    .map((f) => ({ value: f as Format, label: FORMAT_LABEL[f] }));
  return {
    status: "empty",
    note: exclude.size
      ? "That's everything that fits right now."
      : `No ${FORMAT_NOUN[a.format ?? "any"]} in stock right now${band && !band.any ? " in that budget" : ""}.`,
    otherFormats: others,
  };
}

// ---- answers from the browser ----------------------------------------------------------------------------------------

const ONE_OF = <T extends string>(v: unknown, xs: readonly T[]): T | undefined =>
  typeof v === "string" && (xs as readonly string[]).includes(v) ? (v as T) : undefined;

/** Only known keys and values survive; anything else (prices, ids, stock) is dropped. */
export function cleanAnswers(raw: unknown): Answers {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const a: Answers = {};
  const e = ONE_OF(r["experience"], ["new", "sometimes", "regular"] as const);
  const f = ONE_OF(r["format"], ["flower", "preroll", "edible", "vape", "cbd", "any"] as const);
  const v = ONE_OF(r["vibe"], ["chill", "social", "daytime", "unsure"] as const);
  const s = ONE_OF(r["strain"], ["Indica", "Sativa", "Hybrid", "none"] as const);
  const b = ONE_OF(r["budget"], ["low", "mid", "high", "any"] as const);
  if (e) a.experience = e;
  if (e && f) a.format = f;
  if (e && f && v) a.vibe = v;
  if (e && f && s) a.strain = s;
  if (e && f && b) a.budget = b;
  return a;
}
