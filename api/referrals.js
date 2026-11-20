// LearnWow Share & Save — referral codes and credits, driven by Stripe webhooks.
//
// What it does
//  1. checkout.session.completed (a new LearnWow member): creates their personal code, e.g. SARAHWOW,
//     on the $5 coupon (first-time customers only) and saves it on their Stripe customer.
//  2. invoice.paid (a real charge, not the $0 trial): if the invoice used a member's code, the member
//     who owns that code earns $5 (once per friend). Credits are applied as Stripe customer balance,
//     at most $25 per calendar month; anything above waits and rolls over to the next month.
//  Every paid invoice also applies any waiting credit for that customer (the rollover).
//
// Vercel settings (Environment Variables) for this project:
//   STRIPE_KEY          Stripe restricted key (see the setup steps Paul was given)
//   STRIPE_REF_WHSEC    signing secret of the Stripe webhook that points here
//   LW_PRICE_ID         LearnWow price (default: price_1UdbTwBWliYeTglIcALzstPH)
//   LW_COUPON           coupon id for the friend's $5 off (default: SHARESAVE5)
//   LW_CREDIT_CENTS     credit per friend in cents (default 500)
//   LW_CAP_CENTS        most credit applied per month in cents (default 2500)
//   LW_NOTIFY_URL       optional: a Zapier or GHL webhook URL that gets new_member / credit_earned events
//   Upstash (already set): KV_REST_API_URL / KV_REST_API_TOKEN

const crypto = require("crypto");

const STRIPE_KEY = process.env.STRIPE_KEY || "";
const WHSEC = process.env.STRIPE_REF_WHSEC || "";
const PRICE_ID = process.env.LW_PRICE_ID || "price_1UdbTwBWliYeTglIcALzstPH";
const COUPON = process.env.LW_COUPON || "SHARESAVE5";
const CREDIT = parseInt(process.env.LW_CREDIT_CENTS || "500", 10);
const CAP = parseInt(process.env.LW_CAP_CENTS || "2500", 10);
const NOTIFY = process.env.LW_NOTIFY_URL || "";
const RURL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || "";
const RTOK = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || "";

// ---------- small helpers ----------
function form(obj, prefix, out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object" && !Array.isArray(v)) form(v, key, out);
    else if (Array.isArray(v)) v.forEach(x => out.push(`${encodeURIComponent(key + "[]")}=${encodeURIComponent(x)}`));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out.join("&");
}
async function stripe(method, path, params) {
  const url = "https://api.stripe.com/v1" + path + (method === "GET" && params ? "?" + form(params) : "");
  const r = await fetch(url, {
    method,
    headers: { Authorization: "Bearer " + STRIPE_KEY, "Content-Type": "application/x-www-form-urlencoded" },
    body: method === "GET" ? undefined : form(params || {})
  });
  const j = await r.json();
  if (!r.ok) { const e = new Error((j.error && j.error.message) || "Stripe error"); e.code = j.error && j.error.code; throw e; }
  return j;
}
async function redis(cmds) {
  if (!RURL || !RTOK) throw new Error("Counter database is not connected");
  const r = await fetch(RURL.replace(/\/$/, "") + "/pipeline", {
    method: "POST", headers: { Authorization: "Bearer " + RTOK, "Content-Type": "application/json" }, body: JSON.stringify(cmds)
  });
  const out = await r.json();
  return out.map(x => (x && "result" in x ? x.result : null));
}
async function notify(payload) {
  if (!NOTIFY) return;
  try { await fetch(NOTIFY, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }); } catch (e) {}
}
function readRaw(req) {
  return new Promise((resolve, reject) => {
    if (typeof req.body === "string") return resolve(req.body);
    if (Buffer.isBuffer(req.body)) return resolve(req.body.toString("utf8"));
    const chunks = [];
    const t = setTimeout(() => chunks.length ? resolve(Buffer.concat(chunks).toString("utf8")) : reject(new Error("no body")), 4000);
    req.on("data", c => chunks.push(c));
    req.on("end", () => { clearTimeout(t); resolve(Buffer.concat(chunks).toString("utf8")); });
    req.on("error", reject);
  });
}
function verify(raw, header) {
  if (!WHSEC || !header) return false;
  const parts = Object.fromEntries(String(header).split(",").map(p => p.split("=")).map(([k, ...v]) => [k, v.join("=")]));
  const t = parts.t, sigs = String(header).split(",").filter(p => p.startsWith("v1=")).map(p => p.slice(3));
  if (!t || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - parseInt(t, 10)) > 600) return false;
  const want = crypto.createHmac("sha256", WHSEC).update(`${t}.${raw}`).digest("hex");
  return sigs.some(s => s.length === want.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(want)));
}
const month = () => new Date().toISOString().slice(0, 7);

