import { Fragment } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { SITE_URL } from "@/lib/site";
import { breadcrumbJsonLd, breadcrumbsFor, type Crumb } from "@/lib/breadcrumbs";

/**
 * "Home › Catalog › Flower": where you are and the way back up. Reads the address by itself; pages that are not
 * routes of their own (the admin tabs) pass the trail. Renders nothing on the home page.
 */
export function Breadcrumbs({
  trail,
  className,
  bare = false,
}: {
  trail?: Crumb[];
  className?: string;
  /** Inside a page that already has its own padding (the account and admin screens). */
  bare?: boolean;
}) {
  const { pathname, searchStr } = useRouterState({
    select: (s) => ({ pathname: s.location.pathname, searchStr: s.location.searchStr }),
  });
  const crumbs = trail ?? breadcrumbsFor(pathname, searchStr);
  if (crumbs.length < 2) return null;
  const origin = SITE_URL;
  const ld = breadcrumbJsonLd(crumbs, origin, pathname);
  return (
    <nav
      aria-label="Breadcrumb"
      data-testid="breadcrumbs"
      className={
        (bare
          ? "mb-4 text-xs text-muted-foreground "
          : "mx-auto w-full max-w-[1180px] px-4 pt-3 text-xs text-muted-foreground sm:px-6 lg:px-8 ") +
        (className ?? "")
      }
    >
      <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return (
            <Fragment key={`${c.label}-${i}`}>
              <li className="min-w-0">
                {last || !c.to ? (
                  <span
                    aria-current={last ? "page" : undefined}
                    className="block max-w-[60vw] truncate font-semibold text-foreground sm:max-w-md"
                  >
                    {c.label}
                  </span>
                ) : (
                  <Link
                    to={c.to}
                    {...(c.search ? { search: c.search } : {})}
                    className="hover:text-primary hover:underline"
                  >
                    {c.label}
                  </Link>
                )}
              </li>
              {!last && (
                <li aria-hidden="true" className="text-muted-foreground/60">
                  <ChevronRight size={12} />
                </li>
              )}
            </Fragment>
          );
        })}
      </ol>
      {ld && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(ld) }}
        />
      )}
    </nav>
  );
}
