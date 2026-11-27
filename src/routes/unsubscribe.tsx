import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Header } from "@/components/CannaPlugHome";
import { Button } from "@/components/ui/button";
import { unsubscribeCartFn } from "@/lib/cart.functions";
import { unsubscribeNewsletterFn } from "@/lib/forms.functions";

export const Route = createFileRoute("/unsubscribe")({
  validateSearch: (s: Record<string, unknown>) => ({
    token: typeof s["token"] === "string" ? s["token"] : "",
    kind: s["kind"] === "cart" ? ("cart" as const) : ("newsletter" as const),
  }),
  head: () => ({
    meta: [{ title: "Unsubscribe | CannaPlug" }, { name: "robots", content: "noindex" }],
  }),
  component: Unsubscribe,
});

function Unsubscribe() {
  const { token, kind } = Route.useSearch();
  const [state, setState] = useState<"working" | "done" | "error">("working");
  useEffect(() => {
    if (!token) return setState("error");
    (kind === "cart" ? unsubscribeCartFn : unsubscribeNewsletterFn)({ data: { token } })
      .then(() => setState("done"))
      .catch(() => setState("error"));
  }, [token, kind]);
  return (
    <div className="site">
      <Header />
      <main className="mx-auto flex max-w-[520px] flex-col items-center gap-4 px-4 py-20 text-center">
        <h1 className="font-display text-xl font-extrabold uppercase">
          {state === "done"
            ? "You're unsubscribed"
            : state === "error"
              ? "That link didn't work"
              : "Unsubscribing…"}
        </h1>
        <p className="text-sm text-muted-foreground">
          {state === "done"
            ? kind === "cart"
              ? "You will not receive any more basket reminders. Order and account emails still reach you."
              : "You will not receive any more newsletters from us."
            : state === "error"
              ? "Reply to any of our emails and we will remove you by hand."
              : "One moment."}
        </p>
        <Link to="/">
          <Button size="sm" variant="outline">
            Back to Cannaplug
          </Button>
        </Link>
      </main>
    </div>
  );
}
