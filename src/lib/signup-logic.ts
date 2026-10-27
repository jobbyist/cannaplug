/**
 * Sign-up form rules (browser side, so people get a clear message before anything is sent). The ID/passport
 * number is only ever stored in a locked table by the database trigger; it is never put in an email, a log or
 * an analytics event.
 */

/** Luhn check used by South African ID numbers. */
export function saIdChecksumOk(id: string): boolean {
  if (!/^\d{13}$/.test(id)) return false;
  let sum = 0;
  for (let i = 0; i < 13; i++) {
    let d = Number(id[12 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Cleans what was typed: removes spaces and dashes, keeps letters and digits. */
export const normaliseIdNumber = (raw: string): string => raw.replace(/[\s-]/g, "").toUpperCase();

/**
 * null when the ID / passport number looks right. A 13-digit number is treated as a South African ID: it must pass
 * the checksum and its birth date (YYMMDD) must match the date of birth entered. Anything else must look like a
 * passport number (6-20 letters or digits).
 */
export function idNumberProblem(raw: string, dob: string): string | null {
  const id = normaliseIdNumber(raw);
  if (!id) return "Enter your ID or passport number.";
  if (/^\d{13}$/.test(id)) {
    if (!saIdChecksumOk(id)) return "That ID number doesn't look right. Check it and try again.";
    if (
      /^\d{4}-\d{2}-\d{2}$/.test(dob) &&
      id.slice(0, 6) !== dob.slice(2, 4) + dob.slice(5, 7) + dob.slice(8, 10)
    )
      return "Your ID number and date of birth don't match. Check both.";
    return null;
  }
  if (!/^[A-Z0-9]{6,20}$/.test(id))
    return "Enter a 13-digit ID number or a passport number (6 to 20 letters and numbers).";
  return null;
}

export function phoneProblem(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (!/^\+?[\d\s()-]+$/.test(raw.trim()) || digits.length < 9 || digits.length > 15)
    return "Enter a valid phone number, for example 082 123 4567.";
  return null;
}

/** Optional. null when empty or well formed. */
export function referralProblem(raw: string): string | null {
  const code = raw.trim();
  if (!code) return null;
  return /^[A-Za-z0-9-]{3,32}$/.test(code)
    ? null
    : "A referral code is 3 to 32 letters, numbers or dashes.";
}

export type SignupFields = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  dob: string;
  idNumber: string;
  referral: string;
};

/** First problem found, or null. Name, surname, email, phone, date of birth and ID/passport number are all required. */
export function signupProblem(f: SignupFields, dobIssue: string | null): string | null {
  if (f.firstName.trim().length < 1) return "Enter your name.";
  if (f.lastName.trim().length < 1) return "Enter your surname.";
  if (!/^\S+@\S+\.\S+$/.test(f.email.trim())) return "Enter a valid email address.";
  return (
    phoneProblem(f.phone) ??
    dobIssue ??
    idNumberProblem(f.idNumber, f.dob) ??
    referralProblem(f.referral)
  );
}

/** What goes into the account's sign-up data. Names are trimmed; the ID number is normalised. */
export function signupMetadata(f: SignupFields) {
  const first = f.firstName.trim();
  const last = f.lastName.trim();
  return {
    full_name: `${first} ${last}`,
    first_name: first,
    last_name: last,
    phone: f.phone.trim(),
    date_of_birth: f.dob,
    id_number: normaliseIdNumber(f.idNumber),
    ...(f.referral.trim() ? { referral_code: f.referral.trim().toUpperCase() } : {}),
  };
}
