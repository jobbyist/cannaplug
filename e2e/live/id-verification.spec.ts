import { expect, test, type Browser, type Page } from "@playwright/test";
import {
  ANON,
  API,
  MANAGER,
  PASSWORD,
  SERVICE,
  productId,
  signInUi,
  sql,
  uniq,
  userId,
} from "./helpers";

/**
 * LIVE ID verification: sign-up with a date of birth -> ID upload to the real private Storage bucket ->
 * checkout blocked -> a manager reviews it in /admin (audited image view) -> the member's page flips to
 * "Verified" live over Realtime -> checkout opens. Plus rejection with a reason, resubmission, and the
 * direct-API attacks a hostile member would try. Real Chromium, GoTrue, PostgREST, Realtime, Storage.
 * Serial: later tests use earlier state.
 */
test.describe.configure({ mode: "serial" });

// 1x1 transparent PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const idFile = { name: "my-id.png", mimeType: "image/png", buffer: PNG };

const stamp = Date.now().toString(36);
const NEWBIE = `newbie-${stamp}@live.test`;
const REJECTED = `rejected-${stamp}@live.test`;
// Names carry the run stamp so the reviewer's queue (which keeps earlier runs' members) stays unambiguous.
const NINA = `Nina Newbie ${stamp}`;
const REX = `Rex Rejected ${stamp}`;

const verificationOf = (email: string) =>
  sql(
    `select status || '|' || coalesce(attempt_count::text,'') || '|' || coalesce(rejection_code,'') from public.customer_verification where user_id='${userId(email)}'`,
  );
const filesFor = (email: string) =>
  Number(
    sql(
      `select count(*) from storage.objects where bucket_id='id-documents' and name like '${userId(email)}/%'`,
    ),
  );
const audit = (action: string, email: string) =>
  Number(
    sql(
      `select count(*) from public.audit_log where action='${action}' and target_user_id='${userId(email)}'`,
    ),
  );

async function signUpUi(page: Page, email: string, name: string, dob: string) {
  await page.goto("/account");
  await page.getByRole("button", { name: "Create an account" }).click();
  await page.locator("input:not([type])").first().fill(name);
  await page.getByLabel("Date of birth").fill(dob);
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: "Create account", exact: true }).click();
}

async function uploadId(page: Page, file = idFile) {
  await page.getByLabel(/photo or scan/i).setInputFiles(file);
  await page.getByRole("button", { name: /submit for review/i }).click();
}

async function staffPage(browser: Browser) {
  const ctx = await browser.newContext();
  const staff = await ctx.newPage();
  await signInUi(staff, MANAGER);
  await staff.goto("/admin");
  await staff.getByRole("button", { name: "ID Checks", exact: true }).first().click();
  return staff;
}

test("sign-up asks for a date of birth, and the browser refuses an under-18 date", async ({
  page,
}) => {
  await page.goto("/account");
  await page.getByRole("button", { name: "Create an account" }).click();
  const dob = page.getByLabel("Date of birth");
  await expect(dob).toBeVisible();
  const young = new Date();
  young.setFullYear(young.getFullYear() - 16);
  await dob.fill(young.toISOString().slice(0, 10));
  expect(await dob.evaluate((el: HTMLInputElement) => el.validity.rangeOverflow)).toBe(true);
  const before = sql(`select count(*) from auth.users`);
  await page.locator("input:not([type])").first().fill("Too Young");
  await page.locator('input[type="email"]').fill(`young-${stamp}@live.test`);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page.getByText("Good to see you")).toHaveCount(0);
  expect(sql(`select count(*) from auth.users`)).toBe(before); // no account was created
});

