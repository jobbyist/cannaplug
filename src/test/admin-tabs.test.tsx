// @vitest-environment happy-dom
import { act, cleanup, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

type Listener = (event: string, session: unknown) => void;
const listeners: Listener[] = [];
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      onAuthStateChange: (cb: Listener) => {
        listeners.push(cb);
        return { data: { subscription: { unsubscribe: () => {} } } };
      },
      getSession: async () => ({ data: { session: null } }),
      signOut: async () => {},
    },
  },
}));

import { AuthProvider, useAuth } from "@/hooks/useAuth";
import { sameUser } from "@/lib/auth-user";
import { notifyAdminTabs, sectionFromHash, useAdminTabSync } from "@/lib/admin-sync";

const user = (o: Record<string, unknown> = {}) =>
  ({ id: "u1", email: "staff@x.co", updated_at: "2026-10-27T08:00:00Z", ...o }) as never;
const session = (u: unknown, token: string) => ({ access_token: token, user: u });

afterEach(() => {
  cleanup();
  listeners.length = 0;
});

describe("admin across several browser tabs", () => {
  it("a token refresh (here or in another tab) does not look like a new sign-in", async () => {
    let runs = 0;
    function Page() {
      const { user: u } = useAuth();
      useEffect(() => {
        if (u) runs += 1;
      }, [u]);
      return null;
    }
    render(
      <AuthProvider>
        <Page />
      </AuthProvider>,
    );
    await act(async () => listeners.forEach((l) => l("SIGNED_IN", session(user(), "a"))));
    await act(async () => listeners.forEach((l) => l("TOKEN_REFRESHED", session(user(), "b"))));
    await act(async () => listeners.forEach((l) => l("TOKEN_REFRESHED", session(user(), "c"))));
    expect(runs).toBe(1);
    // A different person, or a changed profile, is a real change.
    await act(async () =>
      listeners.forEach((l) => l("SIGNED_IN", session(user({ id: "u2" }), "d"))),
    );
    expect(runs).toBe(2);
  });

  it("compares users by person and profile", () => {
    expect(sameUser(user(), user())).toBe(true);
    expect(sameUser(user(), user({ updated_at: "2026-10-28T00:00:00Z" }))).toBe(false);
    expect(sameUser(user(), null)).toBe(false);
  });

  it("tells other tabs about a change and they reload once", async () => {
    vi.useFakeTimers();
    const seen = vi.fn();
    function Listener() {
      useAdminTabSync(["stock"], seen, 50);
      return null;
    }
    render(<Listener />);
    notifyAdminTabs("orders"); // not a topic this listener cares about
    notifyAdminTabs("stock");
    notifyAdminTabs("stock");
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(100);
    expect(seen).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("each tab keeps its section in the address", () => {
    expect(sectionFromHash("#pos")).toBe("pos");
    expect(sectionFromHash("#id-checks")).toBe("id-checks");
    expect(sectionFromHash("")).toBe("overview");
    expect(sectionFromHash("#<script>")).toBe("overview");
  });
});
