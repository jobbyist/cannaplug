import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Header } from "@/components/CannaPlugHome";
import { Button } from "@/components/ui/button";
import { unsubscribeNewsletterFn } from "@/lib/forms.functions";

export const Route = createFileRoute("/unsubscribe")({
  validateSearch: (s: Record<string, unknown>) => ({
    token: typeof s["token"] === "string" ? s["token"] : "",
  }),
  head: () => ({
    meta: [{ title: "Unsubscribe | CannaPlug" }, { name: "robots", content: "noindex" }],
  }),
  component: Unsubscribe,
});

function Unsubscribe() {
  const { token } = Route.useSearch();
  const [state, setState] = useState<"working" | "done" | "error">("working");
  useEffect(() => {
    if (!token) return setState("error");
    unsubscribeNewsletterFn({ data: { token } })
      .then(() => setState("done"))
      .catch(() => setState("error"));
  }, [token]);
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
            ? "You will not receive any more newsletters from us."
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
