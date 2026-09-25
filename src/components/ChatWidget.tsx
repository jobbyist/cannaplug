import { useEffect, useRef, useState, type FormEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Bot, Loader2, MessageCircle, Send, Sparkles, X } from "lucide-react";
import { askCannaPlug } from "@/lib/chat.functions";
import { cn } from "@/lib/utils";

type ChatMessage = { role: "user" | "assistant"; content: string };

const STORAGE_KEY = "cannaplug.chat.v1";
const SESSION_KEY = "cannaplug.chat.session";
const GREETING: ChatMessage = {
  role: "assistant",
  content:
    "Hey, I'm CannaPlug AI \u{1F33F} Ask me about our products, store policies, delivery or hours — I'm happy to help.",
};

function loadHistory(): ChatMessage[] {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as ChatMessage[];
  } catch {
    /* ignore malformed history */
  }
  return [GREETING];
}

export function ChatWidget() {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([GREETING]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMounted(true);
    setMessages(loadHistory());
  }, []);

  useEffect(() => {
    if (!mounted) return;
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
    } catch {
      /* ignore quota errors */
    }
  }, [messages, mounted]);

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

  if (!mounted) return null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = input.trim();
    if (!text || loading) return;

    const nextMessages = [...messages, { role: "user", content: text } satisfies ChatMessage];
    setMessages(nextMessages);
    setInput("");
    setError(null);
    setLoading(true);

    try {
      let sessionId = window.sessionStorage.getItem(SESSION_KEY);
      if (!sessionId) {
        sessionId = crypto.randomUUID();
        window.sessionStorage.setItem(SESSION_KEY, sessionId);
      }
      const history = nextMessages.filter((m, i) => !(i === 0 && m === GREETING) && m.content.trim()).slice(-20);
      const result = await askCannaPlug({ data: { sessionId, messages: history.length ? history : nextMessages.slice(-1) } });
      if (!result.ok) {
        setError(result.error);
      } else {
        setMessages((current) => [...current, { role: "assistant", content: result.reply }]);
      }
    } catch {
      setError("Our assistant couldn't respond just now. Please try again, or contact the team directly.");
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
                  <small>Ask about products &amp; policies</small>
                </div>
              </div>
              <button type="button" aria-label="Close chat" onClick={() => setOpen(false)} className="chat-close">
                <X size={18} />
              </button>
            </div>

            <div className="chat-body" ref={listRef}>
              {messages.map((message, index) => (
                <div key={index} className={message.role === "user" ? "chat-bubble chat-bubble-user" : "chat-bubble chat-bubble-bot"}>
                  {message.content}
                </div>
              ))}
              {loading && (
                <div className="chat-bubble chat-bubble-bot chat-bubble-loading">
                  <Loader2 size={14} className="chat-spinner" /> Thinking…
                </div>
              )}
              {error && <div className="chat-error">{error}</div>}
            </div>

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
            <p className="chat-disclaimer">
              <MessageCircle size={11} /> AI answers are general guidance, not medical advice. 18+ only.
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
