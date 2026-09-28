import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { BadgeCheck, Bell, CalendarClock, CircleUserRound, CreditCard, Headphones, Heart, LayoutDashboard, ListOrdered, LogOut, MapPin, Package, Settings, ShieldCheck, ShoppingBag, Sparkles, Truck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { DashboardSidebar, type SidebarItem } from "@/components/dashboard/Sidebar";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { rand } from "@/lib/cart";
import { listMemberOrdersFn, listStoreProductsFn } from "@/lib/admin.functions";
import { getCatalogImage } from "@/fixtures/catalog-presentation";
import heroImage from "@/assets/cannaplug-hero.jpg";
import logoImage from "@/assets/cannaplug-logo.png";
import logoImageWhite from "@/assets/cannaplug-logo-white.png";

export const Route = createFileRoute("/account")({
  head: () => ({ meta: [{ title: "My Account | CannaPlug" }] }),
  component: AccountPage,
});

function AccountPage() {
  const { user, loading } = useAuth();
  if (loading) return <div className="grid min-h-screen place-items-center bg-background"><p className="text-sm text-muted-foreground">Loading your account…</p></div>;
  return user ? <MemberPortal /> : <AuthPanel />;
}

function AuthPanel() {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [fullName, setFullName] = useState("");
  const [submitting, setSubmitting] = useState(false); const [error, setError] = useState<string | null>(null); const [notice, setNotice] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSubmitting(true); setError(null); setNotice(null);
    try {
      if (mode === "signin") {
        const { error: signInError } = await supabase.auth.signInWithPassword({ email, password }); if (signInError) throw signInError;
      } else {
        const { error: signUpError } = await supabase.auth.signUp({ email, password, options: { data: { full_name: fullName } } }); if (signUpError) throw signUpError;
        setNotice("Account created — check your inbox to confirm your email, then sign in.");
      }
    } catch (err) { setError(err instanceof Error ? err.message : "Something went wrong. Please try again."); }
    finally { setSubmitting(false); }
  };
  return <div className="site"><div className="grid min-h-screen grid-cols-1 lg:grid-cols-2">
    <div className="relative hidden overflow-hidden bg-charcoal lg:block"><img src={heroImage} alt="Premium cannabis flower at CannaPlug" className="absolute inset-0 h-full w-full object-cover opacity-70" /><div className="absolute inset-0 bg-gradient-to-t from-charcoal via-charcoal/40 to-transparent" /><div className="relative flex h-full flex-col justify-between p-10 text-primary-foreground"><Link to="/"><img src={logoImageWhite} alt="CannaPlug" className="h-7 w-auto" /></Link><div><p className="mb-2 text-xs font-bold uppercase tracking-[0.2em] text-sage">Good Plants, Great People.</p><h1 className="font-display text-4xl font-extrabold leading-[0.95]">{mode === "signin" ? <>Welcome<br />back.</> : <>Join the<br />community.</>}</h1><p className="mt-3 max-w-sm text-sm text-primary-foreground/80">{mode === "signin" ? "Log in to your account and continue your cannabis journey." : "Create an account to track orders and manage your membership."}</p></div></div>
    <div className="flex items-center justify-center px-6 py-16"><div className="w-full max-w-sm"><Link to="/" className="mb-8 block lg:hidden"><img src={logoImage} alt="CannaPlug" className="h-7 w-auto" /></Link><h2 className="font-display text-2xl font-extrabold uppercase">{mode === "signin" ? "Sign in" : "Create account"}</h2><p className="mt-1 text-sm text-muted-foreground">{mode === "signin" ? "New to CannaPlug?" : "Already have an account?"}{" "}<button type="button" className="font-semibold text-primary underline-offset-2 hover:underline" onClick={() => setMode(mode === "signin" ? "signup" : "signin")}>{mode === "signin" ? "Create an account" : "Sign in instead"}</button></p><form onSubmit={submit} className="mt-6 flex flex-col gap-4">{mode === "signup" && <div className="grid gap-1.5"><Label>Full name</Label><Input value={fullName} onChange={(e) => setFullName(e.target.value)} required /></div>}<div className="grid gap-1.5"><Label>Email address</Label><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></div><div className="grid gap-1.5"><Label>Password</Label><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} /></div>{error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>}{notice && <p className="rounded-md bg-primary/10 px-3 py-2 text-xs text-primary">{notice}</p>}<Button type="submit" size="lg" disabled={submitting}>{submitting ? "Please wait…" : mode === "signin" ? "Sign in" : "Create account"}</Button></form><div className="mt-8 grid grid-cols-3 gap-3 border-t border-border pt-6 text-center text-[0.62rem] font-semibold uppercase text-muted-foreground"><div className="flex flex-col items-center gap-2"><ShieldCheck size={18} className="text-primary" />Lab tested</div><div className="flex flex-col items-center gap-2"><Truck size={18} className="text-primary" />Discreet delivery</div><div className="flex flex-col items-center gap-2"><Headphones size={18} className="text-primary" />Expert support</div></div><p className="mt-6 flex items-center justify-center gap-1 text-[0.6rem] text-muted-foreground"><BadgeCheck size={12} /> Responsible consumption. 18+ only.</p></div></div>
  </div></div>;
}

