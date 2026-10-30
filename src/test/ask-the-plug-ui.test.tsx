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
  plugQuizFn: vi.fn(),
  plugReserveFn: vi.fn(),
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
vi.mock("@/lib/plug-match.functions", () => ({
  plugQuizFn: mocks.plugQuizFn,
  plugReserveFn: mocks.plugReserveFn,
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
import { toWire, type PlugMessage } from "@/components/ask-plug/plug-wire";
import { AskThePlugIntro } from "@/components/ask-plug/AskThePlugIntro";
import { AGE_GATE_KEY } from "@/components/age-gate-logic";
import { CartProvider, useCart } from "@/lib/cart";

const ALLOW = {
  limit: 25,
  remaining: 24,
  resetsAt: "2026-10-31T07:00:00.000Z",
};
const status = (over: Record<string, unknown> = {}) => ({
  available: true,
  chat: true,
  allowance: ALLOW,
  intro: null,
  ...over,
});
const CARD = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Purple Fritter",
  category: "Flower",
  subcategory: "Greenhouse",
  strain: "Indica",
  price: 50,
  regularPrice: null,
  unit: "g",
  imageUrl: null,
  why: "Indica, as you asked · Greenhouse grade · inside your up-to-R50 budget",
  overBudget: false,
};
const question = (step: string, say: string, labels: string[], answers = {}) => ({
  ok: true,
  kind: "question",
  answers,
  question: {
    step,
    say,
    chips: labels.map((l) => ({ value: l.toLowerCase(), label: l, count: 3 })),
  },
});
const result = (over: Record<string, unknown> = {}) => ({
  ok: true,
  kind: "result",
  answers: { experience: "sometimes", format: "flower" },
  result: { status: "matched", relaxed: null, note: null, cards: [CARD] },
  checkedAt: new Date().toISOString(),
  orderingPaused: false,
  ...over,
});

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
  it("shows on the storefront for a signed-in member", async () => {
    renderUI();
    expect(await screen.findByRole("button", { name: /open ask the plug/i })).toBeTruthy();
  });
  it("is open to signed-out visitors too", async () => {
    mocks.user.current = null;
    mocks.getAskThePlugStatusFn.mockResolvedValue(status({ allowance: null }));
    renderUI();
    expect(await screen.findByRole("button", { name: /open ask the plug/i })).toBeTruthy();
    await userEvent.setup().click(launcher()!);
    expect(screen.getByText(/Tap Find my match/)).toBeTruthy();
    expect(screen.queryByText(/messages left today/)).toBeNull(); // visitors have no member allowance line
  });
  it.each(["/account", "/member/documents", "/admin", "/checkout", "/doctor"])(
    "never appears on %s",
    async (path) => {
      mocks.path.current = path;
      renderUI();
      await new Promise((r) => setTimeout(r, 20));
      expect(launcher()).toBeNull();
    },
  );
});

