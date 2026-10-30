import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Check, Loader2, Plus, Send, Sparkles, X } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { askThePlug, type PlugReply } from "@/lib/chat.functions";
import { clearChatStorage } from "@/lib/chat-storage";
import { isStorefrontPath } from "@/lib/ask-plug-access";
import { useCart, rand } from "@/lib/cart";
import { cn } from "@/lib/utils";
import { PlugMark } from "./PlugMark";
import { OPEN_EVENT, takeOpenOnArrival, usePlugStatus } from "./plug-status";
import { MAX_INPUT, STARTERS, toWire, type PlugMessage, type PlugPick } from "./plug-wire";

type Pick = PlugPick;
type Allowance = NonNullable<Extract<PlugReply, { ok: true }>["allowance"]>;

// History and the session id live per member in sessionStorage (cleared on sign-out by clearChatStorage).
const HISTORY_PREFIX = "cannaplug.chat.plug.v1:";
const SESSION_PREFIX = "cannaplug.chat.session:";

const greeting = (firstName?: string | null): PlugMessage => ({
  role: "assistant",
  content: `Howzit${firstName ? ` ${firstName}` : ""}! I'm The Plug 🔌 Tell me what you're in the mood for and I'll match you with something from today's menu. Or tap one of these to start:`,
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

function PickCard({ pick }: { pick: Pick }) {
  const { add } = useCart();
  const [added, setAdded] = useState(false);
  return (
    <div className="plug-pick">
      <div className="plug-pick-img">
        {pick.imageUrl ? <img src={pick.imageUrl} alt="" loading="lazy" /> : <PlugMark size={30} />}
      </div>
      <div className="plug-pick-body">
        <span className="plug-pick-kicker">
          {[pick.category, pick.subcategory].filter(Boolean).join(" · ")}
          {pick.strain ? ` · ${pick.strain}` : ""}
        </span>
        <strong>{pick.name}</strong>
        <p>{pick.why}</p>
        <div className="plug-pick-row">
          <span className="plug-pick-price">
            {pick.regularPrice ? <s>{rand(pick.regularPrice)}</s> : null}
            {rand(pick.price)}
            {pick.unit ? <small> / {pick.unit}</small> : null}
          </span>
          <button
            type="button"
            className="plug-pick-add"
            onClick={() => {
              add({ productId: pick.id, name: pick.name, price: pick.price, unit: pick.unit });
              setAdded(true);
              window.setTimeout(() => setAdded(false), 1600);
            }}
            aria-label={`Add ${pick.name} to cart`}
          >
            {added ? <Check size={14} /> : <Plus size={14} />} {added ? "Added" : "Add"}
          </button>
        </div>
        <a className="plug-pick-link" href={pick.shopHref}>
          See it in the shop
        </a>
      </div>
    </div>
  );
}

/**
 * Ask The Plug 🔌: the AI budtender. Drawn only on storefront pages, only for signed-in verified members (the server
 * checks verification again on every message). Never in the member portal, admin, till, doctor portal or checkout.
 */
export function AskThePlug() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { user, loading: authLoading } = useAuth();
  const userId = user?.id ?? null;
  const firstName =
    (user?.user_metadata?.["full_name"] as string | undefined)?.trim().split(/\s+/)[0] ?? null;
  const status = usePlugStatus(userId);
  const reduceMotion = useReducedMotion();

  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<PlugMessage[]>([greeting()]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState<false | "chat" | "match">(false);
  const [error, setError] = useState<string | null>(null);
  const [allowance, setAllowance] = useState<Allowance | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const lastUser = useRef<string | null>(null);

  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (status.data?.allowance) setAllowance(status.data.allowance);
  }, [status.data?.allowance]);

  // Load this member's history; on sign-out wipe every chat trace from the tab.
  useEffect(() => {
    if (!mounted || authLoading) return;
    if (userId) setMessages(loadHistory(userId, firstName));
    else {
      if (lastUser.current) clearChatStorage();
      setMessages([greeting()]);
      setAllowance(null);
      setOpen(false);
    }
    setError(null);
    lastUser.current = userId;
    // firstName only affects a fresh greeting; reloading history when it changes is not needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, authLoading, userId]);

  useEffect(() => {
    if (!mounted || !userId) return;
    try {
      window.sessionStorage.setItem(HISTORY_PREFIX + userId, JSON.stringify(messages.slice(-40)));
    } catch {
      /* storage full or unavailable */
    }
  }, [messages, mounted, userId]);

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

  const visible =
    mounted && Boolean(userId) && status.data?.eligible === true && isStorefrontPath(pathname);

  const send = useCallback(
    async (text: string, mode: "chat" | "match" = "chat") => {
      const clean = text.trim().slice(0, MAX_INPUT);
      if (!clean || loading || !userId) return;
      const next: PlugMessage[] = [...messages, { role: "user", content: clean }];
      setMessages(next);
      setInput("");
      setError(null);
      setLoading(mode);
      try {
        let sessionId = window.sessionStorage.getItem(SESSION_PREFIX + userId);
        if (!sessionId) {
          sessionId = crypto.randomUUID();
          window.sessionStorage.setItem(SESSION_PREFIX + userId, sessionId);
        }
        const result = await askThePlug({ data: { sessionId, mode, messages: toWire(next) } });
        if (result.allowance) setAllowance(result.allowance);
        if (!result.ok) {
          setError(result.signInRequired ? "Please sign in again to keep chatting." : result.error);
          return;
        }
        setMessages((cur) => [
          ...cur,
          {
            role: "assistant",
            content: result.reply,
            picks: result.picks,
            quickReplies: result.quickReplies,
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
    [loading, messages, userId],
  );

  // Opened from the intro modal (or anywhere) via an event, or by ?ask=1 in the address.
  useEffect(() => {
    if (!visible) return;
    const onOpen = (e: Event) => {
      setOpen(true);
      const prompt = (e as CustomEvent<{ prompt?: string }>).detail?.prompt;
      if (prompt) void send(prompt);
    };
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, [visible, send]);

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
  const matchesLeft = allowance ? allowance.matchesRemaining > 0 : true;
  const outOfMessages = allowance ? allowance.remaining <= 0 : false;

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
                  <small>Your AI budtender · today's menu</small>
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
                  {m.picks?.length ? (
                    <div className="plug-picks">
                      {m.picks.map((p) => (
                        <PickCard key={p.id} pick={p} />
                      ))}
                    </div>
                  ) : null}
                  {m === last && m.role === "assistant" && !loading && m.quickReplies?.length ? (
                    <div className="plug-quick" role="group" aria-label="Quick replies">
                      {m.quickReplies.map((q) => (
                        <button
                          key={q}
                          type="button"
                          onClick={() => void send(q)}
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
                  {loading === "match" ? "Finding your match…" : "The Plug is typing…"}
                </div>
              )}
              {error && <div className="chat-error">{error}</div>}
            </div>

            {userTurns > 0 && (
              <div className="plug-match-row">
                <button
                  type="button"
                  className="plug-match"
                  disabled={Boolean(loading) || !matchesLeft || outOfMessages}
                  onClick={() =>
                    void send(
                      "Based on everything I've told you, what are your top picks for me?",
                      "match",
                    )
                  }
                >
                  <Sparkles size={14} /> Find my match
                  {allowance ? (
                    <small>
                      {allowance.matchesRemaining}/{allowance.matchLimit} left today
                    </small>
                  ) : null}
                </button>
              </div>
            )}

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
