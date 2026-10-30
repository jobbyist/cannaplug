// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Ask The Plug UI with the server boundary mocked: where the launcher appears, who sees it, what the browser sends
 * (text and a session id only), product cards adding to the real cart, and the one-time launch announcement.
 */
const mocks = vi.hoisted(() => ({
  askThePlug: vi.fn(),
  getAskThePlugStatusFn: vi.fn(),
  markAskThePlugSeenFn: vi.fn(),
  navigate: vi.fn(),
  path: { current: "/shop" },
  user: { current: { id: "u1", user_metadata: { full_name: "Thandi Mokoena" } } as unknown },
}));
vi.mock("@/lib/chat.functions", () => ({
  askThePlug: mocks.askThePlug,
  getAskThePlugStatusFn: mocks.getAskThePlugStatusFn,
  markAskThePlugSeenFn: mocks.markAskThePlugSeenFn,
}));
// happy-dom has no Web Animations, so framer-motion's exit animations reject on unmount: render plain elements.
vi.mock("framer-motion", async () => {
  const { createElement } = await import("react");
  const strip = ({
    initial: _i,
    animate: _a,
    exit: _e,
    transition: _t,
    ...rest
  }: Record<string, unknown>) => rest;
  return {
    AnimatePresence: ({ children }: { children: ReactNode }) => children,
    motion: { div: (props: Record<string, unknown>) => createElement("div", strip(props)) },
    useReducedMotion: () => true,
  };
});
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: mocks.user.current, loading: false }),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({ location: { pathname: mocks.path.current, searchStr: "" } }),
  useNavigate: () => mocks.navigate,
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));

import { AskThePlug } from "@/components/ask-plug/AskThePlug";
import { toWire } from "@/components/ask-plug/plug-wire";
import { AskThePlugIntro } from "@/components/ask-plug/AskThePlugIntro";
import { AGE_GATE_KEY } from "@/components/age-gate-logic";
import { CartProvider, useCart } from "@/lib/cart";

const ALLOW = {
  limit: 25,
  remaining: 24,
  matchLimit: 3,
  matchesRemaining: 3,
  resetsAt: "2026-10-31T07:00:00.000Z",
};
const status = (over: Record<string, unknown> = {}) => ({
  available: true,
  eligible: true,
  allowance: ALLOW,
  intro: null,
  ...over,
});
const PICK = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Purple Fritter",
  category: "Flower",
  subcategory: "Greenhouse",
  strain: "Indica",
  price: 50,
  regularPrice: null,
  unit: "g",
  imageUrl: null,
  shopHref: "/shop?q=Purple%20Fritter",
  why: "Greenhouse indica in your budget.",
};

function CartPeek() {
  const { lines } = useCart();
  return <output data-testid="cart">{JSON.stringify(lines)}</output>;
}
function renderUI() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CartProvider>
        <AskThePlug />
        <AskThePlugIntro />
        <CartPeek />
      </CartProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.path.current = "/shop";
  mocks.user.current = { id: "u1", user_metadata: { full_name: "Thandi Mokoena" } };
  mocks.getAskThePlugStatusFn.mockResolvedValue(status());
  mocks.markAskThePlugSeenFn.mockResolvedValue({ ok: true });
  window.localStorage.setItem(AGE_GATE_KEY, String(Date.now()));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
  sessionStorage.clear();
  localStorage.clear();
});

const launcher = () => screen.queryByRole("button", { name: /open ask the plug/i });

describe("launcher visibility", () => {
  it("shows on the storefront for a verified member", async () => {
    renderUI();
    expect(await screen.findByRole("button", { name: /open ask the plug/i })).toBeTruthy();
  });
  it("is hidden for members who are not verified (and the server is never asked to chat)", async () => {
    mocks.getAskThePlugStatusFn.mockResolvedValue(status({ eligible: false, allowance: null }));
    renderUI();
    await waitFor(() => expect(mocks.getAskThePlugStatusFn).toHaveBeenCalled());
    expect(launcher()).toBeNull();
  });
  it("is hidden when signed out, without even asking for a status", async () => {
    mocks.user.current = null;
    renderUI();
    await new Promise((r) => setTimeout(r, 20));
    expect(launcher()).toBeNull();
    expect(mocks.getAskThePlugStatusFn).not.toHaveBeenCalled();
  });
  it.each(["/account", "/member/documents", "/admin", "/checkout", "/doctor"])(
    "never appears on %s, even for a verified member",
    async (path) => {
      mocks.path.current = path;
      renderUI();
      await waitFor(() => expect(mocks.getAskThePlugStatusFn).toHaveBeenCalled());
      expect(launcher()).toBeNull();
    },
  );
});

