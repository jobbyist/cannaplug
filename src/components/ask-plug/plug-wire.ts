import type { PlugReply } from "@/lib/chat.functions";

export type PlugPick = Extract<PlugReply, { ok: true }>["picks"][number];
export type PlugMessage = {
  role: "user" | "assistant";
  content: string;
  picks?: PlugPick[];
  quickReplies?: string[];
};

export const MAX_INPUT = 500;

export const STARTERS = [
  "Help me pick some flower",
  "Pre-rolls for a chilled night in",
  "What's new on the menu?",
  "What's on special?",
  "Indica vs sativa, what's the deal?",
];

/** What is sent to the server: text only (never product data), the greeting left out. */
export function toWire(messages: PlugMessage[]) {
  return messages
    .slice(1)
    .filter((m) => m.content.trim())
    .map((m) => ({
      role: m.role,
      content: m.content.trim().slice(0, m.role === "user" ? MAX_INPUT : 900),
    }))
    .slice(-20);
}
