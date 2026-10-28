import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { SearchFocus } from "@/components/admin/SearchFocus";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { listCustomersFn } from "@/lib/admin.functions";
import { UsernameEditDialog, type UsernameTarget } from "@/components/admin/UsernameEditDialog";
import { rand } from "@/lib/cart";

export const CUSTOMERS_PAGE_SIZE = 25;

/** Members, newest first, with search and paging done in the database (no list is ever loaded whole). */
export function CustomersPanel({
  focusLabel,
  onClearFocus,
  canEditUsername = false,
}: {
  /** Managers and admins can change a member's username. */
  canEditUsername?: boolean;
  /** Set when the admin search box sent the person here: the list starts filtered to that result. */
  focusLabel?: string | null;
  onClearFocus?: () => void;
}) {
  const [text, setText] = useState(focusLabel ?? "");
  const [search, setSearch] = useState(focusLabel ?? "");
  const [page, setPage] = useState(0);
  const [editing, setEditing] = useState<UsernameTarget | null>(null);

  useEffect(() => {
    setText(focusLabel ?? "");
    setSearch(focusLabel ?? "");
    setPage(0);
  }, [focusLabel]);
  // Search as you type, a moment after the last key.
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch((cur) => (cur === text.trim() ? cur : text.trim()));
      setPage(0);
    }, 300);
    return () => clearTimeout(t);
  }, [text]);

  const q = useQuery({
    queryKey: ["admin", "customers", search, page],
    queryFn: () =>
      listCustomersFn({
        data: {
          search: search || null,
          limit: CUSTOMERS_PAGE_SIZE,
          offset: page * CUSTOMERS_PAGE_SIZE,
        },
      }),
    placeholderData: (prev) => prev,
  });
  const total = q.data?.total ?? 0;
  const from = total === 0 ? 0 : page * CUSTOMERS_PAGE_SIZE + 1;
  const to = Math.min(total, (page + 1) * CUSTOMERS_PAGE_SIZE);

  return (
    <div>
      <h1 className="mb-4 font-display text-xl font-extrabold uppercase">Customers</h1>
      {focusLabel && onClearFocus && <SearchFocus label={focusLabel} onClear={onClearFocus} />}
      <div className="relative mb-4 max-w-md">
        <Search
          size={14}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          aria-label="Search customers"
          className="pl-9"
          placeholder="Search by name, username, phone or email"
          value={text}
          maxLength={100}
          onChange={(e) => setText(e.target.value)}
        />
      </div>
      {q.isError && (
        <p role="alert" className="mb-3 text-xs text-destructive">
          {q.error instanceof Error ? q.error.message : "Could not load customers."}
        </p>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Username</TableHead>
            <TableHead>Email</TableHead>
            <TableHead>Phone</TableHead>
            <TableHead>Member since</TableHead>
            <TableHead>Orders</TableHead>
            <TableHead>Spend</TableHead>
            {canEditUsername && <TableHead className="text-right">Username</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {(q.data?.rows ?? []).map((c) => (
            <TableRow key={c.id}>
              <TableCell>{c.full_name ?? "Unnamed"}</TableCell>
              <TableCell>{c.username ?? "—"}</TableCell>
              <TableCell>{c.email ?? "—"}</TableCell>
              <TableCell>{c.phone ?? "—"}</TableCell>
              <TableCell>
                {new Date(c.member_since).toLocaleDateString("en-ZA", {
                  timeZone: "Africa/Johannesburg",
                })}
              </TableCell>
              <TableCell>{c.order_count}</TableCell>
              <TableCell>{rand(c.spend_rand)}</TableCell>
              {canEditUsername && (
                <TableCell className="text-right">
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={`Change username for ${c.full_name ?? "this member"}`}
                    onClick={() =>
                      setEditing({ id: c.id, name: c.full_name ?? "Unnamed", username: c.username })
                    }
                  >
                    Change
                  </Button>
                </TableCell>
              )}
            </TableRow>
          ))}
          {q.data && q.data.rows.length === 0 && (
            <TableRow>
              <TableCell
                colSpan={canEditUsername ? 8 : 7}
                className="text-center text-xs text-muted-foreground"
              >
                {search ? "No customers match that search." : "No customers yet."}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
        <span aria-live="polite">
          {q.isLoading
            ? "Loading…"
            : total === 0
              ? "0 customers"
              : `Showing ${from}–${to} of ${total.toLocaleString("en-ZA")}`}
        </span>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={page === 0 || q.isFetching}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            <ChevronLeft size={14} /> Previous
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={to >= total || q.isFetching}
            onClick={() => setPage((p) => p + 1)}
          >
            Next <ChevronRight size={14} />
          </Button>
        </div>
      </div>
      <UsernameEditDialog
        member={editing}
        onClose={() => setEditing(null)}
        onSaved={() => void q.refetch()}
      />
    </div>
  );
}
