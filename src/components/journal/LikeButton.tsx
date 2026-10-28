import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Heart } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { getMyArticleLikeFn, setArticleLikeFn } from "@/lib/journal.functions";

/**
 * Like an article. The count is public; only a signed-in member can like, and the like is stored against their
 * account so it is still there next time they sign in on any browser.
 */
export function LikeButton({
  articleId,
  initialCount,
}: {
  articleId: string;
  initialCount: number;
}) {
  const { user } = useAuth();
  const [count, setCount] = useState(initialCount);
  const [liked, setLiked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needSignIn, setNeedSignIn] = useState(false);
  const userId = user?.id;

  useEffect(() => setCount(initialCount), [initialCount]);
  useEffect(() => {
    if (!userId) {
      setLiked(false);
      return;
    }
    let live = true;
    getMyArticleLikeFn({ data: { articleId } })
      .then((v) => live && setLiked(v))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [userId, articleId]);

  const toggle = async () => {
    if (!userId) return setNeedSignIn(true);
    if (busy) return;
    const next = !liked;
    setBusy(true);
    setError(null);
    setLiked(next); // optimistic
    setCount((c) => Math.max(0, c + (next ? 1 : -1)));
    try {
      const r = await setArticleLikeFn({ data: { articleId, liked: next } });
      setLiked(r.liked);
      setCount(r.like_count);
    } catch (e) {
      setLiked(!next);
      setCount((c) => Math.max(0, c + (next ? -1 : 1)));
      setError(e instanceof Error ? e.message : "Could not save your like.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="journal-like">
      <button
        type="button"
        className={"journal-like-btn" + (liked ? " is-liked" : "")}
        aria-pressed={liked}
        aria-label={liked ? "Unlike this story" : "Like this story"}
        disabled={busy}
        onClick={() => void toggle()}
      >
        <Heart size={18} fill={liked ? "currentColor" : "none"} aria-hidden />
        <span>{liked ? "Liked" : "Like"}</span>
        <b aria-label={`${count} likes`}>{count}</b>
      </button>
      {needSignIn && !userId && (
        <p role="status" className="journal-like-note">
          <Link to="/account">Sign in</Link> to like stories. Your likes are saved to your account.
        </p>
      )}
      {error && (
        <p role="alert" className="journal-like-note is-error">
          {error}
        </p>
      )}
    </div>
  );
}
