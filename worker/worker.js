/**
 * Heartstrings Studio — story intake proxy.
 *
 * Holds the Anthropic API key as a Worker secret and proxies the
 * frontend's POST requests to the Anthropic Messages API. The browser
 * never sees the key and never talks to Anthropic directly.
 *
 * The frontend sends ONLY a messages payload: { "messages": [...] }.
 * This Worker supplies the model, max_tokens, and the system prompt,
 * then returns the Anthropic response body unchanged.
 *
 * Secret required:   ANTHROPIC_API_KEY   (wrangler secret put ANTHROPIC_API_KEY)
 * Optional var:      ALLOWED_ORIGIN      (your GitHub Pages origin; defaults to "*")
 */

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 1024;

const SYSTEM_PROMPT =
  "You are an interviewer for a custom songwriting studio in Lumberport, West Virginia. A client is commissioning a song and has just told you about the person it's for. Your job is to ask a few warm, specific follow-up questions that surface the concrete details a great song needs: a sensory detail (place, smell, object), an exact phrase the person said, one specific small moment (not a summary), and the emotional core the client most wants conveyed. Read their actual words and ask about THEM specifically — reference what they said. Never ask generic questions. Ask in a warm, plainspoken, grounded voice. One idea per question. Never mention that you are an AI or reference anything technical. CRITICAL — the client's first message states the occasion (Wedding, Milestone, Birthday, Memorial, Tribute, Retirement, Anniversary, or Other). Tailor every question strictly to that occasion. Never introduce wedding, vow, ceremony, or spouse framing unless the stated occasion is 'Wedding'. Never introduce death, passing, or grief framing unless the stated occasion is 'Memorial'. If the occasion is a memorial, be especially gentle: ask only about who the person was — their warmth, habits, sayings, small moments — never about how or why they died, and make clear any question is okay to skip. Respond ONLY with valid JSON, no markdown, in this shape: {\"questions\": [\"...\"], \"extracted\": {\"sensory\":\"\", \"phrase\":\"\", \"moment\":\"\", \"emotional_core\":\"\"}, \"complete\": false}. Put 1-4 questions for non-memorial occasions, 1-2 for memorials. Set complete:true and questions:[] once you have enough concrete material.";

export default {
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || "*";
    const cors = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    };

    // Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405, cors);
    }

    if (!env.ANTHROPIC_API_KEY) {
      return json({ error: "Server not configured" }, 500, cors);
    }

    // Parse and validate the incoming payload — pass through ONLY messages.
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON" }, 400, cors);
    }

    const messages = body && body.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return json({ error: "Missing messages" }, 400, cors);
    }

    // Sanitize: keep only role + string content.
    const clean = messages
      .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .map(m => ({ role: m.role, content: m.content }));

    if (clean.length === 0) {
      return json({ error: "No valid messages" }, 400, cors);
    }

    try {
      const upstream = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system: SYSTEM_PROMPT,
          messages: clean,
        }),
      });

      const text = await upstream.text();
      return new Response(text, {
        status: upstream.status,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    } catch (err) {
      return json({ error: "Upstream request failed" }, 502, cors);
    }
  },
};

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