test("a new member lands on ID verification; a non-image is refused and nothing is kept", async ({
  page,
}) => {
  await signUpUi(page, NEWBIE, NINA, "1992-04-20");
  // onboarding: the first screen is the verification step, not the dashboard
  await expect(page.getByRole("heading", { name: "ID verification" })).toBeVisible();
  await expect(page.getByTestId("verification-status")).toContainText(
    "Verify your ID to start ordering",
  );
  // the DOB from sign-up reached the profile
  expect(sql(`select date_of_birth from public.profiles where id='${userId(NEWBIE)}'`)).toBe(
    "1992-04-20",
  );

  await uploadId(page, {
    name: "evil.png",
    mimeType: "image/png",
    buffer: Buffer.from("MZ not an image at all"),
  });
  await expect(page.getByRole("alert")).toContainText(/doesn't look like a JPG, PNG, WebP or PDF/i);
  expect(verificationOf(NEWBIE)).toBe(""); // no submission recorded
  expect(filesFor(NEWBIE)).toBe(0); // and the rejected upload was deleted from storage
});

test("a valid upload becomes 'in review'; checkout explains why it can't proceed", async ({
  page,
}) => {
  await signInUi(page, NEWBIE);
  await expect(page.getByRole("heading", { name: "ID verification" })).toBeVisible();
  await uploadId(page);
  await expect(page.getByTestId("verification-status")).toContainText("being reviewed", {
    timeout: 30_000,
  });
  expect(verificationOf(NEWBIE)).toBe("pending|1|");
  expect(filesFor(NEWBIE)).toBe(1);
  expect(audit("id_verification_submitted", NEWBIE)).toBe(1);
  // the form is gone while pending
  await expect(page.getByRole("button", { name: /submit for review/i })).toHaveCount(0);

  // cart -> checkout -> Details step is gated
  await page.goto("/");
  await page.evaluate((line) => localStorage.setItem("cannaplug.cart.v1", JSON.stringify([line])), {
    productId: productId("live-blue-gelato"),
    name: "Live Blue Gelato",
    price: 100,
    unit: "per gram",
    quantity: 1,
  });
  await page.goto("/checkout");
  await page.getByRole("button", { name: /continue/i }).click();
  await expect(page.getByTestId("checkout-id-gate")).toContainText("being reviewed");
});

test("DIRECT API: a member cannot self-approve, read the ID path, or reach the bucket; the order RPC is closed", async () => {
  const login = await fetch(`${API}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "content-type": "application/json" },
    body: JSON.stringify({ email: NEWBIE, password: PASSWORD }),
  });
  const token = ((await login.json()) as { access_token: string }).access_token;
  const h = { apikey: ANON, authorization: `Bearer ${token}`, "content-type": "application/json" };
  const me = userId(NEWBIE);

  // self-approval through PostgREST
  const patch = await fetch(`${API}/rest/v1/customer_verification?user_id=eq.${me}`, {
    method: "PATCH",
    headers: { ...h, prefer: "return=representation" },
    body: JSON.stringify({ status: "verified" }),
  });
  expect(patch.ok).toBe(false);
  const insert = await fetch(`${API}/rest/v1/customer_verification`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({ user_id: me, status: "verified" }),
  });
  expect(insert.ok).toBe(false);
  expect(verificationOf(NEWBIE)).toBe("pending|1|");

  // the storage path and declared DOB are not selectable
  const cols = await fetch(`${API}/rest/v1/customer_verification?select=document_path`, {
    headers: h,
  });
  expect(cols.ok).toBe(false);
  const own = await fetch(`${API}/rest/v1/customer_verification?select=status,attempt_count`, {
    headers: h,
  });
  expect(await own.json()).toEqual([expect.objectContaining({ status: "pending" })]);

  // the review/submit RPCs are service-only
  for (const [fn, body] of [
    [
      "verification_review",
      {
        p_actor: me,
        p_user_id: me,
        p_decision: "approve",
        p_rejection_code: null,
        p_note: null,
        p_idempotency_key: "abcdefgh1",
      },
    ],
    [
      "verification_submit",
      {
        p_user_id: me,
        p_document_type: "sa_id",
        p_document_path: `${me}/x.png`,
        p_dob: "1990-01-01",
        p_idempotency_key: "abcdefgh1",
      },
    ],
    ["checkout_place_order", {}],
  ] as const) {
    const r = await fetch(`${API}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: h,
      body: JSON.stringify(body),
    });
    expect(r.ok, fn).toBe(false);
  }

  // storage: the member's own JWT can neither list the bucket nor fetch their own object nor upload directly
  const name = sql(
    `select name from storage.objects where bucket_id='id-documents' and name like '${me}/%' limit 1`,
  );
  const get = await fetch(`${API}/storage/v1/object/authenticated/id-documents/${name}`, {
    headers: h,
  });
  expect(get.ok).toBe(false);
  // Positive controls: the SAME requests succeed with the service key, so the refusals above are
  // authorization, not a mistyped URL.
  const svc = { apikey: SERVICE, authorization: `Bearer ${SERVICE}` };
  expect(
    (await fetch(`${API}/storage/v1/object/authenticated/id-documents/${name}`, { headers: svc }))
      .status,
  ).toBe(200);
  const svcList = await fetch(`${API}/storage/v1/object/list/id-documents`, {
    method: "POST",
    headers: { ...svc, "content-type": "application/json" },
    body: JSON.stringify({ prefix: me, limit: 10 }),
  });
  expect(((await svcList.json()) as unknown[]).length).toBeGreaterThan(0);
  const ctl = await fetch(`${API}/storage/v1/object/id-documents/control/${stamp}.png`, {
    method: "POST",
    headers: { ...svc, "content-type": "image/png" },
    body: PNG,
  });
  expect(ctl.ok).toBe(true);
  sql(`delete from storage.objects where bucket_id='id-documents' and name like 'control/%'`);
  const pub = await fetch(`${API}/storage/v1/object/public/id-documents/${name}`);
  expect(pub.ok).toBe(false);
  const list = await fetch(`${API}/storage/v1/object/list/id-documents`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({ prefix: "", limit: 10 }),
  });
  const listed = list.ok ? ((await list.json()) as unknown[]) : [];
  expect(listed).toHaveLength(0);
  const up = await fetch(`${API}/storage/v1/object/id-documents/${me}/direct.png`, {
    method: "POST",
    headers: { ...h, "content-type": "image/png" },
    body: PNG,
  });
  expect(up.ok).toBe(false);
});

