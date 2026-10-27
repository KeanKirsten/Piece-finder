// Vercel serverless function: POST /api/analyse
// Receives an outfit photo (data URL) and an optional note, asks Google Gemini to
// pick out the shoppable pieces, and returns { vibe, pieces:[{label,category,query}] }.
//
// Environment variables (Vercel > Project > Settings > Environment Variables):
//   GEMINI_API_KEY  required. Your Google AI Studio key. Never put it in the page.
//   ACCESS_CODE     optional. If set, callers must send it in the x-access-code header,
//                   which stops strangers who find the URL from using your quota.
//   GEMINI_MODEL    optional. Defaults to gemini-3.6-flash.
//
// No CORS headers are set on purpose: only the page served from this same site can call it.

const crypto = require("crypto");

const MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";

const SYSTEM = `You are a fashion stylist's assistant. Look at the outfit photo and identify each distinct clothing item, pair of shoes or accessory that a shopper could buy. Include at most 6 pieces and skip anything not clearly visible.

For each piece give:
- label: a short human name in British English, e.g. "Chocolate pinstripe trousers"
- category: one of top, outerwear, dress, bottoms, shoes, bag, accessory, other
- query: a plain 2 to 5 word phrase a shopper would type into a South African fashion retailer's search box, including colour and key style words, e.g. "brown pinstripe wide leg trousers". Do not include brand names.

Also give "vibe": one short sentence describing the overall look. If the photo shows no clothing, return an empty pieces list.

Respond with ONLY valid JSON, no markdown, in exactly this shape:
{"vibe":"...","pieces":[{"label":"...","category":"...","query":"..."}]}`;

function sameSecret(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function parseDataUrl(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || "");
  if (!m) return null;
  return { mime: m[1], data: m[2] };
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body) {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return {}; }
}

function friendly(status, detail) {
  const d = String(detail || "").toLowerCase();
  if (status === 400 && d.includes("api key")) return "The server's Gemini key was rejected. Check GEMINI_API_KEY in Vercel.";
  if (status === 401 || status === 403) return "Google refused the request. Check GEMINI_API_KEY in Vercel. " + (detail || "");
  if (status === 404) return "That Gemini model name no longer exists. Change GEMINI_MODEL in Vercel.";
  if (status === 429) return "Google's free quota is used up for now. Try again in a minute, or tomorrow.";
  return "Google returned an error (" + status + "). " + (detail || "");
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }

  const code = process.env.ACCESS_CODE || "";
  if (code && !sameSecret(req.headers["x-access-code"] || "", code)) {
    res.status(401).json({ error: "That access code is missing or wrong." });
    return;
  }

  const KEY = process.env.GEMINI_API_KEY || "";
  if (!KEY) { res.status(500).json({ error: "Server not set up: add GEMINI_API_KEY in Vercel, then redeploy." }); return; }

  const body = await readBody(req);
  const img = parseDataUrl(String(body.image || ""));
  if (!img) { res.status(400).json({ error: "Send a JPG, PNG or WebP photo." }); return; }
  if (img.data.length > 4_000_000) { res.status(413).json({ error: "That photo is too large. Try a smaller one." }); return; }

  const note = String(body.note || "").slice(0, 200);
  const userText = note ? "Shopper's note: " + note : "Identify the shoppable pieces in this look.";

  const payload = {
    system_instruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: "user", parts: [
      { inline_data: { mime_type: img.mime, data: img.data } },
      { text: userText },
    ] }],
    generationConfig: { temperature: 0.3, maxOutputTokens: 2000, responseMimeType: "application/json" },
  };

  let g;
  try {
    g = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(MODEL) + ":generateContent",
      { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": KEY }, body: JSON.stringify(payload) }
    );
  } catch {
    res.status(502).json({ error: "Could not reach Google. Try again in a moment." });
    return;
  }

  if (!g.ok) {
    let detail = "";
    try { const j = await g.json(); detail = (j.error && j.error.message) || ""; } catch { /* ignore */ }
    res.status(g.status === 429 ? 429 : 502).json({ error: friendly(g.status, detail) });
    return;
  }

  const data = await g.json();
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  let text = parts.map((p) => (p && p.text) || "").join("").trim();
  if (!text) { res.status(502).json({ error: "Google returned nothing usable for that photo. Try another one." }); return; }

  text = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  let out;
  try { out = JSON.parse(text); } catch { res.status(502).json({ error: "Could not read the AI's answer. Try again." }); return; }

  const pieces = (Array.isArray(out && out.pieces) ? out.pieces : [])
    .filter((p) => p && p.query)
    .slice(0, 6)
    .map((p) => ({
      label: String(p.label || p.query).slice(0, 70),
      category: String(p.category || "").slice(0, 20),
      query: String(p.query).slice(0, 80),
    }));

  res.status(200).json({ vibe: String((out && out.vibe) || "").slice(0, 220), pieces });
};
