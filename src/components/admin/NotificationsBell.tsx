import { useState } from "react";
import { Bell, BellRing } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { TeamNotifications } from "@/hooks/useTeamNotifications";
import { KIND_LABEL, formatSast } from "@/lib/team-notifications";

type Item = TeamNotifications["feed"][number];

/** The bell in the admin header: a dropdown of recent team updates, and a popup with the full message. */
export function NotificationsBell({
  team,
  onManage,
}: {
  team: TeamNotifications;
  onManage?: (() => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState<Item | null>(null);
  const recent = team.feed.slice(0, 8);
  const label = team.unread > 0 ? `Notifications, ${team.unread} unread` : "Notifications";
  const Icon = team.unread > 0 ? BellRing : Bell;

  const openItem = (n: Item) => {
    setShown(n);
    setOpen(false);
    if (n.unread) void team.markRead([n.id]);
  };

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(v) => {
          setOpen(v);
          if (v) void team.reload();
        }}
      >
        <PopoverTrigger asChild>
          <button
            aria-label={label}
            className="relative grid h-9 w-9 place-items-center rounded-full border border-border"
          >
            <Icon size={16} />
            {team.unread > 0 && (
              <span
                aria-hidden
                className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-destructive px-1 text-[10px] font-bold leading-none text-destructive-foreground"
              >
                {team.unread > 9 ? "9+" : team.unread}
              </span>
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[min(92vw,24rem)] p-0">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 className="font-display text-sm font-bold uppercase">Team updates</h2>
            {team.unread > 0 && (
              <Button
                size="sm"
                variant="link"
                className="h-auto p-0 text-xs"
                onClick={() =>
                  void team.markRead(team.feed.filter((n) => n.unread).map((n) => n.id))
                }
              >
                Mark all as read
              </Button>
            )}
          </div>
          {recent.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-muted-foreground">
              {team.loading ? "Loading…" : "No updates yet."}
            </p>
          ) : (
            <ul className="max-h-[60vh] divide-y divide-border overflow-y-auto">
              {recent.map((n) => (
                <li key={n.id}>
                  <button
                    className="flex w-full gap-3 px-4 py-3 text-left hover:bg-muted/60"
                    onClick={() => openItem(n)}
                  >
                    <span
                      aria-hidden
                      className={
                        "mt-1.5 h-2 w-2 shrink-0 rounded-full " +
                        (n.unread ? "bg-primary" : "bg-transparent")
                      }
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        {KIND_LABEL[n.kind]}
                        {n.unread && <span className="sr-only">(unread)</span>}
                        <time dateTime={n.published_at ?? n.created_at}>
                          {formatSast(n.published_at ?? n.created_at)}
                        </time>
                      </span>
                      <span className={"block text-sm " + (n.unread ? "font-bold" : "font-medium")}>
                        {n.title}
                      </span>
                      <span className="line-clamp-2 text-xs text-muted-foreground">{n.body}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {onManage && (
            <div className="border-t border-border px-4 py-2 text-right">
              <Button
                size="sm"
                variant="link"
                className="h-auto p-0 text-xs"
                onClick={() => {
                  setOpen(false);
                  onManage();
                }}
              >
                Manage notifications
              </Button>
            </div>
          )}
        </PopoverContent>
      </Popover>

      <Dialog open={!!shown} onOpenChange={(v) => !v && setShown(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogDescription className="text-[10px] font-semibold uppercase tracking-wide">
              {shown ? KIND_LABEL[shown.kind] : ""}
              {shown ? ` · ${formatSast(shown.published_at ?? shown.created_at)}` : ""}
            </DialogDescription>
            <DialogTitle>{shown?.title}</DialogTitle>
          </DialogHeader>
          <p className="whitespace-pre-line text-sm">{shown?.body}</p>
        </DialogContent>
      </Dialog>
    </>
  );
}
