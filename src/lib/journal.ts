import { queryOptions } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export const JOURNAL_CATEGORIES = ["Culture", "Industry", "Law & Policy", "Wellness", "Lifestyle"] as const;

export type JournalSource = { url: string; title: string };
export type JournalArticle = {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  category: string;
  body_md: string;
  reading_minutes: number;
  cover_image_url: string | null;
  cover_credit_name: string | null;
  cover_credit_url: string | null;
  sources: JournalSource[];
  published_at: string;
};

const listColumns =
  "id, slug, title, excerpt, category, reading_minutes, cover_image_url, cover_credit_name, cover_credit_url, published_at";

export type JournalListItem = Omit<JournalArticle, "body_md" | "sources">;

export const journalListQuery = (limit = 60) =>
  queryOptions({
    queryKey: ["journal", "list", limit],
    queryFn: async (): Promise<JournalListItem[]> => {
      const { data, error } = await supabase
        .from("articles")
        .select(listColumns)
        .lte("published_at", new Date().toISOString())
        .order("published_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data ?? []) as JournalListItem[];
    },
  });

export const journalArticleQuery = (slug: string) =>
  queryOptions({
    queryKey: ["journal", "article", slug],
    queryFn: async (): Promise<JournalArticle | null> => {
      const { data, error } = await supabase.from("articles").select("*").eq("slug", slug).maybeSingle();
      if (error) throw error;
      return (data as unknown as JournalArticle) ?? null;
    },
  });

export const formatJournalDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-ZA", { day: "numeric", month: "long", year: "numeric", timeZone: "Africa/Johannesburg" });

export const UNSPLASH_REF = "https://unsplash.com/?utm_source=cannaplug&utm_medium=referral";
