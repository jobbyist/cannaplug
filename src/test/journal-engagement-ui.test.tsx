// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  user: null as { id: string } | null,
  getMyArticleLikeFn: vi.fn(),
  setArticleLikeFn: vi.fn(),
  addArticleCommentFn: vi.fn(),
}));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: h.user }) }));
vi.mock("@/lib/journal.functions", () => ({
  getMyArticleLikeFn: h.getMyArticleLikeFn,
  setArticleLikeFn: h.setArticleLikeFn,
  addArticleCommentFn: h.addArticleCommentFn,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

import { CommentSection } from "@/components/journal/CommentSection";
import { LikeButton } from "@/components/journal/LikeButton";
import { ShareButtons, shareLinks } from "@/components/journal/ShareButtons";

beforeEach(() => {
  h.user = null;
  h.getMyArticleLikeFn.mockResolvedValue(false);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("like button", () => {
  it("asks a visitor to sign in and saves nothing", async () => {
    render(<LikeButton articleId="a1" initialCount={3} />);
    await userEvent.click(screen.getByRole("button", { name: "Like this story" }));
    expect(screen.getByRole("status").textContent).toMatch(/Sign in to like/);
    expect(h.setArticleLikeFn).not.toHaveBeenCalled();
  });

  it("shows a member's saved like on load, and likes with an optimistic count", async () => {
    h.user = { id: "u1" };
    h.getMyArticleLikeFn.mockResolvedValue(true);
    render(<LikeButton articleId="a1" initialCount={3} />);
    expect(await screen.findByRole("button", { name: "Unlike this story" })).toBeTruthy();
    h.setArticleLikeFn.mockResolvedValue({ liked: false, like_count: 2 });
    await userEvent.click(screen.getByRole("button", { name: "Unlike this story" }));
    await waitFor(() => expect(screen.getByLabelText("2 likes")).toBeTruthy());
    expect(h.setArticleLikeFn).toHaveBeenCalledWith({ data: { articleId: "a1", liked: false } });
  });

  it("puts the count back and says so when saving fails", async () => {
    h.user = { id: "u1" };
    h.setArticleLikeFn.mockRejectedValue(new Error("Try again"));
    render(<LikeButton articleId="a1" initialCount={3} />);
    await userEvent.click(screen.getByRole("button", { name: "Like this story" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Try again");
    expect(screen.getByLabelText("3 likes")).toBeTruthy();
  });
});

describe("comment section", () => {
  const wrap = (ui: React.ReactNode) => (
    <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>
  );
  const comments = [
    { id: "c1", name: "Thandi M.", body: "<b>Great</b> read", at: "2026-10-26T08:00:00Z" },
  ];

  it("shows comments as plain text and gives visitors no form", () => {
    render(wrap(<CommentSection articleId="a1" slug="s" comments={comments} />));
    expect(screen.getByText("<b>Great</b> read")).toBeTruthy();
    expect(screen.queryByLabelText("Add a comment")).toBeNull();
    expect(screen.getByText(/Comments are for signed-in members only/)).toBeTruthy();
    expect(document.querySelector(".journal-comment-list b")?.textContent).toBe("Thandi M.");
  });

  it("lets a signed-in member post, once per key, and clears the form", async () => {
    h.user = { id: "u1" };
    h.addArticleCommentFn.mockResolvedValue({});
    render(wrap(<CommentSection articleId="a1" slug="s" comments={[]} />));
    expect(screen.getByText(/No comments yet/)).toBeTruthy();
    await userEvent.type(screen.getByLabelText("Add a comment"), "  Lovely piece  ");
    await userEvent.click(screen.getByRole("button", { name: "Post comment" }));
    await waitFor(() => expect(h.addArticleCommentFn).toHaveBeenCalledTimes(1));
    const arg = h.addArticleCommentFn.mock.calls[0]![0].data;
    expect(arg).toMatchObject({ articleId: "a1", body: "Lovely piece" });
    expect(typeof arg.key).toBe("string");
    expect((await screen.findByRole("status")).textContent).toMatch(/comment is up/);
    expect((screen.getByLabelText("Add a comment") as HTMLTextAreaElement).value).toBe("");
  });

  it("shows the server's reason when a comment is refused", async () => {
    h.user = { id: "u1" };
    h.addArticleCommentFn.mockRejectedValue(new Error("Please wait a few minutes"));
    render(wrap(<CommentSection articleId="a1" slug="s" comments={[]} />));
    await userEvent.type(screen.getByLabelText("Add a comment"), "Hello there");
    await userEvent.click(screen.getByRole("button", { name: "Post comment" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Please wait a few minutes");
  });
});

describe("share buttons", () => {
  it("builds encoded links for each network", () => {
    const links = Object.fromEntries(
      shareLinks("https://x.test/a?b=1", "A & B").map((l) => [l.id, l.href]),
    );
    expect(links["whatsapp"]).toBe(
      "https://wa.me/?text=A%20%26%20B%20https%3A%2F%2Fx.test%2Fa%3Fb%3D1",
    );
    expect(links["x"]).toContain("url=https%3A%2F%2Fx.test%2Fa%3Fb%3D1");
    expect(links["facebook"]).toContain("u=https%3A%2F%2Fx.test%2Fa%3Fb%3D1");
    expect(links["email"]).toMatch(/^mailto:\?subject=A%20%26%20B/);
  });

  it("copies the link and confirms", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<ShareButtons url="https://x.test/a" title="T" text="E" />);
    await userEvent.click(screen.getByRole("button", { name: /Copy link/ }));
    expect(writeText).toHaveBeenCalledWith("https://x.test/a");
    expect(await screen.findByText("Link copied")).toBeTruthy();
  });
});
