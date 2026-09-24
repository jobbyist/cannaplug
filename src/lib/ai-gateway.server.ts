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

export const EDITORIAL_MODEL = "google/gemini-3.6-flash";

/** Streams a long generation and returns the accumulated text (keeps bytes flowing for long runs). */
export async function geminiStream(model: string, messages: ChatMessage[]): Promise<string> {
  const key = process.env["LOVABLE_API_KEY"];
  if (!key) throw new GatewayError(401, "AI is not configured on this project yet.");

  const response = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Lovable-API-Key": key,
      "X-Lovable-AIG-SDK": "fetch",
    },
    body: JSON.stringify({ model, messages, stream: true }),
  });

  if (!response.ok || !response.body) {
    const body = await response.text();
    console.error(`[AI Gateway] ${response.status}: ${body}`);
    throw new GatewayError(response.status, `AI Gateway error ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const json = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
        text += json.choices?.[0]?.delta?.content ?? "";
      } catch {
        /* partial frame */
      }
    }
  }
  return text.trim();
}
