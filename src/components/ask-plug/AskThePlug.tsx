import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Loader2, RefreshCw, Send, ShoppingBag, Sparkles, X } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { askThePlug, type PlugReply } from "@/lib/chat.functions";
import { plugQuizFn, plugReserveFn } from "@/lib/plug-match.functions";
import { clearChatStorage } from "@/lib/chat-storage";
import { isStorefrontPath } from "@/lib/ask-plug-access";
import { useCart, rand } from "@/lib/cart";
import { cn } from "@/lib/utils";
import { PlugMark } from "./PlugMark";
import { OPEN_EVENT, takeOpenOnArrival, usePlugStatus } from "./plug-status";
import {
  FIND_MATCH,
  MAX_INPUT,
  RESULT_TTL_MS,
  STARTERS,
  START_OVER,
  messageFromQuiz,
  toWire,
  type PlugCardData,
  type PlugMessage,
} from "./plug-wire";

type Allowance = NonNullable<Extract<PlugReply, { ok: true }>["allowance"]>;

// History and the session id live per member in sessionStorage (cleared on sign-out by clearChatStorage).
const HISTORY_PREFIX = "cannaplug.chat.plug.v1:";
const SESSION_PREFIX = "cannaplug.chat.session:";

const greeting = (firstName?: string | null): PlugMessage => ({
  role: "assistant",
  content: `Howzit${firstName ? ` ${firstName}` : ""}! I'm The Plug 🔌 Five quick taps and I'll match you with something that's on the shelf right now. Tap Find my match, or ask me anything:`,
  quickReplies: STARTERS,
});

const resetTime = (iso: string) =>
  new Intl.DateTimeFormat("en-ZA", {
    timeZone: "Africa/Johannesburg",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));

function loadHistory(userId: string, firstName?: string | null): PlugMessage[] {
  try {
    const raw = window.sessionStorage.getItem(HISTORY_PREFIX + userId);
    if (raw) {
      const parsed = JSON.parse(raw) as PlugMessage[];
      if (Array.isArray(parsed) && parsed.length) return parsed;
    }
  } catch {
    /* ignore malformed history */
  }
  return [greeting(firstName)];
}

