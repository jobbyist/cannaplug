import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Bot, Check, CreditCard, Gift, Loader2, MessageSquare, Percent, Store } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import cannaplugLogo from "@/assets/cannaplug-logo-white.png";
import "@/subscribe-admin-api.css";

type Interval = "monthly" | "annual";

export const Route = createFileRoute("/subscribe/admin-api")({
  validateSearch: (search: Record<string, unknown>) => ({
    subscription_id:
      typeof search["subscription_id"] === "string" ? search["subscription_id"] : undefined,
    cancelled: search["cancelled"] === "1" || search["cancelled"] === 1 ? true : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Shopify Admin API Integration – Basic | Cannaplug Pty Ltd" },
      {
        name: "description",
        content:
          "Activate the Shopify Admin API Integration – Basic subscription from Cannaplug Pty Ltd. $25/month billed monthly or $19/month billed annually, excluding tax. Pay securely with PayPal.",
      },
    ],
    links: [
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400;500;600&display=swap",
      },
    ],
  }),
  component: AdminApiLanding,
});

const FEATURES: { icon: typeof Store; title: string; body: string }[] = [
  {
    icon: Store,
    title: "Sell online, in person, and in AI chats",
    body: "One integration, every place your customers buy.",
  },
  {
    icon: CreditCard,
    title: "2% 3rd-party payment providers",
    body: "Use the payment providers you already trust.",
  },
  {
    icon: Bot,
    title: "Built-in AI assistant",
    body: "Get answers and get things done without leaving your workflow.",
  },
  {
    icon: MessageSquare,
    title: "Millions of tokens",
    body: "Plenty of AI capacity included to build and automate with.",
  },
  {
    icon: Gift,
    title: "Earn up to $3,500 in credits",
    body: "Credits to put back into growing your business.",
  },
  {
    icon: Percent,
    title: "Get up to 0.5% back on all sales*",
    body: "*When you choose annual billing.",
  },
];

const PLAN_FEATURES: { text: string; annualOnly?: boolean }[] = [
  { text: "Sell online, in person, and in AI chats" },
  { text: "2% 3rd-party payment providers" },
  { text: "Built-in AI assistant" },
  { text: "Millions of tokens" },
  { text: "Earn up to $3,500 in credits" },
  { text: "Get up to 0.5% back on all sales*", annualOnly: true },
];

const FAQ = [
  {
    q: "What am I subscribing to?",
    a: "Shopify Admin API Integration – Basic is a custom development service delivered by Cannaplug Pty Ltd, billed as a recurring subscription.",
  },
  {
    q: "Are prices inclusive of tax?",
    a: "No. Prices are shown excluding tax. Any applicable tax is added at checkout.",
  },
  {
    q: "How does billing work?",
    a: "Choose monthly ($25/month) or annual ($19/month, billed as $228 once a year). Payment is handled by PayPal and you can manage or cancel the subscription from your PayPal account at any time.",
  },
  {
    q: "Do I need a PayPal account?",
    a: "You'll approve the subscription on PayPal's secure page. Cannaplug never sees or stores your payment details.",
  },
];

function Check2() {
  return <Check size={18} strokeWidth={2.5} aria-hidden />;
}

function Brand() {
  return (
    <a
      href="/subscribe/admin-api"
      className="aapi-brand"
      aria-label="Cannaplug — Admin API integration"
    >
      <img src={cannaplugLogo} alt="Cannaplug" />
      <span className="aapi-plus" aria-hidden />
      <img src="/shopify-api.png" alt="Admin API integration partner" />
    </a>
  );
}

