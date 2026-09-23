// Supabase Edge Function: cannaplug-chat
//
// Proxies chat messages from the CannaPlug AI widget to a free-tier Google
// Gemini model. Configure in the Supabase project dashboard
// (Project Settings -> Edge Functions -> Secrets):
//
//   GEMINI_API_KEY   (required) — API key from https://aistudio.google.com/apikey
//   GEMINI_MODEL     (optional) — defaults to "gemini-2.0-flash"
//   CANNAPLUG_SYSTEM_PROMPT (optional) — overrides the default system prompt below,
//                     letting store policies / tone be tuned without a redeploy.
//
// Deploy with: supabase functions deploy cannaplug-chat --no-verify-jwt

const DEFAULT_SYSTEM_PROMPT = `You are CannaPlug AI, the friendly virtual budtender for CannaPlug, a licensed
premium cannabis dispensary at Shop 002, One On Mutual, Pretoria Central, South Africa.

Voice: warm, knowledgeable, concise. No judgement, no hype, no medical claims.

Know this about the store:
- Hours: Mon–Fri 09:00–19:00, Sat 09:00–20:00, Sun 09:00–15:00.
- Contact: +27 10 123 4567, hello@cannaplug.co.za.
- Products: flower, edibles, vapes, concentrates and accessories — all lab tested.
- Rewards: CannaPlug Rewards loyalty points on every purchase, redeemable in-store and online.
- Plug Back: bring 10 empty CannaPlug pre-roll tubes, get 1 complimentary Greenhouse pre-roll (in-store only, while stocks last).
- Delivery: discreet local delivery available at checkout alongside standard delivery.
- Age & compliance: customers must be 18+. CannaPlug is a licensed medical cannabis
  dispensary, SAHPRA Section 21 authorised (Registration No. 2026/047873/07). Encourage
  responsible consumption; never provide dosing or medical advice — recommend customers
  speak with a healthcare professional or in-store staff for personalised guidance.
- Online account: customers can create an account to track orders, save products and
  manage rewards at /account. Store staff also use an internal admin dashboard.

If you don't know something specific (exact stock, live pricing, order status), say so
plainly and suggest contacting the team or visiting in person rather than guessing.
Keep replies short — a few sentences, not an essay — unless the customer asks for detail.`;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type ChatMessage = { role: "user" | "assistant"; content: string };

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) {
      return new Response(
        JSON.stringify({
          error: "GEMINI_API_KEY is not configured on this function yet.",
        }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { messages } = (await req.json()) as { messages?: ChatMessage[] };
    if (!Array.isArray(messages) || messages.length === 0) {
      return new Response(JSON.stringify({ error: "Request must include a non-empty messages array." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const model = Deno.env.get("GEMINI_MODEL") || "gemini-2.0-flash";
    const systemPrompt = Deno.env.get("CANNAPLUG_SYSTEM_PROMPT") || DEFAULT_SYSTEM_PROMPT;

    const contents = messages
      .filter((m) => m && typeof m.content === "string" && m.content.trim().length > 0)
      .slice(-20)
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents,
          systemInstruction: { role: "system", parts: [{ text: systemPrompt }] },
          generationConfig: { temperature: 0.6, maxOutputTokens: 512 },
        }),
      },
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error("Gemini API error", response.status, errText);
      return new Response(
        JSON.stringify({ error: "The AI assistant is temporarily unavailable. Please try again shortly." }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const data = await response.json();
    const reply: string =
      data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ??
      "Sorry, I couldn't put together an answer just then — could you try rephrasing that?";

    return new Response(JSON.stringify({ reply }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("cannaplug-chat error", error);
    return new Response(JSON.stringify({ error: "Something went wrong handling that message." }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
