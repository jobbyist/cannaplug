// Server-only helpers for Lovable AI Gateway (Gemini) calls.
const GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";

export const GEMINI_MODEL = "google/gemini-3.1-flash-lite";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export class GatewayError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Removes markdown emphasis/heading marks so replies read like a natural text message. */
export function toPlainText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```/g, "").trim())
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/^\s*[*+]\s+/gm, "• ")
    .replace(/#/g, "")
    .replace(/\*/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function geminiComplete(
  messages: ChatMessage[],
  options: { maxTokens?: number; temperature?: number } = {},
): Promise<string> {
  const key = process.env["LOVABLE_API_KEY"];
  if (!key) throw new GatewayError(401, "AI is not configured on this project yet.");

  const response = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Lovable-API-Key": key,
      "X-Lovable-AIG-SDK": "fetch",
    },
    body: JSON.stringify({
      model: GEMINI_MODEL,
      messages,
      temperature: options.temperature ?? 0.6,
      max_tokens: options.maxTokens ?? 900,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    console.error(`[AI Gateway] ${response.status}: ${body}`);
    if (response.status === 429) throw new GatewayError(429, "The assistant is busy right now. Please try again in a moment.");
    if (response.status === 402) throw new GatewayError(402, "AI credits for this workspace are used up.");
    throw new GatewayError(response.status, "The assistant is temporarily unavailable.");
  }

  const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}
