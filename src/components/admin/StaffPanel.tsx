import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, UserMinus, UserPlus } from "lucide-react";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ROLE_LABEL, type StaffRole } from "@/lib/admin-nav";
import { findStaffMemberFn, listStaffFn, setStaffRoleFn } from "@/lib/staff.functions";
import { assignableRoles, canEditRole, displayName, type StaffMember } from "@/lib/staff-roles";

const select =
  "h-9 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const errMsg = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");
type Found = Awaited<ReturnType<typeof findStaffMemberFn>>;

/** Managers and admins give, change and take away staff roles. */
export function StaffPanel({ role, myId }: { role: StaffRole | null; myId: string }) {
  const qc = useQueryClient();
  const staff = useQuery({ queryKey: ["admin", "staff"], queryFn: () => listStaffFn() });
  const [email, setEmail] = useState("");
  const [found, setFound] = useState<Found | "none" | null>(null);
  const [pick, setPick] = useState<"budtender" | "manager">("budtender");
  const [remove, setRemove] = useState<StaffMember | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const keys = useRef(new Map<string, string>());
  const offered = assignableRoles(role);

  const keyFor = (memberId: string, level: string) => {
    const k = `${memberId}:${level}`;
    if (!keys.current.has(k)) keys.current.set(k, crypto.randomUUID());
    return keys.current.get(k)!;
  };

  const change = useMutation({
    mutationFn: (v: { memberId: string; level: "budtender" | "manager" | "none"; label: string }) =>
      setStaffRoleFn({
        data: { memberId: v.memberId, level: v.level, key: keyFor(v.memberId, v.level) },
      }),
    onSuccess: async (r, v) => {
      keys.current.clear();
      setError(null);
      setMessage(
        r.changed
          ? v.level === "none"
            ? `${v.label} no longer has staff access.`
            : `${v.label} is now a ${ROLE_LABEL[v.level]}.`
          : `${v.label} already has that role.`,
      );
      setFound(null);
      setEmail("");
      await qc.invalidateQueries({ queryKey: ["admin", "staff"] });
    },
    onError: (e) => {
      setMessage(null);
      setError(errMsg(e));
    },
  });

  const find = useMutation({
    mutationFn: () => findStaffMemberFn({ data: { email } }),
    onSuccess: (m) => {
      setError(null);
      setMessage(null);
      setFound(m ?? "none");
      setPick("budtender");
    },
    onError: (e) => setError(errMsg(e)),
  });

  const target = found && found !== "none" ? found : null;
  const targetEditable =
    !!target && canEditRole(role, myId, { user_id: target.user_id, role: target.role });

  return (
    <div className="grid gap-5">
      <h1 className="font-display text-xl font-extrabold uppercase">Staff</h1>
      <p className="text-xs text-muted-foreground">
        {role === "admin"
          ? "Add staff, change roles between budtender and manager, or remove staff access. Admin roles are managed by the owner."
          : "Add budtenders, or remove a budtender's staff access. Only an admin can assign or change manager roles."}
      </p>
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
        <h2 className="mb-3 font-display text-sm font-bold uppercase">Add or find a team member</h2>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            find.mutate();
          }}
        >
          <label className="grid min-w-56 flex-1 gap-1 text-xs font-semibold">
            Member's email
            <Input
              type="email"
              value={email}
              placeholder="name@example.com"
              onChange={(e) => {
                setEmail(e.target.value);
                setFound(null);
              }}
            />
          </label>
          <Button
            type="submit"
            variant="outline"
            disabled={find.isPending || email.trim().length < 5}
          >
            <Search size={14} /> Find
          </Button>
        </form>
        {found === "none" && (
          <div role="status" className="mt-3 text-xs">
            <p>No member was found with that email. They need a Cannaplug account first.</p>
            <Button
              size="sm"
              variant="outline"
              className="mt-2"
              onClick={() => {
                const link = `${window.location.origin}/account`;
                void navigator.clipboard
                  ?.writeText(link)
                  .then(() =>
                    setMessage(
                      "Sign-up link copied. Ask them to create an account, then find them here.",
                    ),
                  );
              }}
            >
              Copy sign-up link
            </Button>
          </div>
        )}
        {target && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3 text-xs">
            <div>
              <p className="font-semibold">{displayName(target)}</p>
              <p className="text-muted-foreground">
                {target.email} · {target.role ? ROLE_LABEL[target.role] : "Member (no staff role)"}
              </p>
            </div>
            {targetEditable ? (
              <div className="flex items-center gap-2">
                <label className="sr-only" htmlFor="staff-role-pick">
                  Role
                </label>
                <select
                  id="staff-role-pick"
                  className={select}
                  value={pick}
                  onChange={(e) => setPick(e.target.value as "budtender" | "manager")}
                >
                  {offered.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABEL[r]}
                    </option>
                  ))}
                </select>
                <Button
                  disabled={change.isPending}
                  onClick={() =>
                    change.mutate({
                      memberId: target.user_id,
                      level: pick,
                      label: displayName(target),
                    })
                  }
                >
                  <UserPlus size={14} /> {target.role ? "Change role" : "Make staff"}
                </Button>
              </div>
            ) : (
              <p className="text-muted-foreground">
                {target.user_id === myId
                  ? "You can't change your own role."
                  : target.role === "admin"
                    ? "Admin roles are managed by the owner."
                    : "Only an admin can change a manager's role."}
              </p>
            )}
          </div>
        )}
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <h2 className="mb-3 font-display text-sm font-bold uppercase">Team</h2>
        {staff.isLoading ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : staff.isError ? (
          <p role="alert" className="text-xs text-destructive">
            {errMsg(staff.error)}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {(staff.data ?? []).map((m) => {
              const editable = canEditRole(role, myId, m);
              return (
                <li
                  key={m.user_id}
                  className="flex flex-wrap items-center justify-between gap-3 py-3 text-xs"
                >
                  <div className="min-w-0">
                    <p className="font-semibold">
                      {displayName(m)}
                      {m.user_id === myId && (
                        <span className="font-normal text-muted-foreground"> (you)</span>
                      )}
                    </p>
                    <p className="truncate text-muted-foreground">{m.email}</p>
                    <p className="text-[0.68rem] text-muted-foreground">
                      {m.last_sign_in
                        ? `Last signed in ${new Date(m.last_sign_in).toLocaleString("en-ZA", {
                            timeZone: "Africa/Johannesburg",
                            day: "numeric",
                            month: "short",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}`
                        : "Has not signed in yet"}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {editable ? (
                      <>
                        <label className="sr-only" htmlFor={`role-${m.user_id}`}>
                          Role for {displayName(m)}
                        </label>
                        <select
                          id={`role-${m.user_id}`}
                          className={select}
                          value={m.role}
                          disabled={change.isPending}
                          onChange={(e) =>
                            change.mutate({
                              memberId: m.user_id,
                              level: e.target.value as "budtender" | "manager",
                              label: displayName(m),
                            })
                          }
                        >
                          {offered.map((r) => (
                            <option key={r} value={r}>
                              {ROLE_LABEL[r]}
                            </option>
                          ))}
                        </select>
                        <Button size="sm" variant="outline" onClick={() => setRemove(m)}>
                          <UserMinus size={13} /> Remove access
                        </Button>
                      </>
                    ) : (
                      <span className="rounded-full bg-muted px-3 py-1 font-semibold">
                        {ROLE_LABEL[m.role]}
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <AlertDialog open={!!remove} onOpenChange={(v) => !v && setRemove(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove staff access?</AlertDialogTitle>
            <AlertDialogDescription>
              {remove ? displayName(remove) : ""} will no longer be able to use the admin panel.
              They stay a member and keep their account and orders.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (remove)
                  change.mutate({
                    memberId: remove.user_id,
                    level: "none",
                    label: displayName(remove),
                  });
                setRemove(null);
              }}
            >
              Remove access
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
