import { useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { addArticleCommentFn } from "@/lib/journal.functions";

export type JournalComment = { id: string; name: string; body: string; at: string };

const when = (iso: string) =>
  new Date(iso).toLocaleDateString("en-ZA", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Africa/Johannesburg",
  });

/** Comments are text only (never HTML) and only signed-in members can post. */
export function CommentSection({
  articleId,
  slug,
  comments,
}: {
  articleId: string;
  slug: string;
  comments: JournalComment[];
}) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const key = useRef<string | null>(null);

  const post = async () => {
    const text = body.trim();
    if (text.length < 2) return setError("Write at least a couple of words.");
    setBusy(true);
    setError(null);
    setSent(false);
    key.current ??= crypto.randomUUID();
    try {
      await addArticleCommentFn({ data: { articleId, body: text, key: key.current } });
      key.current = null;
      setBody("");
      setSent(true);
      await qc.invalidateQueries({ queryKey: ["journal", "engagement", slug] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not post your comment.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="journal-comments" aria-labelledby="comments-heading">
      <h2 id="comments-heading">
        <MessageCircle size={18} aria-hidden /> Comments ({comments.length})
      </h2>
      {comments.length === 0 ? (
        <p className="journal-comments-empty">
          No comments yet. Be the first to join the conversation.
        </p>
      ) : (
        <ul className="journal-comment-list">
          {comments.map((c) => (
            <li key={c.id}>
              <div className="journal-comment-head">
                <b>{c.name}</b>
                <time dateTime={c.at}>{when(c.at)}</time>
              </div>
              <p>{c.body}</p>
            </li>
          ))}
        </ul>
      )}
      {user ? (
        <form
          className="journal-comment-form"
          onSubmit={(e) => {
            e.preventDefault();
            void post();
          }}
        >
          <label htmlFor="comment-body">Add a comment</label>
          <textarea
            id="comment-body"
            value={body}
            maxLength={1000}
            rows={4}
            placeholder="Share your thoughts. Please keep it respectful and leave out personal or health details."
            onChange={(e) => setBody(e.target.value)}
          />
          <div className="journal-comment-actions">
            <small>{body.length}/1000</small>
            <Button type="submit" disabled={busy || body.trim().length < 2}>
              {busy ? "Posting…" : "Post comment"}
            </Button>
          </div>
          {error && (
            <p role="alert" className="journal-like-note is-error">
              {error}
            </p>
          )}
          {sent && <p role="status">Thanks, your comment is up.</p>}
        </form>
      ) : (
        <p className="journal-comment-signin">
          <Link to="/account">Sign in</Link> to join the conversation. Comments are for signed-in
          members only.
        </p>
      )}
    </section>
  );
}
