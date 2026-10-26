// Which /admin tabs each staff role sees. The server checks every action again; this only keeps the screen tidy
// so a budtender is not shown tabs whose actions they would be refused.
export type StaffRole = "budtender" | "manager" | "admin";
const LEVEL: Record<StaffRole, number> = { budtender: 1, manager: 2, admin: 3 };

export const TAB_MIN_ROLE: Record<string, StaffRole> = {
  overview: "budtender",
  pos: "budtender",
  orders: "budtender",
  deliveries: "budtender",
  products: "budtender", // budtenders see the list without cost and cannot edit
  inventory: "budtender",
  customers: "budtender",
  payments: "manager",
  audit: "manager",
  "id-checks": "budtender", // budtenders review IDs; only admins reset a locked-out member
  promotions: "manager",
  events: "manager",
  newsroom: "manager",
  reports: "manager",
  settings: "manager",
  clinical: "admin",
};

export const canSee = (role: StaffRole | null, tab: string) =>
  !!role && LEVEL[role] >= LEVEL[TAB_MIN_ROLE[tab] ?? "admin"];

export const atLeast = (role: StaffRole | null, min: StaffRole) =>
  !!role && LEVEL[role] >= LEVEL[min];

export const ROLE_LABEL: Record<StaffRole, string> = {
  budtender: "Budtender",
  manager: "Manager",
  admin: "Admin",
};
