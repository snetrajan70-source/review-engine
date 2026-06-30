// ============================================================
//  /api/analyze  —  Vercel serverless function (Node.js 18+)
//
//  Primary engine: NVIDIA NIM (build.nvidia.com hosted inference,
//  OpenAI-compatible). Automatic fallback: OpenRouter, if its key
//  is also set. Keys stay SERVER-SIDE as Vercel env vars.
//
//  Set in Vercel → Settings → Environment Variables, then REDEPLOY:
//      NVIDIA_API_KEY = nvapi-...            (primary)
//      OPENROUTER_API_KEY = sk-or-v1-...     (optional fallback)
//  Optional model overrides:
//      NVIDIA_MODEL     = meta/llama-3.3-70b-instruct
//      OPENROUTER_MODEL = meta-llama/llama-3.3-70b-instruct:free
// ============================================================
"use strict";

const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_NVIDIA_MODEL = "meta/llama-3.3-70b-instruct";
const DEFAULT_OPENROUTER_MODEL = "meta-llama/llama-3.3-70b-instruct:free";
const MAX_REVIEW_CHARS = 24000;

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

function readBody(req) {
  return new Promise((resolve) => {
    if (req.body !== undefined && req.body !== null) { resolve(req.body); return; }
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => resolve(data));
    req.on("error", () => resolve(""));
  });
}

function callChat(url, key, model, messages, useJsonMode) {
  const payload = { model: model, temperature: 0.2, max_tokens: 1500, messages: messages };
  if (useJsonMode) payload.response_format = { type: "json_object" };
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
    body: JSON.stringify(payload)
  });
}

async function tryProvider(url, key, model, messages) {
  let r = await callChat(url, key, model, messages, true);
  if (!r.ok && (r.status === 400 || r.status === 422)) r = await callChat(url, key, model, messages, false);
  return r;
}

module.exports = async function handler(req, res) {
  const nvKey = process.env.NVIDIA_API_KEY;
  const orKey = process.env.OPENROUTER_API_KEY;
  const nvModel = process.env.NVIDIA_MODEL || DEFAULT_NVIDIA_MODEL;
  const orModel = process.env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL;

  if (req.method === "GET") {
    res.status(200).json({
      ok: true,
      service: "AI Review Discovery Engine proxy",
      primary: nvKey ? "NVIDIA NIM" : (orKey ? "OpenRouter (fallback only)" : "none"),
      nvidiaConfigured: !!nvKey,
      openrouterConfigured: !!orKey,
      model: nvKey ? nvModel : orModel,
      hint: "Set NVIDIA_API_KEY (nvapi-...) in Vercel and redeploy. POST { reviews } here to analyze. If OPENROUTER_API_KEY is also set, it is used automatically when NVIDIA fails."
    });
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: { message: "Method not allowed — use GET for health or POST to analyze." } });
    return;
  }

  if (!nvKey && !orKey) {
    res.status(500).json({ error: { message: "No API key configured. Set NVIDIA_API_KEY (and optionally OPENROUTER_API_KEY) in Vercel → Settings → Environment Variables and redeploy." } });
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

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt(reviews) }
    ];

    const chain = [];
    if (nvKey) chain.push({ url: NVIDIA_URL, key: nvKey, model: nvModel });
    if (orKey) chain.push({ url: OPENROUTER_URL, key: orKey, model: orModel });

    let lastStatus = 502;
    let lastError = { error: { message: "No provider available." } };

    for (const p of chain) {
      const r = await tryProvider(p.url, p.key, p.model, messages);
      const data = await r.json().catch(() => null);
      if (r.ok && data && data.choices) {
        res.status(200).json(data);
        return;
      }
      lastStatus = r.status || 502;
      lastError = (data && data.error) ? data : { error: { message: "Upstream HTTP " + r.status } };
    }

    res.status(lastStatus).json(lastError);
  } catch (e) {
    res.status(502).json({ error: { message: "Proxy error: " + ((e && e.message) || "unknown") } });
  }
};
