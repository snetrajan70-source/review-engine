// ============================================================
//  /api/analyze  —  Vercel serverless function (Node.js 18+)
//
//  Holds the OpenRouter API key SERVER-SIDE so it never appears in
//  the public page. The browser POSTs { reviews, model } here; this
//  function injects the key, calls OpenRouter, and returns the raw
//  chat-completions response for the client to parse.
//
//  Required environment variable (set in Vercel → Project → Settings
//  → Environment Variables):
//      OPENROUTER_API_KEY = sk-or-v1-...
//  Optional:
//      OPENROUTER_MODEL   = meta-llama/llama-3.3-70b-instruct:free
// ============================================================
"use strict";

const DEFAULT_MODEL = "meta-llama/llama-3.3-70b-instruct:free";
const MAX_REVIEW_CHARS = 24000; // guard against oversized / abusive prompts

const SYSTEM_PROMPT =
  "You are a senior product analyst for a music streaming app. You analyze raw user reviews and surface EMERGENT themes grounded only in the text provided. Do not invent feedback. Detect sentiment so praise is not reported as a pain point. Capture issues that fall OUTSIDE music discovery (pricing, ads, bugs, account, performance, audio quality, or anything else) in an 'other' array so nothing is forced into a discovery narrative. Respond with a single JSON object only.";

function userPrompt(reviews) {
  return [
    "Analyze the reviews below and return ONLY this JSON shape:",
    "{",
    '  "summary": "1-2 sentence neutral overview",',
    '  "themes": [{"name": "...", "type": "pain|praise|neutral", "mentions": <int>, "evidence": "short paraphrase"}],',
    '  "goals": [{"title": "...", "desc": "..."}],',
    '  "painPoints": [{"title": "...", "desc": "..."}],',
    '  "segments": [{"name": "...", "share": <int 0-100>, "desc": "..."}],',
    '  "opportunities": [{"title": "...", "desc": "..."}],',
    '  "other": [{"name": "...", "mentions": <int>, "desc": "off-thesis / emergent issue"}]',
    "}",
    "Rules: themes must be emergent (not from a fixed list); mentions = number of reviews; shares are directional signal share, not population percentages; put non-discovery feedback in 'other'.",
    "",
    "REVIEWS:",
    reviews
  ].join("\n");
}

// Read the request body whether Vercel pre-parsed it or not.
function readBody(req) {
  return new Promise((resolve) => {
    if (req.body !== undefined && req.body !== null) { resolve(req.body); return; }
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => resolve(data));
    req.on("error", () => resolve(""));
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: { message: "Method not allowed — use POST." } });
    return;
  }

  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    res.status(500).json({ error: { message: "Server is missing OPENROUTER_API_KEY. Set it in your Vercel project's Environment Variables and redeploy." } });
    return;
  }

  try {
    let body = await readBody(req);
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};

    const reviews = (body.reviews || "").toString();
    if (!reviews.trim()) { res.status(400).json({ error: { message: "No reviews provided." } }); return; }
    if (reviews.length > MAX_REVIEW_CHARS) {
      res.status(413).json({ error: { message: "Too much text — keep it under " + MAX_REVIEW_CHARS + " characters per request." } });
      return;
    }

    // Only honor a client-supplied model if it is a free model; otherwise use
    // the server's configured (or default) model. Caps cost from public traffic.
    let model = (body.model || "").toString().trim();
    if (!model.endsWith(":free")) model = process.env.OPENROUTER_MODEL || DEFAULT_MODEL;

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt(reviews) }
    ];

    const callOpenRouter = (useJsonMode) => {
      const payload = { model: model, temperature: 0.2, max_tokens: 1500, messages: messages };
      if (useJsonMode) payload.response_format = { type: "json_object" };
      return fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + key,
          "X-Title": "AI Review Discovery Engine"
        },
        body: JSON.stringify(payload)
      });
    };

    // Try JSON mode; many free models reject response_format — retry without it.
    let r = await callOpenRouter(true);
    if (!r.ok && (r.status === 400 || r.status === 422)) r = await callOpenRouter(false);

    const data = await r.json().catch(() => ({ error: { message: "Upstream returned a non-JSON response." } }));
    res.status(r.status).json(data);
  } catch (e) {
    res.status(502).json({ error: { message: "Proxy error: " + ((e && e.message) || "unknown") } });
  }
};