// ---------- 1. new member: make their code ----------
function baseFromName(name, email) {
  let first = String(name || "").trim().split(/\s+/)[0] || String(email || "").split("@")[0] || "";
  first = first.normalize("NFD").replace(/[^A-Za-z]/g, "").toUpperCase().slice(0, 10);
  return first.length >= 2 ? first : "MEMBER";
}
async function codeTaken(code) {
  const j = await stripe("GET", "/promotion_codes", { code, limit: 1 });
  return j.data && j.data.length > 0;
}
async function makeCode(customerId, name, email) {
  const cust = await stripe("GET", "/customers/" + customerId);
  if (cust.metadata && cust.metadata.lw_code) return { code: cust.metadata.lw_code, existed: true };
  const base = baseFromName(name || cust.name, email || cust.email);
  // Code pattern: first name + WOW (SARAHWOW). Taken? SARAHWOW2, SARAHWOW3, ...
  let code = base + "WOW";
  for (let n = 2; n < 60 && (await codeTaken(code)); n++) code = base + "WOW" + n;
  await stripe("POST", "/promotion_codes", {
    coupon: COUPON, code,
    restrictions: { first_time_transaction: "true" },
    metadata: { lw_referrer: customerId }
  });
  await stripe("POST", "/customers/" + customerId, { metadata: { lw_code: code } });
  return { code, existed: false };
}
async function isLearnWowSubscription(subId) {
  if (!subId) return false;
  const sub = await stripe("GET", "/subscriptions/" + subId);
  return (sub.items && sub.items.data || []).some(it => it.price && it.price.id === PRICE_ID);
}

// ---------- 2. credits ----------
// Apply waiting credit for one customer, up to the monthly cap. Returns cents applied now.
async function applyBank(customerId) {
  const kBank = `lw:ref:bank:${customerId}`, kApplied = `lw:ref:applied:${customerId}:${month()}`;
  const [bankS, appliedS] = await redis([["GET", kBank], ["GET", kApplied]]);
  const bank = parseInt(bankS || "0", 10), applied = parseInt(appliedS || "0", 10);
  const now = Math.min(bank, Math.max(0, CAP - applied));
  if (now <= 0) return { applied: 0, waiting: bank };
  await stripe("POST", `/customers/${customerId}/balance_transactions`, {
    amount: String(-now), currency: "usd", description: "LearnWow Share & Save credit"
  });
  await redis([["DECRBY", kBank, now], ["INCRBY", kApplied, now], ["EXPIRE", kApplied, 70 * 86400]]);
  return { applied: now, waiting: bank - now };
}
async function promoFromInvoice(invoiceId) {
  const inv = await stripe("GET", "/invoices/" + invoiceId, { expand: ["discounts", "discounts.promotion_code"] });
  const list = []
    .concat(Array.isArray(inv.discounts) ? inv.discounts : [])
    .concat(inv.discount ? [inv.discount] : []);
  for (const d of list) {
    if (!d || typeof d !== "object") continue;
    let pc = d.promotion_code;
    if (typeof pc === "string") pc = await stripe("GET", "/promotion_codes/" + pc);
    if (pc && pc.metadata && pc.metadata.lw_referrer) return { referrer: pc.metadata.lw_referrer, code: pc.code };
  }
  return null;
}

