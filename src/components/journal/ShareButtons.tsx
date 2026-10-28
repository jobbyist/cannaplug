import { useState } from "react";
import { Check, Link2, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { shareLinks } from "@/components/journal/share-links";

/** Share this story: the device's share sheet where there is one, copy-link, and the main networks. */
export function ShareButtons({ url, title, text }: { url: string; title: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  const native = async () => {
    try {
      await navigator.share({ title, text, url });
    } catch {
      /* the member closed the share sheet */
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Copy this link", url);
    }
  };

  return (
    <div className="journal-share" role="group" aria-label="Share this story">
      <span className="journal-share-label">
        <Share2 size={14} aria-hidden /> Share
      </span>
      {canShare && (
        <Button type="button" size="sm" variant="outline" onClick={() => void native()}>
          Share…
        </Button>
      )}
      <Button type="button" size="sm" variant="outline" onClick={() => void copy()}>
        {copied ? <Check size={13} /> : <Link2 size={13} />} {copied ? "Link copied" : "Copy link"}
      </Button>
      {shareLinks(url, title).map((l) => (
        <a
          key={l.id}
          className="journal-share-link"
          href={l.href}
          target={l.id === "email" ? undefined : "_blank"}
          rel="noopener noreferrer"
        >
          {l.label}
        </a>
      ))}
      <span role="status" aria-live="polite" className="sr-only">
        {copied ? "Link copied to clipboard" : ""}
      </span>
    </div>
  );
}
