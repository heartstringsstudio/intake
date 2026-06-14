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
 * Vars (wrangler.toml):
 *   ALLOWED_ORIGIN   Comma-separated origin allowlist for the published page,
 *                    e.g. "https://heartstringsstudio.github.io". When unset or
 *                    "*", the proxy is OPEN to any origin (not recommended — it
 *                    lets anyone spend the studio's Anthropic credits).
 * Optional binding:
 *   RATE_LIMIT       A KV namespace. When bound, requests are throttled per IP.
 *                    When absent, rate limiting is skipped.
 */

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 1024;

// Payload guards — a single interview never needs more than this.
const MAX_MESSAGES = 40;
const MAX_TOTAL_CHARS = 24000;

// Per-IP rate limit (only enforced when a RATE_LIMIT KV namespace is bound).
const RATE_LIMIT_MAX = 30; // requests
const RATE_LIMIT_WINDOW = 60; // seconds

const SYSTEM_PROMPT =
  "You are an interviewer for a custom songwriting studio in Lumberport, West Virginia. A client is commissioning a song and has just told you about the person it's for. Your job is to ask a few warm, specific follow-up questions that surface the concrete details a great song needs: a sensory detail (place, smell, object), an exact phrase the person said, one specific small moment (not a summary), and the emotional core the client most wants conveyed. Read their actual words and ask about THEM specifically — reference what they said. Never ask generic questions. Ask in a warm, kind, and professional voice. Use proper grammar and standard written English — never use regional slang, contractions like \"y'all,\" or informal colloquialisms. One idea per question. Never mention that you are an AI or reference anything technical. CRITICAL — the client's first message states the occasion (Wedding, Milestone, Birthday, Memorial, Tribute, Retirement, Anniversary, or Other). Tailor every question strictly to that occasion. Never introduce wedding, vow, ceremony, or spouse framing unless the stated occasion is 'Wedding'. Never introduce death, passing, or grief framing unless the stated occasion is 'Memorial'. If the occasion is a memorial, be especially gentle: ask only about who the person was — their warmth, habits, sayings, small moments — never about how or why they died, and make clear any question is okay to skip. Respond ONLY with valid JSON, no markdown, in this shape: {\"questions\": [\"...\"], \"extracted\": {\"sensory\":\"\", \"phrase\":\"\", \"moment\":\"\", \"emotional_core\":\"\"}, \"complete\": false}. Put 1-4 questions for non-memorial occasions, 1-2 for memorials. Set complete:true and questions:[] once you have enough concrete material.";

export default {
  async fetch(request, env) {
    const allowlist = parseAllowlist(env.ALLOWED_ORIGIN);
    const open = allowlist.length === 0; // no allowlist configured => open proxy
    const requestOrigin = request.headers.get("Origin") || "";

    // Which origin do we echo back in CORS headers?
    const allowOrigin = open
      ? "*"
      : (allowlist.includes(requestOrigin) ? requestOrigin : allowlist[0]);

    const cors = {
      "Access-Control-Allow-Origin": allowOrigin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
    };

    // Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405, cors);
    }

    // Origin enforcement. CORS headers only restrain browsers; this check
    // rejects scripted requests (curl, bots) that omit or spoof a bad Origin.
    // When no allowlist is configured we stay open for backward compatibility.
    if (!open) {
      if (requestOrigin && !allowlist.includes(requestOrigin)) {
        return json({ error: "Origin not allowed" }, 403, cors);
      }
      // A browser fetch from the page always sends Origin; its absence on a
      // POST is a strong signal of a non-browser caller.
      if (!requestOrigin) {
        return json({ error: "Origin required" }, 403, cors);
      }
    }

    if (!env.ANTHROPIC_API_KEY) {
      return json({ error: "Server not configured" }, 500, cors);
    }

    // Per-IP rate limit (no-op unless a RATE_LIMIT KV namespace is bound).
    const limited = await isRateLimited(env, request);
    if (limited) {
      return json({ error: "Too many requests" }, 429, cors);
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

    if (messages.length > MAX_MESSAGES) {
      return json({ error: "Too many messages" }, 413, cors);
    }

    // Sanitize: keep only role + string content.
    const clean = messages
      .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .map(m => ({ role: m.role, content: m.content }));

    if (clean.length === 0) {
      return json({ error: "No valid messages" }, 400, cors);
    }

    const totalChars = clean.reduce((n, m) => n + m.content.length, 0);
    if (totalChars > MAX_TOTAL_CHARS) {
      return json({ error: "Payload too large" }, 413, cors);
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

function parseAllowlist(raw) {
  if (!raw || raw.trim() === "*") return [];
  return raw
    .split(",")
    .map(s => s.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

async function isRateLimited(env, request) {
  if (!env.RATE_LIMIT) return false; // KV not bound — limiting disabled
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const key = `rl:${ip}`;
  let count = 0;
  try {
    count = parseInt((await env.RATE_LIMIT.get(key)) || "0", 10) || 0;
    if (count >= RATE_LIMIT_MAX) return true;
    // Best-effort increment; the TTL gives us a rolling window.
    await env.RATE_LIMIT.put(key, String(count + 1), { expirationTtl: RATE_LIMIT_WINDOW });
  } catch {
    // If KV misbehaves, don't take the proxy down — fail open.
    return false;
  }
  return false;
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
