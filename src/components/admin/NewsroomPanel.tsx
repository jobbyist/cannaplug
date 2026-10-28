import { useCallback, useEffect, useState } from "react";
import { EyeOff, ImageDown, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  fetchArticleImagesFn,
  hideArticleCommentFn,
  listRecentCommentsFn,
} from "@/lib/journal.functions";

type Comments = Awaited<ReturnType<typeof listRecentCommentsFn>>;
type Report = Awaited<ReturnType<typeof fetchArticleImagesFn>>;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");

/** Journal tools for managers: fetch Unsplash photos for articles that ask for them, and moderate comments. */
export function NewsroomPanel() {
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [comments, setComments] = useState<Comments | null>(null);

  const load = useCallback(async () => {
    try {
      setComments(await listRecentCommentsFn());
    } catch (e) {
      setError(errMsg(e));
    }
  }, []);
  useEffect(() => void load(), [load]);

  const fetchImages = async () => {
    setBusy(true);
    setError(null);
    try {
      setReport(await fetchArticleImagesFn({ data: {} }));
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const hide = async (id: string) => {
    const reason = window.prompt("Why hide this comment? (3-200 characters)");
    if (!reason || reason.trim().length < 3) return;
    setError(null);
    try {
      await hideArticleCommentFn({ data: { commentId: id, reason: reason.trim() } });
      await load();
    } catch (e) {
      setError(errMsg(e));
    }
  };

  return (
    <div className="grid gap-5">
      <h1 className="font-display text-xl font-extrabold uppercase">Newsroom</h1>
      {error && (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}

      <section className="rounded-xl border border-border bg-card p-5">
        <h2 className="mb-1 font-display text-sm font-bold uppercase">Article photos</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          Gives each Journal article that asks for photos a cover and the photos between its
          paragraphs, searched on Unsplash with the key set in Vercel (UNSPLASH_ACCESS_KEY).
          Photographers are credited on the page. Photos already set are kept, so it is safe to run
          again.
        </p>
        <Button onClick={() => void fetchImages()} disabled={busy}>
          <ImageDown size={14} /> {busy ? "Fetching photos…" : "Fetch article images"}
        </Button>
        {report && (
          <ul className="mt-3 grid gap-1 text-xs" aria-label="Photo results">
            {report.articles.map((a) => (
              <li key={a.slug}>
                <b>{a.slug}</b> — cover {a.cover ? "✓" : "missing"}, {a.inline} inline photos
                {a.missing.length > 0 && (
                  <span className="text-destructive"> · no result for: {a.missing.join(", ")}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-display text-sm font-bold uppercase">Recent comments</h2>
          <Button size="sm" variant="outline" onClick={() => void load()}>
            <RefreshCw size={13} /> Refresh
          </Button>
        </div>
        {!comments ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : comments.length === 0 ? (
          <p className="text-xs text-muted-foreground">No comments yet.</p>
        ) : (
          <ul className="divide-y divide-border text-xs">
            {comments.map((c) => (
              <li key={c.id} className="flex items-start justify-between gap-3 py-2">
                <span className={c.hidden ? "text-muted-foreground line-through" : ""}>
                  <b>{c.name}</b>
                  {c.isSeed && <i className="text-muted-foreground"> (seeded)</i>} on{" "}
                  <i>{c.article?.title ?? "an article"}</i>: {c.body}
                </span>
                {!c.hidden && (
                  <Button size="sm" variant="outline" onClick={() => void hide(c.id)}>
                    <EyeOff size={13} /> Hide
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
