// Captures the screenshots used in the PDF guide from the LIVE local stack (scripts/live-stack/up.sh + app on :4173).
//   set -a; . /tmp/live.env; set +a; . scripts/live-stack/app-env.sh
//   bun scripts/pdf/capture-screens.ts
import { readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "@playwright/test";
import { API, ANON, PASSWORD, SERVICE, sql } from "../../e2e/live/db";

const run = JSON.parse(
  readFileSync(new URL("../../e2e/live/.run.json", import.meta.url), "utf8"),
) as Record<string, string>;
const OUT = new URL("../../docs/guide/screens/", import.meta.url).pathname;
const BASE = process.env["LIVE_APP_URL"] ?? "http://127.0.0.1:4173";

async function mkUser(email: string, name: string, role: string) {
  const res = await fetch(`${API}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: SERVICE || ANON,
      authorization: `Bearer ${SERVICE}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      email,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: name },
    }),
  });
  if (!res.ok && res.status !== 422) throw new Error(`${email}: ${res.status}`);
  const id = sql(`select id from auth.users where email='${email}'`);
  sql(
    `insert into public.user_roles (user_id, role) values ('${id}', '${role}'::public.app_role) on conflict do nothing`,
  );
  sql(
    `insert into public.profiles (id, full_name, date_of_birth) values ('${id}', '${name}', '1980-03-02') on conflict (id) do update set full_name = '${name}'`,
  );
  return id;
}

async function seedDoctor() {
  const stamp = "guide";
  const admin = await mkUser(`admin-${stamp}@live.test`, "Alex Admin", "admin");
  const admin2 = await mkUser(`admin2-${stamp}@live.test`, "Sam Second", "admin");
  const doc = await mkUser(`doctor-${stamp}@live.test`, "Dr Jane Smith", "customer");
  const member = sql(`select id from auth.users where email='${run["member"]}'`);
  const exists = sql(`select count(*) from public.doctor_profiles where user_id='${doc}'`);
  if (exists === "0") {
    const d = sql(
      `select (public.doctor_admin_upsert('${admin}', '${doc}', '{"first_name":"Jane","last_name":"Smith","title":"Dr","hpcsa_number":"MP0123456","practice_number":"PR123","practice_name":"Pretoria Wellness Practice"}'::jsonb)->>'doctor_id')`,
    );
    sql(
      `select public.doctor_admin_set_status('${admin2}', '${d}'::uuid, 'verified', 'checked against register', true)`,
    );
    sql(`select public.doctor_assign_patient('${admin}', '${d}'::uuid, '${member}'::uuid, true)`);
  }
  return { admin: `admin-${stamp}@live.test`, doctor: `doctor-${stamp}@live.test` };
}

async function signIn(browser: Browser, email: string): Promise<Page> {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 860 },
    deviceScaleFactor: 1.5,
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/account`);
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForTimeout(2500);
  return page;
}

/** Demo-data hygiene for a client-facing document: no test e-mail addresses, and the chat tab out of the way. */
async function tidy(page: Page, keepChat: boolean) {
  await page.evaluate((hide) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    for (const n of nodes)
      if (n.nodeValue?.includes("@live.test"))
        n.nodeValue = n.nodeValue.replace(/[\w.+-]+@live\.test/g, "thandi.mokoena@example.com");
    for (const i of Array.from(document.querySelectorAll("input")))
      if (i.value.includes("@live.test")) i.value = "thandi.mokoena@example.com";
    if (hide)
      for (const el of Array.from(document.querySelectorAll("[class*='chat-']")))
        (el as HTMLElement).style.display = "none";
  }, !keepChat);
}

const shot = async (page: Page, name: string, opts: { full?: boolean; wait?: number } = {}) => {
  await page.waitForTimeout(opts.wait ?? 900);
  await tidy(page, name === "public-chat");
  await page.screenshot({
    path: `${OUT}${name}.jpg`,
    type: "jpeg",
    quality: 84,
    fullPage: opts.full ?? false,
  });
  console.log("captured", name);
};
const tab = async (page: Page, label: string | RegExp) => {
  await page
    .getByRole("button", { name: label, exact: typeof label === "string" })
    .first()
    .click();
};

const browser = await chromium.launch({
  executablePath: process.env["PLAYWRIGHT_CHROMIUM_PATH"] ?? "/opt/pw-browsers/chromium",
  args: ["--no-sandbox"],
});
const doctors = await seedDoctor();

// ---- public
{
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 860 },
    deviceScaleFactor: 1.5,
  });
  const p = await ctx.newPage();
  await p.goto(BASE);
  await shot(p, "public-home", { wait: 2500 });
  await p.goto(`${BASE}/shop`);
  await shot(p, "public-shop", { wait: 2000 });
  await p.goto(`${BASE}/journal`);
  await shot(p, "public-journal", { wait: 2000 });
  await p.goto(`${BASE}/faq`);
  await shot(p, "public-faq");
  await p.goto(`${BASE}/#contact`);
  await shot(p, "public-contact", { wait: 2000 });
  await p.goto(`${BASE}/account`);
  await shot(p, "member-signin");
  await p.goto(BASE);
  await p
    .getByText(/ask cannaplug/i)
    .first()
    .click()
    .catch(() => undefined);
  await shot(p, "public-chat", { wait: 1200 });
  await ctx.close();
}

