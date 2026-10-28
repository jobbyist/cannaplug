import { useCallback, useEffect, useState } from "react";
import { Mail, Send } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useIdempotencyKey } from "@/hooks/useIdempotencyKey";
import {
  emailActivityFn,
  listCampaignsFn,
  saveCampaignFn,
  sendCampaignFn,
  testCampaignFn,
} from "@/lib/email-campaigns.functions";
import { campaignProblem, type Form } from "@/components/admin/campaign-form";

type Listing = Awaited<ReturnType<typeof listCampaignsFn>>;
type Campaign = Listing["campaigns"][number];
type Activity = Awaited<ReturnType<typeof emailActivityFn>>;

const BLANK: Form = {
  subject: "",
  preheader: "",
  headline: "",
  body: "",
  ctaLabel: "Shop now",
  ctaUrl: "https://cannaplug012.co.za/shop",
};
const fromCampaign = (c: Campaign): Form => ({
  subject: c.subject,
  preheader: c.preheader ?? "",
  headline: c.headline,
  body: c.body,
  ctaLabel: c.cta_label ?? "",
  ctaUrl: c.cta_url ?? "",
});
const when = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("en-ZA", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";
const err = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

/** Admin → Promotions: write, test and send marketing emails, and see how every email is doing. */
export function EmailCampaignsPanel() {
  const [listing, setListing] = useState<Listing | null>(null);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; form: Form } | null>(null);
  const [busy, setBusy] = useState<null | "save" | "test" | "send">(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirm, setConfirm] = useState<{ id: string; subject: string } | null>(null);
  const saveKey = useIdempotencyKey();
  const sendKey = useIdempotencyKey();

  const load = useCallback(async () => {
    try {
      const [l, a] = await Promise.all([listCampaignsFn(), emailActivityFn()]);
      setListing(l);
      setActivity(a);
    } catch (e) {
      setMsg({ ok: false, text: err(e, "Could not load email.") });
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const set = (k: keyof Form, v: string) => {
    saveKey.reset();
    setEditing((cur) => (cur ? { ...cur, form: { ...cur.form, [k]: v } } : cur));
  };

  /** Saves the draft and returns its id (or null if it could not be saved). */
  const save = async (): Promise<string | null> => {
    if (!editing) return null;
    const problem = campaignProblem(editing.form);
    if (problem) {
      setMsg({ ok: false, text: problem });
      return null;
    }
    setBusy("save");
    setMsg(null);
    try {
      const f = editing.form;
      const r = await saveCampaignFn({
        data: {
          id: editing.id,
          input: {
            subject: f.subject,
            preheader: f.preheader,
            headline: f.headline,
            body: f.body,
            ctaLabel: f.ctaLabel,
            ctaUrl: f.ctaUrl,
          },
          key: saveKey.get(),
        },
      });
      saveKey.reset();
      setEditing({ id: r.id, form: f });
      setMsg({ ok: true, text: "Draft saved." });
      await load();
      return r.id;
    } catch (e) {
      setMsg({ ok: false, text: err(e, "The draft was not saved.") });
      return null;
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    const id = await save();
    if (!id) return;
    setBusy("test");
    try {
      const r = await testCampaignFn({ data: { id, key: crypto.randomUUID() } });
      setMsg({ ok: true, text: `Test sent to ${r.sent_to}. It arrives within about 5 minutes.` });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: err(e, "The test was not sent.") });
    } finally {
      setBusy(null);
    }
  };

  const send = async (c: { id: string; subject: string }) => {
    setBusy("send");
    setMsg(null);
    try {
      const r = await sendCampaignFn({ data: { id: c.id, key: sendKey.get() } });
      sendKey.reset();
      setEditing(null);
      setMsg({
        ok: true,
        text: `"${c.subject}" is going out to ${r.recipients} subscriber${r.recipients === 1 ? "" : "s"}.`,
      });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: err(e, "The campaign was not sent.") });
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  };

  const subscribers = listing?.subscribers ?? 0;

  return (
    <div className="grid gap-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-extrabold uppercase">Email &amp; promotions</h1>
          <p className="text-xs text-muted-foreground">
            Sent as <b>Cannaplug Support &lt;admin@cannaplug012.co.za&gt;</b>; replies go to
            admin@cannaplug012.co.za. Campaigns go only to people who chose to receive news and
            offers ({subscribers} subscriber{subscribers === 1 ? "" : "s"}), each with a one-click
            unsubscribe link.
          </p>
        </div>
        {!editing && (
          <Button onClick={() => (setMsg(null), setEditing({ id: null, form: BLANK }))}>
            <Mail size={15} /> New campaign
          </Button>
        )}
      </div>

      {msg && (
        <p
          role={msg.ok ? "status" : "alert"}
          className={
            "rounded-lg border px-3 py-2 text-xs " +
            (msg.ok
              ? "border-primary/30 bg-primary/5"
              : "border-destructive/30 bg-destructive/10 text-destructive")
          }
        >
          {msg.text}
        </p>
      )}

      {editing && (
        <section
          className="grid gap-4 rounded-xl border border-border bg-card p-5"
          aria-labelledby="campaign-editor-title"
        >
          <h2 id="campaign-editor-title" className="font-display text-sm font-bold uppercase">
            {editing.id ? "Edit draft" : "New campaign"}
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="cmp-subject">Subject line</Label>
              <Input
                id="cmp-subject"
                maxLength={120}
                value={editing.form.subject}
                onChange={(e) => set("subject", e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="cmp-preheader">Preview text (optional)</Label>
              <Input
                id="cmp-preheader"
                maxLength={150}
                value={editing.form.preheader}
                onChange={(e) => set("preheader", e.target.value)}
                placeholder="Shown next to the subject in the inbox"
              />
            </div>
            <div className="grid gap-1.5 sm:col-span-2">
              <Label htmlFor="cmp-headline">Headline</Label>
              <Input
                id="cmp-headline"
                maxLength={120}
                value={editing.form.headline}
                onChange={(e) => set("headline", e.target.value)}
              />
            </div>
            <div className="grid gap-1.5 sm:col-span-2">
              <Label htmlFor="cmp-body">Message</Label>
              <Textarea
                id="cmp-body"
                rows={8}
                maxLength={5000}
                value={editing.form.body}
                onChange={(e) => set("body", e.target.value)}
                placeholder="Leave a blank line between paragraphs."
              />
              <p className="text-[0.7rem] text-muted-foreground">
                Keep it about the shop, products and events. No health claims, and nothing about a
                particular customer.
              </p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="cmp-cta-label">Button label (optional)</Label>
              <Input
                id="cmp-cta-label"
                maxLength={40}
                value={editing.form.ctaLabel}
                onChange={(e) => set("ctaLabel", e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="cmp-cta-url">Button link</Label>
              <Input
                id="cmp-cta-url"
                maxLength={500}
                value={editing.form.ctaUrl}
                onChange={(e) => set("ctaUrl", e.target.value)}
                placeholder="https://cannaplug012.co.za/shop"
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={busy !== null} onClick={() => void save()}>
              {busy === "save" ? "Saving…" : "Save draft"}
            </Button>
            <Button variant="outline" disabled={busy !== null} onClick={() => void test()}>
              {busy === "test" ? "Sending test…" : "Send a test to me"}
            </Button>
            <Button
              disabled={busy !== null || subscribers === 0}
              onClick={async () => {
                // Always send what is on screen: save first, then confirm.
                const id = await save();
                if (id) setConfirm({ id, subject: editing.form.subject.trim() });
              }}
            >
              <Send size={15} /> Send to {subscribers} subscriber{subscribers === 1 ? "" : "s"}
            </Button>
            <Button variant="ghost" onClick={() => (setEditing(null), setMsg(null))}>
              Close
            </Button>
          </div>
          {subscribers === 0 && (
            <p className="text-xs text-muted-foreground">
              No one has subscribed yet. Members can opt in from Account Settings, and visitors from
              the website footer.
            </p>
          )}
        </section>
      )}

      <section aria-labelledby="campaigns-title">
        <h2 id="campaigns-title" className="mb-2 font-display text-sm font-bold uppercase">
          Campaigns
        </h2>
        {listing && listing.campaigns.length === 0 ? (
          <p className="text-xs text-muted-foreground">No campaigns yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Subject</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Sent</TableHead>
                <TableHead className="text-right">Recipients</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(listing?.campaigns ?? []).map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-semibold">{c.subject}</TableCell>
                  <TableCell>
                    <Badge variant={c.status === "sent" ? "default" : "secondary"}>
                      {c.status === "sent" ? "Sent" : "Draft"}
                    </Badge>
                  </TableCell>
                  <TableCell>{when(c.sent_at)}</TableCell>
                  <TableCell className="text-right">{c.recipient_count ?? "—"}</TableCell>
                  <TableCell className="text-right">
                    {c.status === "draft" && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => (
                          setMsg(null),
                          setEditing({ id: c.id, form: fromCampaign(c) })
                        )}
                      >
                        Edit
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      <section aria-labelledby="activity-title">
        <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
          <h2 id="activity-title" className="font-display text-sm font-bold uppercase">
            Email activity
          </h2>
          {activity && (
            <p className="text-xs text-muted-foreground">
              Last 7 days: <b>{activity.totals.sent}</b> sent · <b>{activity.totals.waiting}</b>{" "}
              waiting · <b>{activity.totals.failed}</b> failed
            </p>
          )}
        </div>
        {activity?.budget && (
          <div
            className="mb-2 rounded-lg border border-border bg-card px-3 py-2 text-xs"
            data-testid="email-budget"
          >
            <b>
              {activity.budget.used} of {activity.budget.limit}
            </b>{" "}
            emails used in the last 24 hours (Resend daily limit).
            {activity.budget.waiting > 0 && ` ${activity.budget.waiting} waiting.`} Order, payment,
            receipt, welcome and rejected-ID emails go first; campaigns stop at{" "}
            {activity.budget.low_ceiling} and digests at {activity.budget.normal_ceiling} so there
            is always room for them. Anything over the limit waits and goes out later.
          </div>
        )}
        <p className="mb-2 text-[0.7rem] text-muted-foreground">
          Emails go out every 5 minutes. Order, payment, receipt and ID-decision emails are
          automatic; failed ones are retried up to 5 times.
        </p>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Email</TableHead>
              <TableHead>To</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Queued</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(activity?.rows ?? []).map((r) => (
              <TableRow key={r.id}>
                <TableCell>
                  {r.label}
                  {r.category === "marketing" && (
                    <span className="ml-2 text-[0.65rem] uppercase text-muted-foreground">
                      marketing
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">{r.to}</TableCell>
                <TableCell>
                  <Badge
                    variant={
                      r.status === "sent"
                        ? "default"
                        : r.status === "dead" || r.status === "failed"
                          ? "destructive"
                          : "secondary"
                    }
                    title={r.error ?? undefined}
                  >
                    {r.status === "dead" ? "failed" : r.status}
                  </Badge>
                </TableCell>
                <TableCell>{when(r.created_at)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>

      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send this campaign now?</AlertDialogTitle>
            <AlertDialogDescription>
              "{confirm?.subject}" goes to {subscribers} subscriber{subscribers === 1 ? "" : "s"}. A
              sent campaign can't be changed or sent again. Send yourself a test first if you
              haven't.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Not yet</AlertDialogCancel>
            <AlertDialogAction onClick={() => confirm && void send(confirm)}>
              {busy === "send" ? "Sending…" : "Send now"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