describe("the guided quiz", () => {
  it("asks one question at a time with tap answers, then shows an in-stock card with a live stock line", async () => {
    const user = userEvent.setup();
    mocks.plugQuizFn
      .mockResolvedValueOnce(
        question("experience", "How well do you know your cannabis?", ["New to it", "Sometimes"]),
      )
      .mockResolvedValueOnce(
        question("format", "What would you like?", ["Flower", "Pre-roll"], {
          experience: "sometimes",
        }),
      )
      .mockResolvedValueOnce(result());
    renderUI();
    await user.click(await screen.findByRole("button", { name: /open ask the plug/i }));
    await user.click(screen.getAllByRole("button", { name: /find my match/i })[0]!);
    await screen.findByText("How well do you know your cannabis?");
    await user.click(screen.getByRole("button", { name: "Sometimes" }));
    await screen.findByText("What would you like?");
    await user.click(screen.getByRole("button", { name: "Flower" }));
    await screen.findByText("Purple Fritter");
    expect(screen.getByText(/In stock now · checked/)).toBeTruthy();
    expect(screen.getByText(/Greenhouse grade/)).toBeTruthy();
    // what the browser sent: answers only, accumulated per tap (never prices, stock or user ids)
    expect(mocks.plugQuizFn.mock.calls.map((c) => c[0].data)).toEqual([
      { answers: {} },
      { answers: { experience: "sometimes" } },
      { answers: { experience: "sometimes", format: "flower" } },
    ]);
  });
  it("Reserve for collection re-checks live stock on the server, then adds to the real cart", async () => {
    const user = userEvent.setup();
    mocks.plugQuizFn.mockResolvedValueOnce(result());
    mocks.plugReserveFn.mockResolvedValueOnce({
      ok: true,
      line: { productId: CARD.id, name: "Purple Fritter", price: 50, unit: "g" },
    });
    renderUI();
    await user.click(await screen.findByRole("button", { name: /open ask the plug/i }));
    await user.click(screen.getAllByRole("button", { name: /find my match/i })[0]!);
    await user.click(await screen.findByRole("button", { name: /reserve purple fritter/i }));
    await screen.findByText(/is in your cart for collection/);
    expect(mocks.plugReserveFn.mock.calls[0]![0].data).toMatchObject({
      productId: CARD.id,
      shown: [CARD.id],
    });
    expect(JSON.parse(screen.getByTestId("cart").textContent!)).toEqual([
      {
        productId: CARD.id,
        name: "Purple Fritter",
        price: 50,
        unit: "g",
        quantity: 1,
        step: 1, // Greenhouse-style products move one gram at a time; Outdoor flower would carry 5
      },
    ]);
  });
  it("a Reserve that finds the product sold out shows the swap note and the next best card, and adds nothing", async () => {
    const user = userEvent.setup();
    mocks.plugQuizFn.mockResolvedValueOnce(result());
    mocks.plugReserveFn.mockResolvedValueOnce({
      ok: false,
      soldOut: true,
      note: "That one just sold out. Here's the next best match that's in stock right now:",
      replacement: { ...CARD, id: "22222222-2222-4222-8222-222222222222", name: "Velvet Moon" },
      checkedAt: new Date().toISOString(),
    });
    renderUI();
    await user.click(await screen.findByRole("button", { name: /open ask the plug/i }));
    await user.click(screen.getAllByRole("button", { name: /find my match/i })[0]!);
    await user.click(await screen.findByRole("button", { name: /reserve purple fritter/i }));
    await screen.findByText(/just sold out/);
    expect(screen.getByText("Velvet Moon")).toBeTruthy();
    expect(JSON.parse(screen.getByTestId("cart").textContent!)).toEqual([]);
  });
  it("while ordering is paused cards say 'Available in store today' and offer no Reserve", async () => {
    const user = userEvent.setup();
    mocks.plugQuizFn.mockResolvedValueOnce(result({ orderingPaused: true }));
    renderUI();
    await user.click(await screen.findByRole("button", { name: /open ask the plug/i }));
    await user.click(screen.getAllByRole("button", { name: /find my match/i })[0]!);
    await screen.findByText("Purple Fritter");
    expect(screen.getByText(/Available in store today/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /reserve/i })).toBeNull();
  });
  it("a result older than 10 minutes cannot be reserved: it offers a refresh that re-runs the match", async () => {
    const user = userEvent.setup();
    mocks.plugQuizFn.mockResolvedValueOnce(
      result({ checkedAt: new Date(Date.now() - 11 * 60_000).toISOString() }),
    );
    mocks.plugQuizFn.mockResolvedValueOnce(result());
    renderUI();
    await user.click(await screen.findByRole("button", { name: /open ask the plug/i }));
    await user.click(screen.getAllByRole("button", { name: /find my match/i })[0]!);
    await screen.findByText("Purple Fritter");
    expect(
      (screen.getByRole("button", { name: /reserve purple fritter/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await user.click(screen.getByRole("button", { name: /refresh my match/i }));
    await waitFor(() => expect(mocks.plugQuizFn).toHaveBeenCalledTimes(2));
    expect(mocks.plugQuizFn.mock.calls[1]![0].data).toEqual({
      answers: { experience: "sometimes", format: "flower" },
    });
  });
  it("Show me another asks for one more, excluding what was shown", async () => {
    const user = userEvent.setup();
    mocks.plugQuizFn.mockResolvedValueOnce(result());
    mocks.plugQuizFn.mockResolvedValueOnce(
      result({
        result: {
          status: "matched",
          relaxed: null,
          note: null,
          cards: [{ ...CARD, id: "33333333-3333-4333-8333-333333333333", name: "White Widow" }],
        },
      }),
    );
    renderUI();
    await user.click(await screen.findByRole("button", { name: /open ask the plug/i }));
    await user.click(screen.getAllByRole("button", { name: /find my match/i })[0]!);
    await user.click(await screen.findByRole("button", { name: /show me another/i }));
    await screen.findByText("White Widow");
    expect(mocks.plugQuizFn.mock.calls[1]![0].data).toMatchObject({
      another: true,
      exclude: [CARD.id],
    });
  });
});

describe("the chat", () => {
  it("free text sends text only; a start_match reply offers Find my match; quick replies show", async () => {
    const user = userEvent.setup();
    mocks.askThePlug.mockResolvedValue({
      ok: true,
      reply: "Lekker. Let's find you something.",
      quickReplies: ["Something cheaper"],
      startMatch: true,
      allowance: { ...ALLOW, remaining: 23 },
    });
    renderUI();
    await user.click(await screen.findByRole("button", { name: /open ask the plug/i }));
    expect(screen.getByText(/Howzit Thandi/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "What's on special?" }));
    await screen.findByText("Lekker. Let's find you something.");
    const sent = mocks.askThePlug.mock.calls[0]![0].data;
    expect(sent.messages).toEqual([{ role: "user", content: "What's on special?" }]);
    expect(Object.keys(sent).sort()).toEqual(["messages", "sessionId"]); // no user id, prices or products
    expect(screen.getByText(/23 of 25 messages left today/)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Find my match" }).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Something cheaper" })).toBeTruthy();
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
  it("toWire drops the greeting, cards and quiz questions, and clips text", () => {
    const msgs: PlugMessage[] = [
      { role: "assistant", content: "greeting", quickReplies: ["x"] },
      { role: "user", content: "a".repeat(800) },
      { role: "assistant", content: "b" },
      { role: "assistant", content: "match card text", cards: [CARD] },
      { role: "assistant", content: "a question", question: { step: "format", chips: [] } },
    ];
    expect(toWire(msgs)).toEqual([
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
  it("signed-out visitors never get the member announcement", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mocks.user.current = null;
    mocks.getAskThePlugStatusFn.mockResolvedValue(status({ allowance: null, intro: null }));
    renderUI();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3200);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.markAskThePlugSeenFn).not.toHaveBeenCalled();
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