// ---- member
{
  const p = await signIn(browser, run["member"]!);
  await shot(p, "member-dashboard");
  for (const [label, file] of [
    ["ID Verification", "member-id"],
    ["Orders", "member-orders"],
    ["Saved Products", "member-saved"],
    ["Rewards & Loyalty", "member-rewards"],
    ["Delivery Addresses", "member-addresses"],
    ["Payment Methods", "member-payment"],
    ["Account Settings", "member-settings"],
    ["Help & Support", "member-help"],
  ] as const) {
    try {
      await tab(p, label);
      await shot(p, file);
    } catch (e) {
      console.log("skip", file, String(e).slice(0, 80));
    }
  }
  await p.context().close();
}

// ---- checkout (a member who already has an address)
{
  const payerId = sql(`select id from auth.users where email='${run["payer"]}'`);
  if (sql(`select count(*) from public.addresses where user_id='${payerId}'`) === "0")
    sql(
      `insert into public.addresses (user_id, label, recipient_name, phone, line1, suburb, city, province, postal_code, is_default) values ('${payerId}', 'Home', 'Thandi Mokoena', '+27 82 123 4567', '12 Long Street', 'Gardens', 'Cape Town', 'Western Cape', '8001', true)`,
    );
  const p = await signIn(browser, run["payer"]!);
  await p.goto(BASE);
  const pid = sql(`select id from public.products where slug='live-blue-gelato'`);
  await p.evaluate(
    (id) =>
      localStorage.setItem(
        "cannaplug.cart.v1",
        JSON.stringify([
          { productId: id, name: "Blue Gelato", price: 100, unit: "per gram", quantity: 2 },
        ]),
      ),
    pid,
  );
  await p.goto(`${BASE}/checkout`);
  await shot(p, "checkout-cart");
  await p.getByRole("button", { name: /continue/i }).click();
  await p.getByLabel("Phone").fill("+27 82 123 4567");
  await shot(p, "checkout-details");
  await p
    .getByRole("button", { name: /continue/i })
    .click()
    .catch(() => undefined);
  await shot(p, "checkout-delivery");
  await p
    .getByLabel(/Discreet delivery/)
    .check()
    .catch(() => undefined);
  await p
    .getByRole("button", { name: /continue/i })
    .click()
    .catch(() => undefined);
  await shot(p, "checkout-payment", { wait: 1500 });
  await p.context().close();
}

// ---- staff
{
  const p = await signIn(browser, run["manager"]!);
  await p.goto(`${BASE}/admin`);
  await shot(p, "admin-overview", { wait: 2500 });
  for (const [label, file] of [
    ["POS", "admin-pos"],
    ["Orders", "admin-orders"],
    ["Payments", "admin-payments"],
    ["Products", "admin-products"],
    ["Inventory", "admin-inventory"],
    ["Customers", "admin-customers"],
    ["ID Checks", "admin-idchecks"],
    ["Deliveries", "admin-deliveries"],
    ["Audit log", "admin-audit"],
  ] as const) {
    try {
      await tab(p, label);
      await shot(p, file, { wait: 1800 });
    } catch (e) {
      console.log("skip", file, String(e).slice(0, 80));
    }
  }
  await tab(p, "Orders");
  await p
    .getByRole("row")
    .nth(1)
    .click()
    .catch(() => undefined);
  await shot(p, "admin-order-detail", { wait: 1800 });
  await p.context().close();
}

// ---- administrator (clinical admin screens need the admin role)
{
  const p = await signIn(browser, doctors.admin);
  await p.goto(`${BASE}/admin`);
  await tab(p, "Clinical Docs");
  await shot(p, "admin-clinical", { wait: 2200 });
  await p.context().close();
}

// ---- doctor
{
  const p = await signIn(browser, doctors.doctor);
  await p.goto(`${BASE}/doctor`);
  await shot(p, "doctor-home", { wait: 2500 });
  for (const [label, file] of [
    ["Documents", "doctor-documents"],
    ["Patients", "doctor-patients"],
    ["Templates", "doctor-templates"],
    ["Requests", "doctor-requests"],
  ] as const) {
    try {
      await tab(p, new RegExp(label, "i"));
      await shot(p, file, { wait: 1500 });
    } catch (e) {
      console.log("skip", file, String(e).slice(0, 80));
    }
  }
  await p.context().close();
}
await browser.close();
