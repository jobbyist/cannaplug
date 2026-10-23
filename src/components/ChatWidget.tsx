import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { AnimatePresence, motion } from "framer-motion";
import { Bot, Loader2, LogIn, MessageCircle, Send, Sparkles, X } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { askCannaPlug, getChatAllowanceFn } from "@/lib/chat.functions";
import { clearChatStorage } from "@/lib/chat-storage";
import { cn } from "@/lib/utils";

type ChatMessage = { role: "user" | "assistant"; content: string };

type Allowance = { limit: number; remaining: number; resetsAt: string };
// History and the chat session are kept per member in sessionStorage and cleared on sign-out.
const STORAGE_PREFIX = "cannaplug.chat.v2:";
const SESSION_PREFIX = "cannaplug.chat.session:";
const historyKey = (userId: string) => STORAGE_PREFIX + userId;
const sessionKey = (userId: string) => SESSION_PREFIX + userId;

const resetTime = (iso: string) =>
  new Intl.DateTimeFormat("en-ZA", {
    timeZone: "Africa/Johannesburg",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
const GREETING: ChatMessage = {
  role: "assistant",
  content:
    "Hey, I'm CannaPlug AI \u{1F33F} Ask me about our products, store policies, delivery or hours — I'm happy to help.",
};

function loadHistory(userId: string): ChatMessage[] {
  try {
    const raw = window.sessionStorage.getItem(historyKey(userId));
    if (raw) return JSON.parse(raw) as ChatMessage[];
  } catch {
    /* ignore malformed history */
  }
  return [GREETING];
}

export function ChatWidget() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { user, loading: authLoading } = useAuth();
  const userId = user?.id ?? null;
  const [allowance, setAllowance] = useState<Allowance | null>(null);
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([GREETING]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => setMounted(true), []);

  // Load this member's history; on sign-out wipe every chat trace from the tab.
  const lastUser = useRef<string | null>(null);
  useEffect(() => {
    if (!mounted || authLoading) return;
    if (userId) setMessages(loadHistory(userId));
    else {
      if (lastUser.current) clearChatStorage();
      setMessages([GREETING]);
      setAllowance(null);
    }
    setError(null);
    lastUser.current = userId;
  }, [mounted, authLoading, userId]);

  useEffect(() => {
    if (!mounted || !userId) return;
    try {
      window.sessionStorage.setItem(historyKey(userId), JSON.stringify(messages));
    } catch {
      /* ignore quota errors */
    }
  }, [messages, mounted, userId]);

  useEffect(() => {
    if (!open || !userId) return;
    let live = true;
    getChatAllowanceFn()
      .then((a) => live && setAllowance(a))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [open, userId]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, open, loading]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  // The standalone /subscribe/* landing pages have their own design and no chat widget.
  if (!mounted || pathname.startsWith("/subscribe")) return null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = input.trim();
    if (!text || loading || !userId) return;

    const nextMessages = [...messages, { role: "user", content: text } satisfies ChatMessage];
    setMessages(nextMessages);
    setInput("");
    setError(null);
    setLoading(true);

    try {
      let sessionId = window.sessionStorage.getItem(sessionKey(userId));
      if (!sessionId) {
        sessionId = crypto.randomUUID();
        window.sessionStorage.setItem(sessionKey(userId), sessionId);
      }
      const history = nextMessages
        .filter((m, i) => !(i === 0 && m === GREETING) && m.content.trim())
        .slice(-20);
      const result = await askCannaPlug({
        data: { sessionId, messages: history.length ? history : nextMessages.slice(-1) },
      });
      if (result.allowance) setAllowance(result.allowance);
      if (!result.ok) {
        setError(result.signInRequired ? "Please sign in to chat." : result.error);
      } else {
        setMessages((current) => [...current, { role: "assistant", content: result.reply }]);
      }
    } catch (err) {
      if (err instanceof Error && /unauthorized/i.test(err.message)) {
        setError("Please sign in again to keep chatting.");
        return;
      }
      setError(
        "Our assistant couldn't respond just now. Please try again, or contact the team directly.",
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className={cn("chat-notch", open && "chat-notch-hidden")}
        onClick={() => setOpen(true)}
        aria-label="Open CannaPlug AI chat"
        aria-expanded={open}
      >
        <Sparkles size={16} />
        <span>Ask CannaPlug AI</span>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            className="chat-panel"
            role="dialog"
            aria-modal="true"
            aria-label="CannaPlug AI chat"
            initial={{ opacity: 0, y: 24, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 24, scale: 0.97 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="chat-head">
              <div className="chat-head-title">
                <span className="chat-avatar">
                  <Bot size={17} />
                </span>
                <div>
                  <strong>CannaPlug AI</strong>
                  <small>
                    {userId ? "Ask about products, policies & your order" : "For signed-in members"}
                  </small>
                </div>
              </div>
              <button
                type="button"
                aria-label="Close chat"
                onClick={() => setOpen(false)}
                className="chat-close"
              >
                <X size={18} />
              </button>
            </div>

            <div className="chat-body" ref={listRef}>
              {messages.map((message, index) => (
                <div
                  key={index}
                  className={
                    message.role === "user"
                      ? "chat-bubble chat-bubble-user"
                      : "chat-bubble chat-bubble-bot"
                  }
                >
                  {message.content}
                </div>
              ))}
              {loading && (
                <div className="chat-bubble chat-bubble-bot chat-bubble-loading">
                  <Loader2 size={14} className="chat-spinner" /> Thinking…
                </div>
              )}
              {!userId && (
                <div className="chat-bubble chat-bubble-bot">
                  Ask CannaPlug AI is for members. Sign in (or create a free account) and I can help
                  with products, delivery and your latest order.
                </div>
              )}
              {error && <div className="chat-error">{error}</div>}
            </div>

            {!userId ? (
              <div className="chat-input-row" style={{ justifyContent: "center" }}>
                <Link
                  to="/account"
                  onClick={() => setOpen(false)}
                  className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
                >
                  <LogIn size={15} /> Sign in to chat
                </Link>
              </div>
            ) : (
              <form className="chat-input-row" onSubmit={submit}>
                <input
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  placeholder="Ask about products, delivery, hours…"
                  aria-label="Message CannaPlug AI"
                  disabled={loading}
                />
                <button type="submit" aria-label="Send message" disabled={loading || !input.trim()}>
                  {loading ? <Loader2 size={16} className="chat-spinner" /> : <Send size={16} />}
                </button>
              </form>
            )}
            {userId && allowance && (
              <p className="chat-disclaimer" aria-live="polite">
                {allowance.remaining} of {allowance.limit} messages left today · resets{" "}
                {resetTime(allowance.resetsAt)}
              </p>
            )}
            <p className="chat-disclaimer">
              <MessageCircle size={11} /> AI answers are general guidance, not medical advice. 18+
              only.
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
