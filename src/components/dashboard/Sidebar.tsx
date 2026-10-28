import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { opensElsewhere } from "@/components/dashboard/links";

export type SidebarItem = {
  id: string;
  icon: LucideIcon;
  label: string;
  /** A count that needs attention (shown as a badge when above zero). */
  badge?: number | undefined;
};

export function DashboardSidebar({
  items,
  active,
  onSelect,
  header,
  footer,
  hrefFor,
}: {
  items: SidebarItem[];
  active: string;
  onSelect: (id: string) => void;
  /** When given, items are real links: Ctrl/⌘-click, middle-click and right-click → "Open in new tab" work. */
  hrefFor?: (id: string) => string;
  header: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <aside className="fixed inset-x-0 bottom-0 z-40 flex h-16 items-center gap-1 overflow-x-auto border-t border-border bg-card px-2 md:static md:h-auto md:w-64 md:shrink-0 md:flex-col md:items-stretch md:gap-0 md:overflow-visible md:border-r md:border-t-0 md:px-0">
      <div className="hidden border-b border-border px-6 py-5 md:block">{header}</div>
      <nav className="flex flex-1 items-center gap-1 md:flex-col md:items-stretch md:gap-0 md:overflow-y-auto md:px-3 md:py-4">
        {items.map((item) => {
          const cls = cn(
            "flex shrink-0 flex-col items-center gap-0.5 rounded-lg px-3 py-1.5 text-[0.58rem] font-medium transition md:mb-1 md:w-full md:flex-row md:items-center md:gap-3 md:px-3 md:py-2.5 md:text-sm",
            active === item.id
              ? "bg-primary text-primary-foreground"
              : "text-foreground hover:bg-muted",
          );
          const body = (
            <>
              <span className="relative">
                <item.icon size={17} />
                {item.badge ? (
                  <span
                    aria-hidden
                    className="absolute -right-2 -top-2 grid h-4 min-w-4 place-items-center rounded-full bg-destructive px-1 text-[10px] font-bold leading-none text-destructive-foreground md:hidden"
                  >
                    {item.badge > 99 ? "99+" : item.badge}
                  </span>
                ) : null}
              </span>
              <span className="flex-1">{item.label}</span>
              {item.badge ? (
                <>
                  <span
                    aria-hidden
                    className="hidden h-5 min-w-5 place-items-center rounded-full bg-destructive px-1.5 text-[11px] font-bold leading-none text-destructive-foreground md:grid"
                  >
                    {item.badge > 99 ? "99+" : item.badge}
                  </span>
                  <span className="sr-only">{item.badge} need attention</span>
                </>
              ) : null}
            </>
          );
          return hrefFor ? (
            <a
              key={item.id}
              href={hrefFor(item.id)}
              aria-current={active === item.id ? "page" : undefined}
              onClick={(e) => {
                // A plain click switches section in this tab; modified clicks open a new tab as usual.
                if (opensElsewhere(e)) return;
                e.preventDefault();
                onSelect(item.id);
              }}
              className={cls}
            >
              {body}
            </a>
          ) : (
            <button key={item.id} onClick={() => onSelect(item.id)} className={cls}>
              {body}
            </button>
          );
        })}
      </nav>
      {footer && <div className="hidden border-t border-border p-3 md:block">{footer}</div>}
    </aside>
  );
}
