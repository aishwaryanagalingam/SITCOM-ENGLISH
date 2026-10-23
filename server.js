// SitcomEnglish server: serves the website and proxies AI chat to the Anthropic API.
// The API key stays on the server (never in the browser). No npm packages needed, Node 18+ only.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
// Provider: "anthropic" (default) or "openai" (any OpenAI-compatible API, e.g. Groq or Gemini, which have free tiers)
const PROVIDER = (process.env.LLM_PROVIDER || "anthropic").toLowerCase();
const API_KEY = process.env.LLM_API_KEY || process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.MODEL || (PROVIDER === "anthropic" ? "claude-sonnet-5-5" : "");
const API_URL = process.env.LLM_BASE_URL || process.env.ANTHROPIC_API_URL ||
  (PROVIDER === "anthropic" ? "https://api.anthropic.com/v1/messages" : "");
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || ""; // e.g. https://www.yoursite.com (optional)
const MAX_PROMPT = 12000;                                 // characters
const LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 40);                          // requests ...
const LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MIN || 10) * 60 * 1000; // ... per window, per visitor
const PUBLIC = path.join(__dirname, "public");

if (!API_KEY) {
  console.error("Missing API key. Set ANTHROPIC_API_KEY (or LLM_API_KEY) as an environment variable. See README.md.");
  process.exit(1);
}
if (PROVIDER !== "anthropic" && (!API_URL || !MODEL)) {
  console.error("For LLM_PROVIDER=openai you must also set LLM_BASE_URL and MODEL. See README.md.");
  process.exit(1);
}

const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".txt": "text/plain" };

// tiny in-memory rate limiter (per visitor IP). With several server instances, use a shared store such as Redis.
const hits = new Map();
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now - v.start > LIMIT_WINDOW_MS) hits.delete(k); }, 60000).unref();
function visitorIp(req) {
  const xf = req.headers["x-forwarded-for"]; // set by Render/Railway/Vercel proxies
  return (xf ? String(xf).split(",")[0].trim() : req.socket.remoteAddress) || "unknown";
}
function limited(req) {
  const now = Date.now(), ip = visitorIp(req);
  let h = hits.get(ip);
  if (!h || now - h.start > LIMIT_WINDOW_MS) { h = { start: now, n: 0 }; hits.set(ip, h); }
  return ++h.n > LIMIT_MAX;
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body === "object" && !Buffer.isBuffer(body);
  res.writeHead(status, Object.assign({
    "Content-Type": isJson ? "application/json" : "text/plain",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin"
  }, headers));
  res.end(isJson ? JSON.stringify(body) : body);
}

function readBody(req, max = 40000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > max) { reject(new Error("too_large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function clean(v, n) { return String(v == null ? "" : v).replace(/[\u0000-\u001f]+/g, " ").slice(0, n).trim(); }

// How a tutor talks: like a real person in a voice conversation, not like a textbook.
function tutorSystem(t, phrase) {
  const name = clean(t && t.name, 40) || "Tutor", role = clean(t && t.role, 60), persona = clean(t && t.persona, 500);
  return `You are ${name}${role ? ", " + role : ""}, a tutor character on an English-learning website for Tamil-speaking learners. ${persona}

You are having a relaxed spoken conversation with the learner, like a friend who happens to be great at English. Your words are read aloud, so:
- Reply in 1 to 3 short sentences (under 45 words). Natural spoken English with contractions.
- First react to what the learner actually said, with a real reaction: laugh, show surprise, agree, tease gently. Then add at most ONE small teaching point. Then end with a question or tiny challenge that keeps them talking.
- Remember what they told you earlier in the chat and refer back to it.
- If they make a mistake, repeat the sentence correctly in a natural way ("Ah, you went to the market yesterday, nice!") without lecturing.
- If they write Tanglish (Tamil in English letters), answer mostly in simple English with a short Tanglish hint.
- If they sound sad, tired or stuck, be kind first and teach second.
- No lists, no markdown, no emojis, no stage directions, no quotation of long text. Vary how you start your replies.
- Stay in character. Do not say you are an AI unless they ask directly. Never mention or quote real TV shows or their characters.
${phrase ? `- The idiom currently on their screen is "${clean(phrase.phrase, 80)}" (${clean(phrase.meaning, 160)}). Use it naturally if it fits. Do not force it.` : ""}`;
}

function normalizeMessages(list) {
  const out = [];
  for (const m of Array.isArray(list) ? list.slice(-20) : []) {
    const role = m && m.role === "assistant" ? "assistant" : m && m.role === "user" ? "user" : null;
    const content = clean(m && m.content, 1200);
    if (!role || !content) continue;
    if (out.length && out[out.length - 1].role === role) out[out.length - 1].content += "\n" + content;
    else out.push({ role, content });
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

async function callModel(system, messages, maxTokens) {
  let r;
  if (PROVIDER === "anthropic") {
    r = await fetch(API_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages })
    });
  } else {
    r = await fetch(API_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + API_KEY },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages: [{ role: "system", content: system }, ...messages] })
    });
  }
  if (!r.ok) { const e = new Error("upstream " + r.status); e.status = r.status; e.body = (await r.text()).slice(0, 300); throw e; }
  const data = await r.json();
  if (PROVIDER === "anthropic") return (data.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
  return String(data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || "").trim();
}

async function chat(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGIN && origin && origin !== ALLOWED_ORIGIN) return send(res, 403, { error: "forbidden" });
  if (limited(req)) return send(res, 429, { error: "rate_limited" });
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: "bad_request" }); }
  let system, messages, maxTokens;
  if (Array.isArray(body.messages)) {                 // live conversation with a tutor
    messages = normalizeMessages(body.messages);
    if (!messages.length) return send(res, 400, { error: "bad_request" });
    system = tutorSystem(body.tutor, body.phrase); maxTokens = 260;
  } else if (typeof body.prompt === "string" && body.prompt.trim() && body.prompt.length <= MAX_PROMPT) { // one-off tasks (idiom lookup)
    system = "You are a helpful English teacher for Tamil-speaking learners. Follow the instructions in the user's message exactly.";
    messages = [{ role: "user", content: body.prompt }]; maxTokens = 1200;
  } else return send(res, 400, { error: "bad_request" });
  try {
    const text = await callModel(system, messages, maxTokens);
    send(res, 200, { text });
  } catch (e) {
    console.error("chat failed:", e.message, e.body || "");
    send(res, e.status === 429 ? 429 : 502, { error: "upstream_error" });
  }
}

function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p.endsWith("/")) p += "index.html";
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) return send(res, 403, "Forbidden");
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, "Not found");
    send(res, 200, data, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true });
  if (req.method === "POST" && url.pathname === "/api/chat") return chat(req, res);
  if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res);
  send(res, 405, { error: "method_not_allowed" });
}).listen(PORT, () => console.log(`SitcomEnglish running on http://localhost:${PORT}`));
