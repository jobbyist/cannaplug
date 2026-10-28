import { formatInstantDate } from "@/lib/clinical/logic";

export const errorText = (err: unknown) =>
  err instanceof Error ? err.message : "Something went wrong. Please try again.";

export const when = (iso: string | null | undefined) => formatInstantDate(iso) ?? "—";

export const whenTime = (iso: string | null | undefined) =>
  iso
    ? new Intl.DateTimeFormat("en-ZA", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Africa/Johannesburg",
      }).format(new Date(iso))
    : "—";

/** A date input value (YYYY-MM-DD) -> end of that day in South Africa (UTC+2, no daylight saving). */
export const endOfDaySast = (date: string) => `${date}T23:59:59+02:00`;
export const dateInputValue = (iso: string | null | undefined) =>
  iso
    ? new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg" }).format(new Date(iso))
    : "";