describe("the conversation", () => {
  it("starter chips send text only; picks render from the server and add to the real cart", async () => {
    const user = userEvent.setup();
    mocks.askThePlug.mockResolvedValue({
      ok: true,
      reply: "Lekker. Try this one:",
      quickReplies: ["Something cheaper"],
      picks: [PICK],
      readyToMatch: true,
      allowance: { ...ALLOW, remaining: 23 },
    });
    renderUI();
    await user.click(await screen.findByRole("button", { name: /open ask the plug/i }));
    expect(screen.getByText(/Howzit Thandi/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Help me pick some flower" }));
    await screen.findByText("Lekker. Try this one:");
    const sent = mocks.askThePlug.mock.calls[0]![0].data;
    expect(sent.mode).toBe("chat");
    expect(sent.messages).toEqual([{ role: "user", content: "Help me pick some flower" }]);
    expect(Object.keys(sent).sort()).toEqual(["messages", "mode", "sessionId"]); // no user id, prices or products
    expect(screen.getByText("Purple Fritter")).toBeTruthy();
    expect(screen.getByText(/23 of 25 messages left today/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /add purple fritter to cart/i }));
    expect(JSON.parse(screen.getByTestId("cart").textContent!)).toEqual([
      { productId: PICK.id, name: "Purple Fritter", price: 50, unit: "g", quantity: 1 },
    ]);
    // the quick reply from the model is offered next
    expect(screen.getByRole("button", { name: "Something cheaper" })).toBeTruthy();
  });
  it("Find my match sends a match request and shows how many are left", async () => {
    const user = userEvent.setup();
    mocks.askThePlug.mockResolvedValue({
      ok: true,
      reply: "Cool",
      quickReplies: [],
      picks: [],
      readyToMatch: false,
    });
    renderUI();
    await user.click(await screen.findByRole("button", { name: /open ask the plug/i }));
    await user.type(screen.getByLabelText("Message The Plug"), "flower under R60{enter}");
    await screen.findByText("Cool");
    const match = screen.getByRole("button", { name: /find my match/i });
    expect(match.textContent).toContain("3/3 left today");
    await user.click(match);
    expect(mocks.askThePlug.mock.calls[1]![0].data.mode).toBe("match");
  });
  it("shows the server's friendly refusal; out of messages disables the input", async () => {
    const user = userEvent.setup();
    mocks.askThePlug.mockResolvedValue({
      ok: false,
      limited: true,
      error: "That's all your Ask The Plug messages for today.",
      allowance: { ...ALLOW, remaining: 0 },
    });
    renderUI();
    await user.click(await screen.findByRole("button", { name: /open ask the plug/i }));
    await user.type(screen.getByLabelText("Message The Plug"), "hi{enter}");
    expect(await screen.findByText(/That's all your Ask The Plug messages/)).toBeTruthy();
    expect((screen.getByLabelText("Message The Plug") as HTMLInputElement).disabled).toBe(true);
  });
  it("toWire drops the greeting and product data and clips text", () => {
    const wire = toWire([
      { role: "assistant", content: "greeting", quickReplies: ["x"] },
      { role: "user", content: "a".repeat(800) },
      { role: "assistant", content: "b", picks: [PICK] },
    ]);
    expect(wire).toEqual([
      { role: "user", content: "a".repeat(500) },
      { role: "assistant", content: "b" },
    ]);
  });
});

describe("launch announcement", () => {
  it("verified members see the full intro once; 'Ask The Plug now' records it and opens the chat", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mocks.getAskThePlugStatusFn.mockResolvedValue(status({ intro: "full" }));
    renderUI();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(await screen.findByRole("dialog", { name: /ask the plug/i })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /ask the plug now/i }));
    expect(mocks.markAskThePlugSeenFn).toHaveBeenCalledWith({
      data: {
        feature: "ask_the_plug_intro",
        action: "opened",
        idempotencyKey: "ask_the_plug_intro:opened:u1",
      },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(await screen.findByLabelText("Message The Plug")).toBeTruthy();
  });
  it("waits for the 18+ question to be answered first", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    localStorage.removeItem(AGE_GATE_KEY);
    mocks.getAskThePlugStatusFn.mockResolvedValue(status({ intro: "full" }));
    renderUI();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    localStorage.setItem(AGE_GATE_KEY, String(Date.now()));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });
  it("on /account the intro sends the member to the shop with the chat set to open", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mocks.path.current = "/account";
    mocks.getAskThePlugStatusFn.mockResolvedValue(status({ intro: "full" }));
    renderUI();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    await user.click(await screen.findByRole("button", { name: /ask the plug now/i }));
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/shop" });
    expect(sessionStorage.getItem("cannaplug.chat.plug.open")).toBe("1");
  });
  it("unverified members get the 'verify to unlock' preview on the storefront only, never over the ID upload", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mocks.getAskThePlugStatusFn.mockResolvedValue(
      status({ eligible: false, allowance: null, intro: "preview" }),
    );
    mocks.path.current = "/account";
    const { unmount } = renderUI();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3200);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    unmount();
    mocks.path.current = "/";
    renderUI();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(await screen.findByText(/Verify your ID to unlock/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /maybe later/i }));
    expect(mocks.markAskThePlugSeenFn).toHaveBeenCalledWith({
      data: {
        feature: "ask_the_plug_preview",
        action: "dismissed",
        idempotencyKey: "ask_the_plug_preview:dismissed:u1",
      },
    });
  });
  it("never stacks on the new-member portal tour on /account", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mocks.path.current = "/account";
    mocks.user.current = { id: "u1", user_metadata: { onboarding_tour: "pending" } };
    mocks.getAskThePlugStatusFn.mockResolvedValue(status({ intro: "full" }));
    renderUI();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3200);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("nothing shows once it has been seen", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderUI();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3200);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
