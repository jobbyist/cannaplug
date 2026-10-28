import { useRef, useState } from "react";
import { Archive, Pencil, Pin, RotateCcw, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { TeamNotifications } from "@/hooks/useTeamNotifications";
import { saveTeamNoticeFn } from "@/lib/team-notifications.functions";
import type { StaffRole } from "@/lib/admin-nav";
import {
  KIND_LABEL,
  formatSast,
  isoToSastInput,
  sastToIso,
  type NoticeAudience,
  type NoticeKind,
  type NoticeStatus,
  type TeamNotice,
} from "@/lib/team-notifications";

const select =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const errMsg = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");

type Draft = {
  id: string | null;
  title: string;
  body: string;
  kind: NoticeKind;
  audience: NoticeAudience;
  pinned: boolean;
  schedule: boolean;
  changeAt: string;
  changeTitle: string;
  changeBody: string;
};
const blank: Draft = {
  id: null,
  title: "",
  body: "",
  kind: "update",
  audience: "budtender",
  pinned: false,
  schedule: false,
  changeAt: "",
  changeTitle: "",
  changeBody: "",
};
const fromNotice = (n: TeamNotice): Draft => ({
  id: n.id,
  title: n.title,
  body: n.body,
  kind: n.kind,
  audience: n.min_role,
  pinned: n.pinned,
  schedule: !!n.change_at,
  changeAt: n.change_at ? isoToSastInput(n.change_at) : "",
  changeTitle: n.change_title ?? "",
  changeBody: n.change_body ?? "",
});

const AUDIENCE_LABEL: Record<NoticeAudience, string> = {
  budtender: "All staff",
  manager: "Managers and admins",
  admin: "Admins only",
};

/** Managers and admins draft, publish, edit and archive the notices staff see under the bell. */
export function NotificationsPanel({
  team,
  role,
}: {
  team: TeamNotifications;
  role: StaffRole | null;
}) {
  const [draft, setDraft] = useState<Draft>(blank);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const key = useRef<string | null>(null);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    key.current = null; // changed details are a new submission
    setDraft((d) => ({ ...d, [k]: v }));
  };

  const submit = async (status: NoticeStatus, source: Draft = draft) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    key.current ??= crypto.randomUUID();
    try {
      await saveTeamNoticeFn({
        data: {
          id: source.id,
          key: key.current,
          notice: {
            title: source.title,
            body: source.body,
            kind: source.kind,
            audience: source.audience,
            status,
            pinned: source.pinned,
            changeAt: source.schedule && source.changeAt ? sastToIso(source.changeAt) : null,
            changeTitle: source.schedule ? source.changeTitle : null,
            changeBody: source.schedule ? source.changeBody : null,
          },
        },
      });
      key.current = null;
      setMessage(
        status === "published"
          ? "Published. Staff see it under the bell straight away."
          : status === "draft"
            ? "Draft saved."
            : "Archived.",
      );
      if (source === draft) setDraft(blank);
      await team.reload();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const quick = (n: TeamNotice, status: NoticeStatus) => {
    key.current = null;
    return submit(status, fromNotice(n));
  };

  const audiences: NoticeAudience[] =
    role === "admin" ? ["budtender", "manager", "admin"] : ["budtender", "manager"];
  const valid = draft.title.trim().length >= 3 && draft.body.trim().length >= 1;
  const scheduleOk =
    !draft.schedule ||
    (!!draft.changeAt &&
      draft.changeTitle.trim().length >= 3 &&
      draft.changeBody.trim().length >= 1);

  return (
    <div className="grid gap-5">
      <h1 className="font-display text-xl font-extrabold uppercase">Notifications</h1>
      {error && (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="rounded-md bg-primary/10 px-3 py-2 text-xs">
          {message}
        </p>
      )}

      <section className="rounded-xl border border-border bg-card p-5">
        <h2 className="mb-3 font-display text-sm font-bold uppercase">
          {draft.id ? "Edit notification" : "New notification"}
        </h2>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit("published");
          }}
        >
          <label className="grid gap-1 text-xs font-semibold">
            Title
            <Input
              value={draft.title}
              maxLength={120}
              onChange={(e) => set("title", e.target.value)}
            />
          </label>
          <label className="grid gap-1 text-xs font-semibold">
            Message
            <Textarea
              rows={4}
              value={draft.body}
              maxLength={1000}
              onChange={(e) => set("body", e.target.value)}
            />
            <small className="font-normal text-muted-foreground">{draft.body.length}/1000</small>
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1 text-xs font-semibold">
              Type
              <select
                className={select}
                value={draft.kind}
                onChange={(e) => set("kind", e.target.value as NoticeKind)}
              >
                {(Object.keys(KIND_LABEL) as NoticeKind[]).map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABEL[k]}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-xs font-semibold">
              Who sees it
              <select
                className={select}
                value={draft.audience}
                onChange={(e) => set("audience", e.target.value as NoticeAudience)}
              >
                {audiences.map((a) => (
                  <option key={a} value={a}>
                    {AUDIENCE_LABEL[a]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={draft.pinned}
              onChange={(e) => set("pinned", e.target.checked)}
            />
            Pin to the top
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={draft.schedule}
              onChange={(e) => set("schedule", e.target.checked)}
            />
            Replace the text automatically at a set time
          </label>
          {draft.schedule && (
            <div className="grid gap-3 rounded-lg border border-border p-3">
              <label className="grid gap-1 text-xs font-semibold">
                Replace at (South African time)
                <Input
                  type="datetime-local"
                  value={draft.changeAt}
                  onChange={(e) => set("changeAt", e.target.value)}
                />
              </label>
              <label className="grid gap-1 text-xs font-semibold">
                New title
                <Input
                  value={draft.changeTitle}
                  maxLength={120}
                  onChange={(e) => set("changeTitle", e.target.value)}
                />
              </label>
              <label className="grid gap-1 text-xs font-semibold">
                New message
                <Textarea
                  rows={3}
                  value={draft.changeBody}
                  maxLength={1000}
                  onChange={(e) => set("changeBody", e.target.value)}
                />
              </label>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy || !valid || !scheduleOk}>
              <Send size={14} /> {draft.id ? "Save and publish" : "Publish"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy || !valid || !scheduleOk}
              onClick={() => void submit("draft")}
            >
              Save as draft
            </Button>
            {draft.id && (
              <Button type="button" variant="outline" onClick={() => setDraft(blank)}>
                Cancel edit
              </Button>
            )}
          </div>
        </form>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <h2 className="mb-3 font-display text-sm font-bold uppercase">All notifications</h2>
        {team.loading ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : team.all.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nothing yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {team.all.map((n) => (
              <li key={n.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                <div className="min-w-0 flex-1 text-xs">
                  <p className="flex flex-wrap items-center gap-2 font-semibold">
                    {n.pinned && <Pin size={12} aria-label="Pinned" />}
                    <span>{n.title}</span>
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] uppercase">
                      {n.status}
                    </span>
                    {n.source_key && (
                      <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] uppercase">
                        Automatic
                      </span>
                    )}
                    <span className="text-[10px] text-muted-foreground">
                      {KIND_LABEL[n.kind]} · {AUDIENCE_LABEL[n.min_role]}
                    </span>
                  </p>
                  <p className="mt-1 text-muted-foreground">{n.body}</p>
                  {n.change_at && n.change_title && (
                    <p className="mt-1 text-muted-foreground">
                      {Date.parse(n.change_at) > team.now ? "Will change" : "Changed"} on{" "}
                      {formatSast(n.change_at)} to “{n.change_title}”.
                    </p>
                  )}
                </div>
                {!n.source_key && (
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        key.current = null;
                        setDraft(fromNotice(n));
                        window.scrollTo?.({ top: 0, behavior: "smooth" });
                      }}
                    >
                      <Pencil size={13} /> Edit
                    </Button>
                    {n.status === "published" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void quick(n, "archived")}
                      >
                        <Archive size={13} /> Archive
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void quick(n, "published")}
                      >
                        {n.status === "archived" ? <RotateCcw size={13} /> : <Send size={13} />}{" "}
                        {n.status === "archived" ? "Restore" : "Publish"}
                      </Button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