const NAV_ITEMS: SidebarItem[] = [
  { id: "dashboard", icon: LayoutDashboard, label: "Dashboard" }, { id: "orders", icon: ListOrdered, label: "Orders" }, { id: "saved", icon: Heart, label: "Saved Products" }, { id: "rewards", icon: Sparkles, label: "Rewards & Loyalty" }, { id: "addresses", icon: MapPin, label: "Delivery Addresses" }, { id: "payment", icon: CreditCard, label: "Payment Methods" }, { id: "settings", icon: Settings, label: "Account Settings" }, { id: "help", icon: Headphones, label: "Help & Support" },
];

function MemberPortal() {
  const { user, signOut } = useAuth();
  const [tab, setTab] = useState("dashboard");
  const [orders, setOrders] = useState<Awaited<ReturnType<typeof listMemberOrdersFn>>>([]);
  const [products, setProducts] = useState<Awaited<ReturnType<typeof listStoreProductsFn>>>([]);
  useEffect(() => {
    void Promise.all([listMemberOrdersFn(), listStoreProductsFn()]).then(([orderRows, productRows]) => { setOrders(orderRows); setProducts(productRows); });
  }, []);
  const displayName = (user?.user_metadata?.["full_name"] as string | undefined) ?? user?.email ?? "Member";
  const spend = orders.filter((order) => order.status === "completed").reduce((sum, order) => sum + Number(order.total_rand), 0);
  const rewardsPoints = Math.floor(spend / 10);
  const rewardsToNextTier = 500 - (rewardsPoints % 500);
  const rewardsPercent = rewardsPoints % 500;
  const saved = products.slice(0, 3);
  const recommended = products.slice(3, 6);

  return <div className="site flex min-h-screen flex-col bg-background md:flex-row">
    <DashboardSidebar items={NAV_ITEMS} active={tab} onSelect={setTab} header={<Link to="/"><img src={logoImage} alt="CannaPlug" className="h-6 w-auto" /></Link>} footer={<button onClick={() => void signOut()} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-destructive"><LogOut size={17} /> Sign out</button>} />
    <main className="flex-1 overflow-y-auto px-4 pb-24 pt-6 sm:px-8 sm:pt-8 md:pb-8">
      <header className="mb-6 flex items-center justify-between"><div><p className="text-xs text-muted-foreground">Good to see you</p><h1 className="font-display text-2xl font-extrabold uppercase">{displayName}</h1></div><span className="grid h-10 w-10 place-items-center rounded-full bg-primary text-primary-foreground"><CircleUserRound size={18} /></span></header>
      {tab === "dashboard" && <div className="flex flex-col gap-6">
        <section className="grid grid-cols-1 gap-4 sm:grid-cols-3"><div className="rounded-xl bg-primary p-5 text-primary-foreground"><p className="text-xs uppercase opacity-70">Orders</p><p className="font-display text-2xl font-extrabold">{orders.length}</p></div><div className="rounded-xl border border-border bg-card p-5"><p className="text-xs uppercase text-muted-foreground">Total spent</p><p className="font-display text-2xl font-extrabold">{rand(spend)}</p></div><div className="rounded-xl border border-border bg-card p-5"><p className="text-xs uppercase text-muted-foreground">Rewards points</p><p className="font-display text-2xl font-extrabold">{rewardsPoints}</p></div></section>
        <section className="grid grid-cols-1 gap-6 lg:grid-cols-3"><div className="rounded-xl border border-border bg-card p-5"><div className="mb-3 flex items-center justify-between"><h3 className="font-display text-sm font-bold uppercase">Recent Orders</h3><button onClick={() => setTab("orders")} className="text-xs font-semibold text-primary">View all</button></div>{orders.slice(0, 5).map((order) => <div key={order.id} className="flex items-center justify-between border-b border-border py-3 text-xs last:border-0"><div><p className="font-semibold">{order.order_number}</p><p className="text-muted-foreground">{new Date(order.created_at).toLocaleDateString("en-ZA")}</p></div><Badge>{order.status}</Badge></div>)}</div>
        <div className="rounded-xl border border-border bg-card p-5"><h3 className="mb-3 font-display text-sm font-bold uppercase">Saved Products</h3>{saved.map((p) => <div key={p.id} className="flex items-center gap-3 border-b border-border py-3 last:border-0"><img src={getCatalogImage(p.category)} alt="" className="h-10 w-10 rounded-lg object-cover" /><div className="flex-1 text-xs"><p className="font-semibold">{p.name}</p><p className="text-muted-foreground">{p.category}</p></div><b>{rand(p.price_rand)}</b></div>)}</div>
        <div className="rounded-xl border border-border bg-card p-5"><h3 className="mb-3 font-display text-sm font-bold uppercase">Recommended</h3>{recommended.map((p) => <div key={p.id} className="flex items-center gap-3 border-b border-border py-3 last:border-0"><img src={getCatalogImage(p.category)} alt="" className="h-10 w-10 rounded-lg object-cover" /><div className="flex-1 text-xs"><p className="font-semibold">{p.name}</p><p className="text-muted-foreground">{p.category}</p></div><b>{rand(p.price_rand)}</b></div>)}</div></section>
      </div>}
      {tab === "orders" && <div className="flex flex-col gap-4"><h2 className="font-display text-lg font-bold uppercase">Order history</h2>{orders.map((order) => <div key={order.id} className="rounded-xl border border-border bg-card p-5"><div className="mb-3 flex items-center justify-between"><div><p className="font-semibold">{order.order_number}</p><p className="text-xs text-muted-foreground">{new Date(order.created_at).toLocaleDateString("en-ZA")}</p></div><Badge>{order.status}</Badge></div><ul className="mb-3 text-xs text-muted-foreground">{order.items.map((item) => <li key={item.id}>{item.quantity} × {item.product_name}</li>)}</ul><p className="text-right text-sm font-bold">{rand(order.total_rand)}</p></div>)}</div>}
      {tab === "saved" && <div><h2 className="mb-4 font-display text-lg font-bold uppercase">Saved Products</h2><div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">{products.map((p) => <div key={p.id} className="flex items-center gap-3 rounded-xl border border-border bg-card p-4"><img src={getCatalogImage(p.category)} alt="" className="h-14 w-14 rounded-lg object-cover" /><div className="flex-1"><p className="text-sm font-semibold">{p.name}</p><p className="text-xs text-muted-foreground">{p.subcategory ?? p.category}</p></div><b className="text-sm">{rand(p.price_rand)}</b></div>)}</div></div>}
      {tab === "rewards" && <div className="max-w-lg rounded-xl border border-border bg-card p-6"><h2 className="mb-2 font-display text-lg font-bold uppercase">Rewards & loyalty</h2><p className="mb-4 text-sm text-muted-foreground">Points are calculated from completed account spend at 1 point per R10. A persisted loyalty ledger will be introduced separately.</p><div className="mb-2 flex justify-between text-xs font-semibold"><span>{rewardsPoints} points</span><span>{rewardsPoints + rewardsToNextTier} points</span></div><Progress value={rewardsPercent} /></div>}
      {tab === "addresses" && <div className="max-w-lg rounded-xl border border-border bg-card p-6"><h2 className="mb-4 font-display text-lg font-bold uppercase">Delivery addresses</h2><p className="text-sm text-muted-foreground">Saved delivery addresses are managed securely in your account. Address editing is scheduled for the fulfilment milestone.</p></div>}
      {tab === "payment" && <div className="max-w-lg rounded-xl border border-border bg-card p-6"><h2 className="mb-4 font-display text-lg font-bold uppercase">Payment methods</h2><p className="text-sm text-muted-foreground">Payments and POS are intentionally outside Milestone 2.</p></div>}
      {tab === "settings" && <div className="max-w-lg rounded-xl border border-border bg-card p-6"><h2 className="mb-4 font-display text-lg font-bold uppercase">Account settings</h2><div className="grid gap-4"><div><Label>Email</Label><Input value={user?.email ?? ""} disabled /></div><div><Label>Name</Label><Input value={displayName} disabled /></div></div></div>}
      {tab === "help" && <div className="max-w-lg rounded-xl border border-border bg-card p-6"><h2 className="mb-2 font-display text-lg font-bold uppercase">Help & support</h2><p className="text-sm text-muted-foreground">Our team is here Mon–Fri 09:00–19:00, Sat 09:00–20:00, Sun 09:00–15:00.</p><div className="mt-3 flex items-center gap-2 text-sm"><CalendarClock size={16} className="text-primary" /> +27 10 123 4567</div><div className="mt-2 flex items-center gap-2 text-sm"><Bell size={16} className="text-primary" /> hello@cannaplug.co.za</div></div>}
    </main>
  </div>;
}