test("ADMIN: the manager opens the ID (audited), approves, and the member's open page flips live", async ({
  browser,
}) => {
  // member keeps /account open to watch the decision arrive over Realtime
  const memberCtx = await browser.newContext();
  const member = await memberCtx.newPage();
  await signInUi(member, NEWBIE);
  await member.getByRole("button", { name: "ID Verification" }).first().click();
  await expect(member.getByTestId("verification-status")).toContainText("being reviewed");
  await member.waitForTimeout(2500); // let the websocket join before the decision lands

  const staff = await staffPage(browser);
  const row = staff.getByRole("row", { name: new RegExp(NINA) });
  await expect(row).toBeVisible();
  await expect(row).toContainText("1992-04-20");
  await row.getByRole("button", { name: "Review" }).click();

  const dialog = staff.getByRole("dialog");
  // Approve is locked until the reviewer attests they checked the ID
  await expect(dialog.getByRole("button", { name: "Approve" })).toBeDisabled();
  expect(audit("id_document_viewed", NEWBIE)).toBe(0);
  await dialog.getByRole("button", { name: /view id document/i }).click();
  const img = dialog.getByRole("img", { name: new RegExp(`ID document for ${NINA}`) });
  await expect(img).toBeVisible();
  await expect
    .poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth))
    .toBeGreaterThan(0);
  expect(audit("id_document_viewed", NEWBIE)).toBe(1); // audited before the image was served

  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Approve" }).click();
  await expect(staff.getByRole("status")).toContainText(`${NINA} is verified`);

  expect(verificationOf(NEWBIE)).toBe("verified|1|");
  expect(audit("id_verification_approved", NEWBIE)).toBe(1);
  // THE MEMBER'S PAGE: no reload
  await expect(member.getByTestId("verification-status")).toContainText("Your ID is verified", {
    timeout: 30_000,
  });
  await expect(member.getByRole("button", { name: /submit for review/i })).toHaveCount(0);
});

