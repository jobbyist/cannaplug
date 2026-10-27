import { useEffect, useMemo, useState } from "react";
import { birthYears, joinDob, splitDob } from "@/lib/verification-logic";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const selectClass =
  "h-10 w-full rounded-md border border-input bg-background px-2 text-base md:text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/**
 * Date of birth as three dropdowns (day, month, year). A phone's date picker opens on today's date, so people
 * scrolled back the year and kept today's day and month, or gave up. Separate fields avoid both. `value` and
 * `onChange` use YYYY-MM-DD; until all three parts are chosen the value is "".
 */
export function DateOfBirthField({
  id,
  label,
  value,
  onChange,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (dob: string) => void;
  hint?: React.ReactNode;
}) {
  const [parts, setParts] = useState(() => splitDob(value));
  // Follow a value set from outside (e.g. the date already given at sign-up).
  useEffect(() => {
    if (value && value !== joinDob(parts)) setParts(splitDob(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const years = useMemo(() => birthYears(), []);

  const set = (key: "day" | "month" | "year") => (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = { ...parts, [key]: e.target.value };
    setParts(next);
    onChange(joinDob(next));
  };

  return (
    <fieldset className="grid gap-1.5">
      <legend className="mb-1.5 text-sm font-medium leading-none">{label}</legend>
      <div className="grid grid-cols-[1fr_1.6fr_1.2fr] gap-2">
        <select
          id={id}
          aria-label="Day"
          required
          value={parts.day}
          onChange={set("day")}
          className={selectClass}
        >
          <option value="">Day</option>
          {Array.from({ length: 31 }, (_, i) => String(i + 1)).map((d) => (
            <option key={d} value={d.padStart(2, "0")}>
              {d}
            </option>
          ))}
        </select>
        <select
          aria-label="Month"
          required
          value={parts.month}
          onChange={set("month")}
          className={selectClass}
        >
          <option value="">Month</option>
          {MONTHS.map((m, i) => (
            <option key={m} value={String(i + 1).padStart(2, "0")}>
              {m}
            </option>
          ))}
        </select>
        <select
          aria-label="Year"
          required
          value={parts.year}
          onChange={set("year")}
          className={selectClass}
        >
          <option value="">Year</option>
          {years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
      </div>
      {hint}
    </fieldset>
  );
}
