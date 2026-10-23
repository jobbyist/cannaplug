import { useCallback, useEffect, useState } from "react";
import { Bell, BellOff, Send, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  getPushSettingsFn,
  removePushDeviceFn,
  sendTestPushFn,
  setPushTopicFn,
  subscribePushFn,
  unsubscribePushFn,
} from "@/lib/push.functions";
import { currentSubscription, pushSupported, subscribeThisDevice } from "@/lib/pwa/push-client";

type Settings = Awaited<ReturnType<typeof getPushSettingsFn>>;
const when = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString("en-ZA", { day: "numeric", month: "short", year: "numeric" })
    : "never";

/** /account → Notifications: push on this device, topic switches, a test notification. */
export function NotificationsPanel() {
  const [s, setS] = useState<Settings | null>(null);
  const [thisDevice, setThisDevice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setS(await getPushSettingsFn());
      setThisDevice((await currentSubscription())?.endpoint ?? null);
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Could not load your notification settings.");
    }
  }, []);
  useEffect(() => void load(), [load]);

  const run = async (id: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(id);
    setNote(null);
    try {
      await fn();
      if (done) setNote(done);
      await load();
    } catch (err) {
      setNote(err instanceof Error ? err.message : "That did not work. Please try again.");
    } finally {
      setBusy(null);
    }
  };

  if (!s) return <p className="text-sm text-muted-foreground">Loading notifications…</p>;
  const supported = pushSupported();
  const on = !!thisDevice;

  return (
    <div className="flex max-w-2xl flex-col gap-5">
      <h2 className="font-display text-lg font-bold uppercase">Notifications</h2>
      {note && (
        <p role="status" className="rounded-md bg-muted px-3 py-2 text-xs">
          {note}
        </p>
      )}
      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">Push notifications on this device</p>
            <p className="text-xs text-muted-foreground">
              Short alerts only — never product names, amounts or anything about your health or ID.
            </p>
          </div>
          {!supported ? (
            <p className="text-xs text-muted-foreground">
              This browser does not support push. On iPhone, add CannaPlug to your Home Screen
              first.
            </p>
          ) : !s.vapidPublicKey ? (
            <p className="text-xs text-muted-foreground">Push is being set up — check back soon.</p>
          ) : on ? (
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={() =>
                  void run(
                    "test",
                    () => sendTestPushFn(),
                    "Test sent — it should arrive within a minute.",
                  )
                }
              >
                <Send size={14} className="mr-1.5" /> Send a test
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={() =>
                  void run(
                    "off",
                    async () => {
                      const sub = await currentSubscription();
                      if (sub) {
                        await unsubscribePushFn({ data: { endpoint: sub.endpoint } });
                        await sub.unsubscribe();
                      }
                    },
                    "Push is off on this device.",
                  )
                }
              >
                <BellOff size={14} className="mr-1.5" /> Turn off
              </Button>
            </div>
          ) : (
            <Button
              size="sm"
              disabled={busy !== null}
              onClick={() =>
                void run(
                  "on",
                  async () => {
                    const sub = await subscribeThisDevice(s.vapidPublicKey!);
                    await subscribePushFn({
                      data: {
                        ...sub,
                        userAgent: navigator.userAgent.slice(0, 300),
                        key: crypto.randomUUID(),
                      },
                    });
                  },
                  "Push is on for this device.",
                )
              }
            >
              <Bell size={14} className="mr-1.5" /> {busy === "on" ? "Turning on…" : "Turn on"}
            </Button>
          )}
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <p className="mb-3 text-sm font-semibold">What to send me</p>
        <ul className="flex flex-col gap-3">
          {s.topics.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-3">
              <span>
                <span className="block text-sm">{t.label}</span>
                <span className="block text-xs text-muted-foreground">{t.hint}</span>
              </span>
              <Switch
                aria-label={t.label}
                checked={t.enabled}
                disabled={busy !== null}
                onCheckedChange={(v) =>
                  void run(t.id, () =>
                    setPushTopicFn({ data: { topic: t.id, enabled: v, key: crypto.randomUUID() } }),
                  )
                }
              />
            </li>
          ))}
        </ul>
      </section>

      {s.devices.length > 0 && (
        <section className="rounded-xl border border-border bg-card p-5">
          <p className="mb-3 text-sm font-semibold">Devices with push</p>
          <ul className="flex flex-col gap-2 text-xs">
            {s.devices.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                  <Smartphone size={14} className="text-primary" />
                  {(d.user_agent ?? "Browser").replace(/\s*\(.*$/, "").slice(0, 40) || "Browser"} ·
                  added {when(d.created_at)} · last alert {when(d.last_success_at)}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() =>
                    void run(
                      d.id,
                      () => removePushDeviceFn({ data: { id: d.id } }),
                      "Device removed.",
                    )
                  }
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