async function handle(event) {
  const o = event.data && event.data.object || {};

  if (event.type === "checkout.session.completed") {
    if (o.mode !== "subscription" || !o.customer) return { skipped: "not a subscription" };
    if (!(await isLearnWowSubscription(o.subscription))) return { skipped: "not LearnWow" };
    const name = (o.customer_details && o.customer_details.name) || "";
    const email = (o.customer_details && o.customer_details.email) || "";
    const r = await makeCode(o.customer, name, email);
    if (!r.existed) await notify({ event: "new_member", email, name, code: r.code });
    return { code: r.code, existed: r.existed };
  }

  if (event.type === "invoice.paid") {
    if (!o.customer || !(o.amount_paid > 0)) return { skipped: "no charge" };
    const out = {};
    // a) did this payment use someone's code? (first real charge of the friend)
    const promo = await promoFromInvoice(o.id);
    if (promo && promo.referrer !== o.customer) {
      const first = await redis([["SET", `lw:ref:credited:${o.customer}`, promo.referrer, "NX"]]);
      if (first[0] === "OK") {
        await redis([["INCRBY", `lw:ref:bank:${promo.referrer}`, CREDIT], ["INCR", `lw:ref:friends:${promo.referrer}`], ["INCRBY", `lw:ref:earned:${promo.referrer}`, CREDIT]]);
        const res = await applyBank(promo.referrer);
        const ref = await stripe("GET", "/customers/" + promo.referrer);
        await notify({
          event: "credit_earned", email: ref.email, name: ref.name, code: promo.code,
          friend_first_name: String(o.customer_name || "").split(/\s+/)[0] || "",
          credit_dollars: CREDIT / 100, applied_dollars: res.applied / 100, waiting_dollars: res.waiting / 100
        });
        out.credited = promo.referrer; out.applied = res.applied; out.waiting = res.waiting;
      } else out.alreadyCredited = true;
    }
    // b) rollover: this customer paid, so apply any credit they still have waiting
    const roll = await applyBank(o.customer);
    if (roll.applied) out.rollover = roll.applied;
    return out;
  }

  return { skipped: event.type };
}

// ---------- 3. Members Area card: "what is my code and how much have I saved?" ----------
async function lookupMember(pass) {
  const { readPass } = require("./gate");
  const who = readPass(pass);
  if (!who) return { status: "no_pass" };
  let customer = null;
  if (who.s && /^sub_/.test(who.s)) {
    try { const sub = await stripe("GET", "/subscriptions/" + who.s); customer = await stripe("GET", "/customers/" + sub.customer); } catch (e) {}
  }
  if (!customer && who.e) {
    const list = await stripe("GET", "/customers", { email: who.e, limit: 10 });
    const all = list.data || [];
    customer = all.find(c => c.metadata && c.metadata.lw_code) || null;
    if (!customer) {
      for (const c of all) {
        const subs = await stripe("GET", "/subscriptions", { customer: c.id, status: "all", limit: 10 });
        if ((subs.data || []).some(sb => ["active", "trialing", "past_due"].includes(sb.status) && (sb.items.data || []).some(it => it.price && it.price.id === PRICE_ID))) { customer = c; break; }
      }
    }
  }
  if (!customer) return { status: "no_billing" };
  let code = customer.metadata && customer.metadata.lw_code;
  if (!code) code = (await makeCode(customer.id, customer.name, customer.email)).code;
  const k = customer.id;
  const [friends, earned, waiting, applied] = await redis([["GET", `lw:ref:friends:${k}`], ["GET", `lw:ref:earned:${k}`], ["GET", `lw:ref:bank:${k}`], ["GET", `lw:ref:applied:${k}:${month()}`]]);
  let signedUp = 0;
  try { const pc = await stripe("GET", "/promotion_codes", { code, limit: 1 }); signedUp = (pc.data && pc.data[0] && pc.data[0].times_redeemed) || 0; } catch (e) {}
  return {
    status: "ok", code,
    friends_signed_up: signedUp,
    friends_paid: parseInt(friends || "0", 10),
    earned_dollars: parseInt(earned || "0", 10) / 100,
    waiting_dollars: parseInt(waiting || "0", 10) / 100,
    applied_this_month_dollars: parseInt(applied || "0", 10) / 100,
    cap_dollars: CAP / 100, credit_dollars: CREDIT / 100
  };
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "GET" && req.query && req.query.me) {
    res.setHeader("Content-Type", "application/json");
    try { const out = await lookupMember(req.headers["x-lw-pass"] || ""); res.statusCode = 200; return res.end(JSON.stringify(out)); }
    catch (e) { res.statusCode = 500; return res.end(JSON.stringify({ status: "error", error: e.message })); }
  }
  if (req.method !== "POST") {
    res.statusCode = 200; res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ ok: true, ready: !!(STRIPE_KEY && WHSEC && RURL && RTOK) }));
  }
  let raw;
  try { raw = await readRaw(req); } catch (e) { res.statusCode = 400; return res.end("bad body"); }
  if (!verify(raw, req.headers["stripe-signature"])) { res.statusCode = 400; return res.end("bad signature"); }
  let event;
  try { event = JSON.parse(raw); } catch (e) { res.statusCode = 400; return res.end("bad json"); }
  try {
    const out = await handle(event);
    res.statusCode = 200; res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ received: true, ...out }));
  } catch (e) {
    // 500 makes Stripe retry later
    res.statusCode = 500; res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: e.message }));
  }
};
module.exports.config = { api: { bodyParser: false } };
module.exports._test = { handle, verify, baseFromName, lookupMember };