test("a verified member passes the checkout gate and can place an order", async ({ page }) => {
  await signInUi(page, NEWBIE);
  await page.goto("/");
  await page.evaluate((line) => localStorage.setItem("cannaplug.cart.v1", JSON.stringify([line])), {
    productId: productId("live-blue-gelato"),
    name: "Live Blue Gelato",
    price: 100,
    unit: "per gram",
    quantity: 1,
  });
  await page.goto("/checkout");
  await page.getByRole("button", { name: /continue/i }).click();
  await expect(page.getByTestId("checkout-id-gate")).toHaveCount(0);
  await page.getByLabel("Phone").fill("+27 82 123 4567");
  await page.getByText("+ Add a new address").click();
  await page.getByLabel("Street address").fill("1 Verified Road");
  await page.getByLabel("Suburb").fill("Gardens");
  await page.getByLabel("City").fill("Cape Town");
  await page.getByLabel("Postal code").fill("8001");
  await page.getByRole("button", { name: "Save address" }).click();
  await page.getByRole("button", { name: /continue/i }).click();
  await page.getByLabel(/Standard delivery/).check();
  await page.getByRole("button", { name: /continue/i }).click();
  await page.getByRole("button", { name: /place order/i }).click();
  await expect(page.getByText(/CP-/).first()).toBeVisible({ timeout: 30_000 });
  expect(Number(sql(`select count(*) from public.orders where user_id='${userId(NEWBIE)}'`))).toBe(
    1,
  );
});

test("REJECTION: the member sees the reason live, can resubmit, and the old file is replaced", async ({
  browser,
}) => {
  const memberCtx = await browser.newContext();
  const member = await memberCtx.newPage();
  await signUpUi(member, REJECTED, REX, "1988-01-02");
  await expect(member.getByRole("heading", { name: "ID verification" })).toBeVisible();
  await uploadId(member);
  await expect(member.getByTestId("verification-status")).toContainText("being reviewed", {
    timeout: 30_000,
  });
  await member.waitForTimeout(2500);

  const staff = await staffPage(browser);
  await staff
    .getByRole("row", { name: new RegExp(REX) })
    .getByRole("button", { name: "Review" })
    .click();
  const dialog = staff.getByRole("dialog");
  await dialog.getByRole("button", { name: "Reject…" }).click();
  // a reason is mandatory
  await expect(dialog.getByRole("button", { name: "Confirm rejection" })).toBeDisabled();
  await dialog.getByLabel(/Reason/).selectOption("unreadable");
  await dialog.getByRole("button", { name: "Confirm rejection" }).click();
  await expect(staff.getByRole("status")).toContainText(REX);
  expect(verificationOf(REJECTED)).toBe("rejected|1|unreadable");

  await expect(member.getByTestId("verification-status")).toContainText(
    "couldn't read your document",
    { timeout: 30_000 },
  );
  const firstFile = sql(
    `select name from storage.objects where bucket_id='id-documents' and name like '${userId(REJECTED)}/%'`,
  );

  await uploadId(member);
  await expect(member.getByTestId("verification-status")).toContainText("being reviewed", {
    timeout: 30_000,
  });
  expect(verificationOf(REJECTED)).toBe("pending|2|");
  expect(filesFor(REJECTED)).toBe(1); // the rejected upload was removed, only the new one remains
  expect(
    sql(
      `select count(*) from storage.objects where bucket_id='id-documents' and name='${firstFile}'`,
    ),
  ).toBe("0");
  // and they still cannot order while pending
  expect(sql(`select count(*) from public.orders where user_id='${userId(REJECTED)}'`)).toBe("0");
  void uniq;
});
