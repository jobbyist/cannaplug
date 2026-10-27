// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { DateOfBirthField } from "@/components/account/DateOfBirthField";
import { birthYears, dobProblem, isRealDate, joinDob, splitDob } from "@/lib/verification-logic";

function Harness({ initial = "" }: { initial?: string }) {
  const [dob, setDob] = useState(initial);
  return (
    <>
      <DateOfBirthField id="dob" label="Date of birth" value={dob} onChange={setDob} />
      <output data-testid="out">{dob}</output>
    </>
  );
}

describe("date of birth dropdowns", () => {
  afterEach(cleanup);

  it("builds YYYY-MM-DD only once day, month and year are all chosen", async () => {
    render(<Harness />);
    const out = screen.getByTestId("out");
    await userEvent.selectOptions(screen.getByLabelText("Day"), "7");
    await userEvent.selectOptions(screen.getByLabelText("Month"), "March");
    expect(out.textContent).toBe("");
    await userEvent.selectOptions(screen.getByLabelText("Year"), "1996");
    expect(out.textContent).toBe("1996-03-07");
  });

  it("does not start on today's date (the old picker's trap)", () => {
    render(<Harness />);
    for (const name of ["Day", "Month", "Year"])
      expect((screen.getByLabelText(name) as HTMLSelectElement).value).toBe("");
  });

  it("shows a date given earlier, e.g. at sign-up", () => {
    render(<Harness initial="1990-05-17" />);
    expect((screen.getByLabelText("Day") as HTMLSelectElement).value).toBe("17");
    expect((screen.getByLabelText("Month") as HTMLSelectElement).value).toBe("05");
    expect((screen.getByLabelText("Year") as HTMLSelectElement).value).toBe("1990");
  });

  it("offers every year back 120 years, so under-18s see the age message", () => {
    const today = new Date(2026, 9, 27);
    const years = birthYears(today);
    expect(years[0]).toBe("2026");
    expect(years).toContain("2008");
    expect(years.at(-1)).toBe("1906");
  });

  it("catches days that don't exist and helps finish a half-filled date", () => {
    const today = new Date(2026, 9, 27);
    expect(isRealDate("2000-02-29")).toBe(true);
    expect(isRealDate("2001-02-29")).toBe(false);
    expect(isRealDate("1999-04-31")).toBe(false);
    expect(dobProblem("1999-04-31", today)).toMatch(/doesn't exist/);
    expect(dobProblem("", today)).toMatch(/day, month and year/);
    expect(joinDob({ day: "7", month: "3", year: "1996" })).toBe("1996-03-07");
    expect(joinDob({ day: "7", month: "", year: "1996" })).toBe("");
    expect(splitDob("bad")).toEqual({ day: "", month: "", year: "" });
  });
});
