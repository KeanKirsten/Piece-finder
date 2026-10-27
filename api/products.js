// Vercel serverless function: POST /api/products   body: { query }
// Finds the closest matching products from ANY South African store listed on Google
// Shopping, via SerpApi, and returns [{ title, source, price, thumbnail, link }].
//
// Environment variables:
//   SERPAPI_KEY   required for this feature. Free plan at serpapi.com (250 searches a month).
//                 If it is not set, this returns 501 and the page quietly falls back to
//                 Woolworths-only pictures.
//   ACCESS_CODE   optional, same passcode as /api/analyse.
//
// No CORS headers on purpose: only this site's own page can call it.

const crypto = require("crypto");

function sameSecret(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
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

const httpsOnly = (u) => (typeof u === "string" && /^https:\/\//i.test(u) ? u : "");

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }

  const code = process.env.ACCESS_CODE || "";
  if (code && !sameSecret(req.headers["x-access-code"] || "", code)) {
    res.status(401).json({ error: "That access code is missing or wrong." });
    return;
  }

  const KEY = process.env.SERPAPI_KEY || "";
  if (!KEY) { res.status(501).json({ error: "not_configured" }); return; }

  const body = await readBody(req);
  const query = String(body.query || "").trim().slice(0, 100);
  if (!query) { res.status(400).json({ error: "Missing query" }); return; }

  const u = new URL("https://serpapi.com/search.json");
  u.searchParams.set("engine", "google_shopping");
  u.searchParams.set("q", query);
  u.searchParams.set("gl", "za");
  u.searchParams.set("hl", "en");
  u.searchParams.set("google_domain", "google.co.za");
  u.searchParams.set("api_key", KEY);

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  let r;
  try {
    r = await fetch(u.toString(), { signal: ctl.signal });
  } catch {
    clearTimeout(timer);
    res.status(502).json({ error: "Could not reach the product search. Try again." });
    return;
  }
  clearTimeout(timer);

  if (r.status === 429) { res.status(429).json({ error: "The product search credits are used up for this month." }); return; }
  if (r.status === 401 || r.status === 403) { res.status(502).json({ error: "The product search key was rejected. Check SERPAPI_KEY in Vercel." }); return; }

  let data = {};
  try { data = await r.json(); } catch { /* ignore */ }
  if (!r.ok && !data.shopping_results) {
    res.status(502).json({ error: "The product search returned an error (" + r.status + ")." });
    return;
  }

  const products = (Array.isArray(data.shopping_results) ? data.shopping_results : [])
    .map((p) => ({
      title: String(p.title || "").slice(0, 120),
      source: String(p.source || "").slice(0, 40),
      price: String(p.price || "").slice(0, 24),
      thumbnail: httpsOnly(p.thumbnail),
      link: httpsOnly(p.link) || httpsOnly(p.product_link),
    }))
    .filter((p) => p.title && p.thumbnail && p.link)
    .slice(0, 8);

  res.status(200).json({ products });
};