function MatchCard({
  card,
  checkedAt,
  paused,
  expired,
  busy,
  onReserve,
}: {
  card: PlugCardData;
  checkedAt: string | undefined;
  paused: boolean | undefined;
  expired: boolean;
  busy: boolean;
  onReserve: () => void;
}) {
  return (
    <div className="plug-pick">
      <div className="plug-pick-img">
        {card.imageUrl ? <img src={card.imageUrl} alt="" loading="lazy" /> : <PlugMark size={30} />}
      </div>
      <div className="plug-pick-body">
        <span className="plug-pick-kicker">
          {[card.category, card.subcategory].filter(Boolean).join(" · ")}
          {card.strain ? ` · ${card.strain}` : ""}
        </span>
        <strong>{card.name}</strong>
        <p>{card.why}</p>
        <span className="plug-stock-line">
          {paused ? "Available in store today" : "In stock now"}
          {checkedAt ? ` · checked ${resetTime(checkedAt)}` : ""}
        </span>
        <div className="plug-pick-row">
          <span className="plug-pick-price">
            {card.regularPrice ? <s>{rand(card.regularPrice)}</s> : null}
            {rand(card.price)}
            {card.unit ? <small> / {card.unit}</small> : null}
          </span>
          {!paused && (
            <button
              type="button"
              className="plug-pick-add"
              disabled={busy || expired}
              onClick={onReserve}
              aria-label={`Reserve ${card.name} for collection`}
            >
              <ShoppingBag size={14} /> Reserve for collection
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Ask The Plug 🔌: the AI budtender. Open to everyone on storefront pages (visitors get a smaller chat allowance, enforced
 * on the server). Never in the member portal, admin, till, doctor portal or checkout.
 */
export function AskThePlug() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { user, loading: authLoading } = useAuth();
  const { add } = useCart();
  const userId = user?.id ?? null;
  // Signed-out visitors keep their chat under one shared key; signing out wipes it (clearChatStorage).
  const storeKey = userId ?? "guest";
  const firstName =
    (user?.user_metadata?.["full_name"] as string | undefined)?.trim().split(/\s+/)[0] ?? null;
  const status = usePlugStatus(userId);
  const reduceMotion = useReducedMotion();

  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<PlugMessage[]>([greeting()]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState<false | "chat" | "match">(false);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [allowance, setAllowance] = useState<Allowance | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const lastUser = useRef<string | null>(null);

  useEffect(() => setMounted(true), []);
  // Shown matches expire after 10 minutes: tick so the cards notice without a click.
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => {
    if (status.data?.allowance) setAllowance(status.data.allowance);
  }, [status.data?.allowance]);

  // Load this caller's history; on sign-out wipe every chat trace from the tab.
  useEffect(() => {
    if (!mounted || authLoading) return;
    if (!userId && lastUser.current) {
      clearChatStorage();
      setAllowance(null);
      setOpen(false);
    }
    setMessages(loadHistory(storeKey, firstName));
    setError(null);
    lastUser.current = userId;
    // firstName only affects a fresh greeting; reloading history when it changes is not needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, authLoading, userId]);

  useEffect(() => {
    if (!mounted) return;
    try {
      window.sessionStorage.setItem(HISTORY_PREFIX + storeKey, JSON.stringify(messages.slice(-40)));
    } catch {
      /* storage full or unavailable */
    }
  }, [messages, mounted, storeKey]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.scrollTo({
      top: listRef.current.scrollHeight,
      behavior: reduceMotion ? "auto" : "smooth",
    });
  }, [messages, open, loading, reduceMotion]);

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => inputRef.current?.focus(), 120);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const visible = mounted && status.data?.available === true && isStorefrontPath(pathname);

  const send = useCallback(
    async (text: string) => {
      const clean = text.trim().slice(0, MAX_INPUT);
      if (!clean || loading) return;
      const next: PlugMessage[] = [...messages, { role: "user", content: clean }];
      setMessages(next);
      setInput("");
      setError(null);
      setLoading("chat");
      try {
        let sessionId = window.sessionStorage.getItem(SESSION_PREFIX + storeKey);
        if (!sessionId) {
          sessionId = crypto.randomUUID();
          window.sessionStorage.setItem(SESSION_PREFIX + storeKey, sessionId);
        }
        const result = await askThePlug({ data: { sessionId, messages: toWire(next) } });
        if (result.allowance) setAllowance(result.allowance);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setMessages((cur) => [
          ...cur,
          {
            role: "assistant",
            content: result.reply,
            quickReplies: result.startMatch
              ? [FIND_MATCH, ...result.quickReplies.filter((q) => q !== FIND_MATCH)].slice(0, 4)
              : result.quickReplies,
          },
        ]);
      } catch (err) {
        setError(
          err instanceof Error && /unauthori[sz]ed/i.test(err.message)
            ? "Please sign in again to keep chatting."
            : "The Plug couldn't answer just now. Please try again in a moment.",
        );
      } finally {
        setLoading(false);
      }
    },
    [loading, messages, storeKey],
  );

  /** One quiz step. The server owns the flow, the stock and the prices; this only sends the taps. */
  const runQuiz = useCallback(
    async (
      answers: Record<string, string>,
      label: string | null,
      extra?: { exclude?: string[]; another?: boolean },
    ) => {
      if (loading) return;
      setError(null);
      if (label) setMessages((cur) => [...cur, { role: "user", content: label }]);
      setLoading("match");
      try {
        const r = await plugQuizFn({
          data: {
            answers,
            ...(extra?.exclude ? { exclude: extra.exclude } : {}),
            ...(extra?.another ? { another: true } : {}),
          },
        });
        if (!r.ok) {
          setError(r.error);
          return;
        }
        setMessages((cur) => [...cur, messageFromQuiz(r)]);
      } catch {
        setError("The Plug couldn't check the shelf just now. Please try again in a moment.");
      } finally {
        setLoading(false);
      }
    },
    [loading],
  );

  const shownIds = useCallback(
    () => [...new Set(messages.flatMap((m) => (m.cards ?? []).map((c) => c.id)))].slice(-50),
    [messages],
  );

  const reserve = useCallback(
    async (m: PlugMessage, card: PlugCardData) => {
      if (loading) return;
      setError(null);
      setLoading("match");
      try {
        const r = await plugReserveFn({
          data: { productId: card.id, answers: m.answers ?? {}, shown: shownIds() },
        });
        if (r.ok) {
          add({
            productId: r.line.productId,
            name: r.line.name,
            price: r.line.price,
            unit: r.line.unit,
          });
          setMessages((cur) => [
            ...cur,
            {
              role: "assistant",
              content: `${r.line.name} is in your cart for collection. Your stock is held for 2 hours once you check out.`,
              checkout: true,
              quickReplies: [START_OVER],
            },
          ]);
        } else if ("soldOut" in r) {
          setMessages((cur) => [
            ...cur,
            {
              role: "assistant",
              content: r.note,
              ...(r.replacement
                ? { cards: [r.replacement], checkedAt: r.checkedAt, answers: m.answers ?? {} }
                : {}),
              quickReplies: [START_OVER],
            },
          ]);
        } else if ("paused" in r) {
          setMessages((cur) => [
            ...cur,
            { role: "assistant", content: r.error, quickReplies: [START_OVER] },
          ]);
        } else setError(r.error);
      } catch {
        setError("The Plug couldn't reserve that just now. Please try again in a moment.");
      } finally {
        setLoading(false);
      }
    },
    [add, loading, shownIds],
  );

  /** A quick-reply tap: the two quiz actions start the quiz; anything else is a normal chat message. */
  const quick = useCallback(
    (q: string) => {
      if (q === FIND_MATCH || q === START_OVER) void runQuiz({}, q);
      else void send(q);
    },
    [runQuiz, send],
  );

  // Opened from the intro modal (or anywhere) via an event, or by ?ask=1 in the address.
  useEffect(() => {
    if (!visible) return;
    const onOpen = (e: Event) => {
      setOpen(true);
      const prompt = (e as CustomEvent<{ prompt?: string }>).detail?.prompt;
      if (prompt) quick(prompt);
    };
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, [visible, quick]);

  // Opened on arrival: from the intro modal on /account, or a shared link with ?ask=1.
  useEffect(() => {
    if (visible && takeOpenOnArrival()) setOpen(true);
  }, [visible, pathname]);

  if (!visible) return null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void send(input);
  };
  const userTurns = messages.filter((m) => m.role === "user").length;
  const last = messages[messages.length - 1];
  const outOfMessages = allowance ? allowance.remaining <= 0 : false;
  const isExpired = (m: PlugMessage) =>
    Boolean(m.checkedAt && m.cards?.length) &&
    now - new Date(m.checkedAt!).getTime() > RESULT_TTL_MS;

  return (
    <>
      <button
        type="button"
        className={cn("plug-notch", open && "plug-notch-hidden")}
        onClick={() => setOpen(true)}
        aria-label="Open Ask The Plug, your AI budtender"
        aria-expanded={open}
      >
        <PlugMark size={26} />
        <span>Ask The Plug 🔌</span>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            className="chat-panel plug-panel"
            role="dialog"
            aria-modal="false"
            aria-label="Ask The Plug"
            initial={reduceMotion ? false : { opacity: 0, y: 24, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 24, scale: 0.97 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="chat-head plug-head">
              <div className="chat-head-title">
                <PlugMark size={36} />
                <div>
                  <strong>Ask The Plug 🔌</strong>
                  <small>Your AI budtender · live stock</small>
                </div>
              </div>
              <button
                type="button"
                aria-label="Close Ask The Plug"
                onClick={() => setOpen(false)}
                className="chat-close"
              >
                <X size={18} />
              </button>
            </div>

            <div className="chat-body" ref={listRef} aria-live="polite">
              {messages.map((m, i) => (
                <div key={i} className={cn("plug-turn", m.role === "user" && "plug-turn-user")}>
                  <div
                    className={cn(
                      "chat-bubble",
                      m.role === "user" ? "chat-bubble-user" : "chat-bubble-bot",
                    )}
                  >
                    {m.content}
                  </div>
                  {m.cards?.length ? (
                    <div className="plug-picks">
                      {m.cards.map((c) => (
                        <MatchCard
                          key={c.id}
                          card={c}
                          checkedAt={m.checkedAt}
                          paused={m.paused}
                          expired={isExpired(m)}
                          busy={Boolean(loading)}
                          onReserve={() => void reserve(m, c)}
                        />
                      ))}
                      {isExpired(m) && !m.paused ? (
                        <button
                          type="button"
                          className="plug-refresh"
                          disabled={Boolean(loading) || outOfMessages}
                          onClick={() => void runQuiz(m.answers ?? {}, null)}
                        >
                          <RefreshCw size={13} /> Stock may have changed. Refresh my match
                        </button>
                      ) : m === last && !m.paused && !loading ? (
                        <button
                          type="button"
                          className="plug-refresh"
                          onClick={() =>
                            void runQuiz(m.answers ?? {}, "Show me another", {
                              exclude: shownIds(),
                              another: true,
                            })
                          }
                        >
                          Show me another
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                  {m === last && m.role === "assistant" && !loading && m.question ? (
                    <div className="plug-quick" role="group" aria-label="Answer options">
                      {m.question.chips.map((c) => (
                        <button
                          key={c.value}
                          type="button"
                          onClick={() =>
                            void runQuiz(
                              { ...(m.answers ?? {}), [m.question!.step]: c.value },
                              c.label,
                            )
                          }
                        >
                          {c.label}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {m.checkout ? (
                    <Link to="/checkout" onClick={() => setOpen(false)} className="plug-refresh">
                      <ShoppingBag size={13} /> Go to checkout
                    </Link>
                  ) : null}
                  {m === last && m.role === "assistant" && !loading && m.quickReplies?.length ? (
                    <div className="plug-quick" role="group" aria-label="Quick replies">
                      {m.quickReplies.map((q) => (
                        <button
                          key={q}
                          type="button"
                          onClick={() => quick(q)}
                          disabled={outOfMessages}
                        >
                          {q}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
              {loading && (
                <div className="chat-bubble chat-bubble-bot chat-bubble-loading">
                  <Loader2 size={14} className="chat-spinner" />
                  {loading === "match" ? "Checking the shelf…" : "The Plug is typing…"}
                </div>
              )}
              {error && <div className="chat-error">{error}</div>}
            </div>

            <div className="plug-match-row">
              <button
                type="button"
                className="plug-match"
                disabled={Boolean(loading)}
                onClick={() => void runQuiz({}, FIND_MATCH)}
              >
                <Sparkles size={14} /> {userTurns > 0 ? "Start a new match" : FIND_MATCH}
              </button>
            </div>

            <form className="chat-input-row" onSubmit={submit}>
              <input
                ref={inputRef}
                value={input}
                maxLength={MAX_INPUT}
                onChange={(e) => setInput(e.target.value)}
                placeholder={outOfMessages ? "Back tomorrow 🔌" : "Ask The Plug anything…"}
                aria-label="Message The Plug"
                disabled={Boolean(loading) || outOfMessages}
              />
              <button
                type="submit"
                aria-label="Send message"
                disabled={Boolean(loading) || !input.trim() || outOfMessages}
              >
                {loading ? <Loader2 size={16} className="chat-spinner" /> : <Send size={16} />}
              </button>
            </form>
            {allowance && (
              <p className="chat-disclaimer">
                {allowance.remaining} of {allowance.limit} messages left today · resets{" "}
                {resetTime(allowance.resetsAt)}
              </p>
            )}
            <p className="chat-disclaimer">
              AI guidance, not medical advice. For adults 18+.{" "}
              <Link to="/faq" onClick={() => setOpen(false)} className="underline">
                Questions?
              </Link>
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
