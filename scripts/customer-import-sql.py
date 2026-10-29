#!/usr/bin/env python3
"""
Prepares a customer import from the Clinify export (xlsx) WITHOUT putting any customer data in the repository.

  python3 scripts/customer-import-sql.py EXPORT.xlsx --first 186 --actor <admin user id> --batch clinify-1-186 --out-dir DIR

Writes, to DIR (keep it outside the repository: the files hold names, emails and phone numbers):
  import-<batch>.sql        one statement: select public.import_customers(...) with the rows as JSON. Run it once in the
                            Supabase SQL editor (or with the service role). Needs migration 20261030001000_customer_import.
  remaining-members.xlsx    the export in the same layout, without the members that were put in the SQL, ready for the
                            next batch. A member who could not be included (e.g. under 18 on file) stays here with a note
                            unless --drop-members removes them for good.
Prints a summary with member numbers only.

Rules applied here (the database repeats the important ones): members are taken in member-number order; an email address
with spaces inside (a transcription slip in the export) is closed up and the member's invitation is HELD until the owner
confirms it (--confirmed-emails lists the members the owner already confirmed); a member under 18 is never imported; usernames are used exactly as in the file.
"""
import argparse, hashlib, json, re, sys, uuid
from pathlib import Path
import openpyxl


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("xlsx")
    ap.add_argument("--first", type=int, default=186, help="how many members (by member number) this batch covers")
    ap.add_argument("--actor", required=True, help="user id of the admin who runs the import")
    ap.add_argument("--batch", required=True, help="batch name, a-z 0-9 _ - (3 to 60 characters)")
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--confirmed-emails", default="", help="member numbers whose closed-up email the owner confirmed")
    ap.add_argument("--drop-members", default="", help="member numbers removed for good (not imported, not in the remaining file)")
    a = ap.parse_args()
    if not re.fullmatch(r"[0-9a-f-]{36}", a.actor) or not re.fullmatch(r"[a-z0-9_-]{3,60}", a.batch):
        sys.exit("bad --actor or --batch")

    raw = Path(a.xlsx).read_bytes()
    sha = hashlib.sha256(raw).hexdigest()
    wb = openpyxl.load_workbook(a.xlsx)
    ws = wb["Customers"]
    title = ws.cell(1, 1).value
    header = [c.value for c in ws[2]]
    rows = [r for r in ws.iter_rows(min_row=3, values_only=True) if r[0] is not None]
    rows.sort(key=lambda r: r[0])
    batch_rows, rest = rows[: a.first], rows[a.first :]
    dropped = {int(x) for x in a.drop_members.split(",") if x.strip()}
    confirmed = {int(x) for x in a.confirmed_emails.split(",") if x.strip()}
    batch_rows = [r for r in batch_rows if r[0] not in dropped]
    rest = [r for r in rest if r[0] not in dropped]

    payload, held_minor, held_email = [], [], []
    for n, first, last, email, phone, age, username in batch_rows:
        if age is None or age < 18:
            held_minor.append(n)
            continue
        email_raw = (email or "").strip()
        email_clean = re.sub(r"\s+", "", email_raw).lower()
        item = {
            "member_number": n,
            "first_name": (first or "").strip(),
            "last_name": (last or "").strip(),
            "email": email_clean,
            "phone": re.sub(r"^\((\d{3})\)\s*(\d{3})-(\d{4})$", r"\1 \2 \3", (phone or "").strip()),
            "username": (username or "").strip().lower(),
            "age": age,
        }
        if re.search(r"\s", email_raw) and n not in confirmed:
            item["hold"] = "email looked mistyped in the export: confirm before inviting"
            held_email.append(n)
        payload.append(item)

    out = Path(a.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    tag = "j" + uuid.uuid4().hex[:8]
    body = json.dumps(payload, ensure_ascii=False)
    assert f"${tag}$" not in body
    sql = (
        f"-- {a.batch}: {len(payload)} members from export sha256 {sha}. Contains personal data: do not commit or share.\n"
        f"select public.import_customers('{a.actor}'::uuid, '{a.batch}'::text, '{sha}'::text, ${tag}${body}${tag}$::jsonb, '{a.batch}-{sha[:12]}'::text);\n"
    )
    (out / f"import-{a.batch}.sql").write_text(sql, encoding="utf-8")

    # Remaining members, same layout as the export. Members held back from this batch stay, with a note.
    notes = {n: "Held back from batch 1: age on file is under 18. Confirm age before importing." for n in held_minor}
    rem = openpyxl.Workbook()
    rws = rem.active
    rws.title = "Customers"
    todo = sorted(rest + [r for r in batch_rows if r[0] in notes], key=lambda r: r[0])
    rws.append([f"Clinify Customer Import - {len(todo)} Members remaining | members not yet imported into Cannaplug"])
    rws.append(header + ["Note"])
    for r in todo:
        rws.append(list(r) + [notes.get(r[0], "")])
    for col, w in zip("ABCDEFGH", (14, 18, 18, 36, 16, 6, 28, 60)):
        rws.column_dimensions[col].width = w
    for c in rws[2]:
        c.font = openpyxl.styles.Font(bold=True)
    sm = rem.create_sheet("Summary")
    ages = [r[5] for r in todo if r[5] is not None]
    for line in [
        ("Cannaplug customer import - remaining members", None),
        (None, None),
        ("Remaining members", len(todo)),
        ("Next member number to import", min((r[0] for r in todo), default=None)),
        ("Held back (needs a decision)", len(notes)),
        ("Imported (member numbers)", f"1 to {a.first}" + (f", except {', '.join(map(str, sorted(dropped | set(held_minor))))}" if dropped or held_minor else "")),
        ("Source file sha256", sha),
        ("Min age / max age", f"{min(ages)} / {max(ages)}" if ages else ""),
    ]:
        sm.append(list(line))
    sm.column_dimensions["A"].width = 38
    sm.column_dimensions["B"].width = 70
    rem.save(out / "remaining-members.xlsx")

    print(json.dumps({"title": title, "batch": a.batch, "sha256": sha, "in_sql": len(payload),
                      "dropped": sorted(dropped), "held_under_18": held_minor, "invitation_held_for_email": held_email,
                      "remaining_rows": len(todo)}, indent=2))


if __name__ == "__main__":
    main()
