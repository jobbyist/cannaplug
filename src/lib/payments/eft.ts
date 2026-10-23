/** Bank-transfer (EFT) details as members see them. Stored in payment_settings by payment_set_eft_details. */
export type EftDetails = {
  bank: string;
  account_holder: string;
  account_type: string | null;
  account_number: string;
  branch_code: string;
};

/** Only owner-confirmed, well-formed details are ever shown; anything else hides the EFT option. */
export function parseEftDetails(value: unknown): EftDetails | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const s = (k: string) => (typeof v[k] === "string" ? (v[k] as string).trim() : "");
  if (v["confirmed_by_owner"] !== true) return null;
  if (!s("bank") || !s("account_holder") || !/^[0-9]{6,16}$/.test(s("account_number"))) return null;
  if (!/^[0-9]{6}$/.test(s("branch_code"))) return null;
  return {
    bank: s("bank"),
    account_holder: s("account_holder"),
    account_type: s("account_type") || null,
    account_number: s("account_number"),
    branch_code: s("branch_code"),
  };
}

/** Label/value rows for the checkout confirmation and the account page. */
export const eftRows = (d: EftDetails): [string, string][] => [
  ["Bank", d.bank],
  ["Account holder", d.account_holder],
  ...(d.account_type ? ([["Account type", d.account_type]] as [string, string][]) : []),
  ["Account number", d.account_number],
  ["Branch code", d.branch_code],
];