function AdminApiLanding() {
  const { subscription_id, cancelled } = Route.useSearch();
  const [interval, setInterval] = useState<Interval>("annual");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<string | null>(null);

  useEffect(() => {
    if (!subscription_id) return;
    let live = true;
    supabase.functions
      .invoke("paypal-subscription", {
        body: { action: "confirm", subscriptionId: subscription_id },
      })
      .then(({ data, error: err }) => {
        if (!live) return;
        if (err || !data?.status)
          setError("We couldn't confirm your subscription yet. Please contact us.");
        else setConfirmed(data.status as string);
      });
    return () => {
      live = false;
    };
  }, [subscription_id]);

  async function activate() {
    setBusy(true);
    setError(null);
    const { data, error: err } = await supabase.functions.invoke("paypal-subscription", {
      body: { action: "create", interval },
    });
    if (err || !data?.approveUrl) {
      setError("We couldn't start PayPal checkout. Please try again shortly.");
      setBusy(false);
      return;
    }
    window.location.href = data.approveUrl as string;
  }

  const annual = interval === "annual";

  return (
    <div className="aapi">
      <header className="aapi-head">
        <div className="aapi-wrap">
          <Brand />
          <nav className="aapi-nav" aria-label="Page sections">
            <a href="#features">Features</a>
            <a href="#pricing">Pricing</a>
            <a href="#faq">FAQ</a>
          </nav>
          <a href="#pricing" className="aapi-btn">
            Get started
          </a>
        </div>
      </header>

      {confirmed && (
        <div className="aapi-banner" role="status">
          <div className="aapi-wrap">
            {confirmed === "ACTIVE"
              ? "Your subscription is active. Thank you — we'll be in touch to begin onboarding."
              : `Thanks — your subscription is ${confirmed.toLowerCase().replace(/_/g, " ")}. We'll email you once it's active.`}
          </div>
        </div>
      )}
      {cancelled && !confirmed && (
        <div className="aapi-banner aapi-banner--warn" role="status">
          <div className="aapi-wrap">PayPal checkout was cancelled. You haven't been charged.</div>
        </div>
      )}

      <section className="aapi-hero">
        <div className="aapi-wrap">
          <div>
            <span className="aapi-eyebrow">Custom development · Cannaplug Pty Ltd</span>
            <h1>
              Shopify Admin API <em>Integration</em> — Basic
            </h1>
            <p className="aapi-lede">
              Connect your store to the Shopify Admin API and sell online, in person, and in AI
              chats. Activate in minutes with PayPal — from $19/month, excluding tax.
            </p>
            <div className="aapi-cta-row">
              <a href="#pricing" className="aapi-btn">
                Activate subscription
              </a>
              <a href="#features" className="aapi-btn aapi-btn--ghost">
                See what's included
              </a>
            </div>
          </div>
          <pre className="aapi-code" aria-hidden>
            <span className="d" />
            <span className="d" />
            <span className="d" />
            {"\n"}
            <span className="c">{"// Admin API · products, orders, inventory"}</span>
            {"\n"}
            <span className="k">POST</span> /admin/api/graphql.json{"\n"}
            {"{\n  "}
            <span className="s">"query"</span>: <span className="s">"{"{ shop { name } }"}"</span>
            {"\n}\n\n"}
            <span className="c">{"// → 200 OK"}</span>
            {"\n{ "}
            <span className="s">"shop"</span>: {"{ "}
            <span className="s">"name"</span>: <span className="s">"Your store"</span>
            {" } }"}
          </pre>
        </div>
      </section>

      <section id="features" className="aapi-sec aapi-sec--alt">
        <div className="aapi-wrap aapi-center">
          <h2>Everything in the Basic plan</h2>
          <p className="aapi-sub">
            One subscription. Everything you need to start building on the Admin API.
          </p>
          <div className="aapi-grid" style={{ textAlign: "left" }}>
            {FEATURES.map(({ icon: Icon, title, body }) => (
              <div className="aapi-card" key={title}>
                <div className="ic">
                  <Icon size={22} aria-hidden />
                </div>
                <h3>{title}</h3>
                <p>{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="pricing" className="aapi-sec">
        <div className="aapi-wrap aapi-center">
          <h2>Simple, predictable pricing</h2>
          <p className="aapi-sub">Choose how you'd like to be billed. Prices exclude tax.</p>
          <div className="aapi-toggle" role="group" aria-label="Billing period">
            <button type="button" aria-pressed={!annual} onClick={() => setInterval("monthly")}>
              Monthly
            </button>
            <button type="button" aria-pressed={annual} onClick={() => setInterval("annual")}>
              Annual<small>SAVE 24%</small>
            </button>
          </div>

          <div className="aapi-plan">
            <div className="aapi-plan-l">
              <h3>Shopify Admin API Integration – Basic</h3>
              <p>Custom development service by Cannaplug Pty Ltd</p>
              <div className="aapi-price">
                <b>${annual ? 19 : 25}</b>
                <span>per month, excl. tax</span>
              </div>
              <div className="aapi-billed">
                {annual ? "Billed annually ($228/year, excl. tax)" : "Billed monthly"}
              </div>
              <button
                type="button"
                className="aapi-btn aapi-btn--lg"
                onClick={activate}
                disabled={busy}
              >
                {busy ? <Loader2 size={18} className="animate-spin" aria-hidden /> : null}
                {busy ? "Redirecting to PayPal…" : "Activate with PayPal"}
              </button>
              {error && (
                <div className="aapi-err" role="alert">
                  {error}
                </div>
              )}
              <div className="aapi-fine">Secure checkout via PayPal. Cancel anytime.</div>
            </div>
            <div className="aapi-plan-r">
              <h4>What's included</h4>
              <ul className="aapi-list">
                {PLAN_FEATURES.map((f) => {
                  const off = f.annualOnly && !annual;
                  return (
                    <li key={f.text} className={off ? "off" : undefined}>
                      <Check2 />
                      <span>{f.text}</span>
                    </li>
                  );
                })}
              </ul>
              <p className="aapi-foot">*Available when you choose annual billing.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="aapi-sec aapi-sec--alt">
        <div className="aapi-wrap aapi-center">
          <h2>Up and running in three steps</h2>
          <p className="aapi-sub">No lengthy contracts. Activate, then we take it from there.</p>
          <div className="aapi-grid" style={{ textAlign: "left" }}>
            {[
              ["Step 1", "Choose your billing", "Pick monthly or annual and review the price."],
              [
                "Step 2",
                "Approve on PayPal",
                "You're taken to PayPal's secure page to authorise the subscription.",
              ],
              [
                "Step 3",
                "We begin onboarding",
                "Once active, Cannaplug gets started on your integration.",
              ],
            ].map(([n, t, b]) => (
              <div className="aapi-card" key={n}>
                <span className="aapi-step">{n}</span>
                <h3>{t}</h3>
                <p>{b}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="faq" className="aapi-sec">
        <div className="aapi-wrap">
          <h2 className="aapi-center" style={{ marginBottom: 40 }}>
            Questions, answered
          </h2>
          <div className="aapi-faq">
            {FAQ.map(({ q, a }) => (
              <details key={q}>
                <summary>{q}</summary>
                <p>{a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <footer className="aapi-footer">
        <div className="aapi-wrap">
          <Brand />
          <nav aria-label="Footer">
            <a href="#features">Features</a>
            <a href="#pricing">Pricing</a>
            <a href="#faq">FAQ</a>
            <a href="/terms-of-service">Terms</a>
            <a href="/privacy-policy">Privacy</a>
          </nav>
          <p className="aapi-legal">
            © {new Date().getFullYear()} Cannaplug Pty Ltd. Prices exclude tax. *Cashback applies
            when you choose annual billing.
          </p>
        </div>
      </footer>
    </div>
  );
}
