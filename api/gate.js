// LearnWow Gate — one shared checkpoint for every LearnWow tool.
// Lives in the mr-pauls-classroom project. Every tool's server asks it "may this visitor use me?"
//
// Members (logged in on nusparklearnwow.com) arrive with a signed pass from the WordPress plugin.
// Visitors without a pass get a few tries, then see the Join screen.
//
// Vercel settings (Environment Variables) for THIS project only:
//   LW_PASS_SECRET      required to switch the gate ON (same secret as the WordPress plugin). Not set = gate OFF, everything allowed.
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_URL / KV_REST_API_TOKEN)  the counter database
//   LW_FREE_TRIES       visitor tries across all tools (default 3). 0 = preview only (no tries).
//   LW_WINDOW_MIN       minutes one try lasts inside one tool (default 15)
//   LW_WINDOW_CALLS     max calls inside one try (default 120)
//   LW_BG_DAILY         background calls a visitor may make per day without a try, e.g. starter ideas on page load (default 40)
//   LW_MEMBER_MONTHLY   calls per member per month (default 2500)
//   LW_MEMBER_DAILY     calls per member per day (default 400)

const crypto = require("crypto");

const num = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : d; };
const SECRET = process.env.LW_PASS_SECRET || "";
const RURL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || "";
const RTOK = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || "";
const FREE_TRIES = num(process.env.LW_FREE_TRIES, 3);
const WINDOW_SEC = num(process.env.LW_WINDOW_MIN, 15) * 60;
const WINDOW_CALLS = num(process.env.LW_WINDOW_CALLS, 120);
const BG_DAILY = num(process.env.LW_BG_DAILY, 40);
const MEMBER_MONTHLY = num(process.env.LW_MEMBER_MONTHLY, 2500);
const MEMBER_DAILY = num(process.env.LW_MEMBER_DAILY, 400);

function b64urlToBuf(s) { s = String(s).replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; return Buffer.from(s, "base64"); }

// Pass format: base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload part, secret))
function readPass(pass) {
  if (!pass || !SECRET || typeof pass !== "string" || pass.length > 600) return null;
  const [p, sig] = pass.split(".");
  if (!p || !sig) return null;
  const want = crypto.createHmac("sha256", SECRET).update(p).digest();
  const got = b64urlToBuf(sig);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  try {
    const data = JSON.parse(b64urlToBuf(p).toString("utf8"));
    if (!data || !data.m || !data.exp || data.exp * 1000 < Date.now()) return null;
    return data;
  } catch (e) { return null; }
}

async function redis(cmds) {
  if (!RURL || !RTOK) return null;
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 2000);
  try {
    const r = await fetch(RURL.replace(/\/$/, "") + "/pipeline", {
      method: "POST", headers: { Authorization: "Bearer " + RTOK, "Content-Type": "application/json" },
      body: JSON.stringify(cmds), signal: ctl.signal
    });
    if (!r.ok) return null;
    const out = await r.json();
    return out.map(x => (x && "result" in x ? x.result : null));
  } catch (e) { return null; } finally { clearTimeout(t); }
}

const h = s => crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 24);
const clean = s => String(s || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 60);

// Decide one call. Returns { ok, who, reason?, left? }
async function decide({ pass, vid, ip, tool, act }) {
  if (!SECRET) return { ok: true, who: "off" };
  tool = clean(tool) || "tool";
  const now = new Date();
  const day = now.toISOString().slice(0, 10), month = day.slice(0, 7);

  const member = readPass(pass);
  if (member) {
    const id = clean(member.m);
    const kM = `lw:m:${id}:${month}`, kD = `lw:m:${id}:${day}`;
    const r = await redis([["INCR", kM], ["EXPIRE", kM, 40 * 86400], ["INCR", kD], ["EXPIRE", kD, 2 * 86400]]);
    if (!r) return { ok: true, who: "member" };
    if (r[0] > MEMBER_MONTHLY || r[2] > MEMBER_DAILY) return { ok: false, who: "member", reason: "budget" };
    return { ok: true, who: "member" };
  }

  // Visitor (no pass)
  if (FREE_TRIES === 0) return { ok: false, who: "visitor", reason: "preview", left: 0 };
  const v = clean(vid) || "none", ipk = h(ip || "noip");
  const kWin = `lw:v:${v}:${ipk}:win:${tool}`;
  const kTriesV = `lw:v:${v}:tries`, kTriesIp = `lw:ip:${ipk}:tries`;
  const kBg = `lw:bg:${ipk}:${day}`;
  const first = await redis([["GET", kWin], ["GET", kTriesV], ["GET", kTriesIp]]);
  if (!first) return { ok: true, who: "visitor" }; // database unreachable: let it through
  const win = parseInt(first[0] || "0", 10);
  const triesV = parseInt(first[1] || "0", 10), triesIp = parseInt(first[2] || "0", 10);

  // Inside an open try for this tool: allowed, up to the call cap.
  if (win > 0) {
    if (win >= WINDOW_CALLS) return { ok: false, who: "visitor", reason: "tries", left: 0 };
    await redis([["INCR", kWin]]);
    return { ok: true, who: "visitor", left: Math.max(0, FREE_TRIES - triesV) };
  }

  // Not a click (e.g. starter ideas loading with the page): small daily allowance, no try used.
  if (!act) {
    const bg = await redis([["INCR", kBg], ["EXPIRE", kBg, 2 * 86400]]);
    if (bg && bg[0] > BG_DAILY) return { ok: false, who: "visitor", reason: "tries", left: Math.max(0, FREE_TRIES - triesV) };
    return { ok: true, who: "visitor", left: Math.max(0, FREE_TRIES - triesV) };
  }

  // A click that starts a new try. Shared networks (schools, offices) get a roomier limit per IP.
  if (triesV >= FREE_TRIES || triesIp >= FREE_TRIES * 4) return { ok: false, who: "visitor", reason: "tries", left: 0 };
  await redis([
    ["INCR", kTriesV], ["EXPIRE", kTriesV, 30 * 86400],
    ["INCR", kTriesIp], ["EXPIRE", kTriesIp, 30 * 86400],
    ["SET", kWin, "1", "EX", WINDOW_SEC]
  ]);
  return { ok: true, who: "visitor", left: Math.max(0, FREE_TRIES - triesV - 1) };
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") { res.statusCode = 200; res.setHeader("Content-Type", "application/json"); return res.end(JSON.stringify({ ok: true, gate: SECRET ? "on" : "off", database: !!(RURL && RTOK), tries: FREE_TRIES })); }
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};
  let out;
  try { out = await decide(body); } catch (e) { out = { ok: true, who: "error" }; }
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(out));
};
module.exports.decide = decide;
module.exports.readPass = readPass;
