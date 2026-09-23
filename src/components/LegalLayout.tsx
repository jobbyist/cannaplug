import type { ReactNode } from "react";
import { Header, Footer } from "@/components/CannaPlugHome";

export type LegalSection = {
  heading: string;
  body: ReactNode;
};

export function LegalLayout({
  eyebrow,
  title,
  updated,
  intro,
  sections,
}: {
  eyebrow: string;
  title: string;
  updated: string;
  intro?: ReactNode;
  sections: LegalSection[];
}) {
  return (
    <div className="site">
      <Header />
      <main className="mx-auto w-full max-w-[880px] px-4 py-14 sm:px-6 lg:px-8">
        <p className="text-[0.68rem] font-bold uppercase tracking-[0.16em] text-primary">
          {eyebrow}
        </p>
        <h1 className="mt-2 font-display text-3xl font-extrabold uppercase sm:text-4xl">{title}</h1>
        <p className="mt-3 text-xs text-muted-foreground">Last updated: {updated}</p>
        {intro && (
          <p className="mt-6 max-w-2xl text-sm leading-relaxed text-muted-foreground">{intro}</p>
        )}

        <div className="mt-10 flex flex-col gap-9">
          {sections.map((section) => (
            <section key={section.heading} className="border-t border-border pt-7">
              <h2 className="font-display text-lg font-bold uppercase tracking-tight">
                {section.heading}
              </h2>
              <div className="mt-3 flex flex-col gap-3 text-sm leading-relaxed text-muted-foreground">
                {section.body}
              </div>
            </section>
          ))}
        </div>

        <div className="mt-12 rounded-xl border border-border bg-card p-5 text-xs text-muted-foreground">
          Questions about this policy? Contact us at{" "}
          <a
            className="font-semibold text-primary underline-offset-2 hover:underline"
            href="mailto:hello@cannaplug.co.za"
          >
            hello@cannaplug.co.za
          </a>{" "}
          or +27 10 123 4567.
        </div>
      </main>
      <Footer />
    </div>
  );
}
