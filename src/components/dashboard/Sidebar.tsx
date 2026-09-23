import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type SidebarItem = { id: string; icon: LucideIcon; label: string };

export function DashboardSidebar({
  items,
  active,
  onSelect,
  header,
  footer,
}: {
  items: SidebarItem[];
  active: string;
  onSelect: (id: string) => void;
  header: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <aside className="fixed inset-x-0 bottom-0 z-40 flex h-16 items-center gap-1 overflow-x-auto border-t border-border bg-card px-2 md:static md:h-auto md:w-64 md:shrink-0 md:flex-col md:items-stretch md:gap-0 md:overflow-visible md:border-r md:border-t-0 md:px-0">
      <div className="hidden border-b border-border px-6 py-5 md:block">{header}</div>
      <nav className="flex flex-1 items-center gap-1 md:flex-col md:items-stretch md:gap-0 md:overflow-y-auto md:px-3 md:py-4">
        {items.map((item) => (
          <button
            key={item.id}
            onClick={() => onSelect(item.id)}
            className={cn(
              "flex shrink-0 flex-col items-center gap-0.5 rounded-lg px-3 py-1.5 text-[0.58rem] font-medium transition md:mb-1 md:w-full md:flex-row md:items-center md:gap-3 md:px-3 md:py-2.5 md:text-sm",
              active === item.id
                ? "bg-primary text-primary-foreground"
                : "text-foreground hover:bg-muted",
            )}
          >
            <item.icon size={17} />
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
      {footer && <div className="hidden border-t border-border p-3 md:block">{footer}</div>}
    </aside>
  );
}
