import { useEffect, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { getMyNewsletterFn, setMyNewsletterFn } from "@/lib/email-campaigns.functions";

/** Account Settings: opt in or out of CannaPlug news and offers. Order and account emails always arrive. */
export function EmailPreferences() {
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    void getMyNewsletterFn()
      .then((r) => setOn(r.subscribed))
      .catch(() => setOn(false));
  }, []);

  const change = async (next: boolean) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await setMyNewsletterFn({ data: { subscribe: next, key: crypto.randomUUID() } });
      setOn(r.subscribed);
      setMsg({
        ok: true,
        text: next
          ? "You're subscribed. You can unsubscribe here or from any email."
          : "You won't receive news and offers. Order and account emails still arrive.",
      });
    } catch {
      setMsg({ ok: false, text: "Your choice wasn't saved. Please try again." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-2" aria-labelledby="email-prefs-title">
      <h3 id="email-prefs-title" className="font-display text-sm font-bold uppercase">
        Email preferences
      </h3>
      <div className="flex items-center justify-between gap-4">
        <Label htmlFor="newsletter-switch" className="text-sm font-normal">
          Email me CannaPlug news, new products and offers
        </Label>
        <Switch
          id="newsletter-switch"
          checked={on === true}
          disabled={on === null || busy}
          onCheckedChange={(v) => void change(v)}
        />
      </div>
      {msg && (
        <p
          role={msg.ok ? "status" : "alert"}
          className={"text-xs " + (msg.ok ? "text-muted-foreground" : "text-destructive")}
        >
          {msg.text}
        </p>
      )}
    </div>
  );
}
