/** Push topics as members see them. Mirrors public.push_topic_meta (a test keeps the two in step). */
export type PushTopic = {
  id: string;
  label: string;
  hint: string;
  defaultOn: boolean;
  marketing: boolean;
  staff: boolean;
};

export const PUSH_TOPICS: PushTopic[] = [
  {
    id: "orders",
    label: "Orders",
    hint: "Received, paid, ready, on its way",
    defaultOn: true,
    marketing: false,
    staff: false,
  },
  {
    id: "account",
    label: "Account",
    hint: "Updates about your account and documents",
    defaultOn: true,
    marketing: false,
    staff: false,
  },
  {
    id: "back_in_stock",
    label: "Back in stock",
    hint: "When something you asked about returns",
    defaultOn: true,
    marketing: false,
    staff: false,
  },
  {
    id: "journal",
    label: "New Journal articles",
    hint: "Not sent between 21:00 and 07:00",
    defaultOn: false,
    marketing: true,
    staff: false,
  },
  {
    id: "promos",
    label: "Offers and events",
    hint: "Not sent between 21:00 and 07:00",
    defaultOn: false,
    marketing: true,
    staff: false,
  },
  {
    id: "staff_orders",
    label: "Staff: new orders",
    hint: "Online orders waiting",
    defaultOn: true,
    marketing: false,
    staff: true,
  },
  {
    id: "staff_stock",
    label: "Staff: low stock",
    hint: "Daily low-stock alert",
    defaultOn: true,
    marketing: false,
    staff: true,
  },
  {
    id: "staff_payments",
    label: "Staff: payments",
    hint: "Reviews, refunds and EFT approvals",
    defaultOn: true,
    marketing: false,
    staff: true,
  },
  {
    id: "staff_id",
    label: "Staff: ID queue",
    hint: "IDs waiting for review",
    defaultOn: true,
    marketing: false,
    staff: true,
  },
];

export const topicIds = PUSH_TOPICS.map((t) => t.id) as [string, ...string[]];
