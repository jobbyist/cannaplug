export type Draft = {
  bank: string;
  account_holder: string;
  account_type: string;
  account_number: string;
  branch_code: string;
};

export const eftDraftValid = (d: Draft) =>
  d.bank.trim().length >= 2 &&
  d.account_holder.trim().length >= 2 &&
  /^[0-9]{6,16}$/.test(d.account_number.replace(/\s/g, "")) &&
  /^[0-9]{6}$/.test(d.branch_code.replace(/\s/g, ""));
