/**
 * Membership / Dues — backend.
 *
 * Self-contained: tracks the merchant's members + dues plans in its own
 * Postgres schema (membership), computes who is current vs behind, records
 * payments, and can match paid Inkress orders (orders:read) to a member to
 * auto-record dues. The Inkress access token never leaves this server.
 *
 *   GET  /api/overview          plans + KPIs (members, current, behind, collected)
 *   GET/POST /api/plans         dues plans (name, amount, period)
 *   GET  /api/members?status=   roster (current/behind)
 *   POST /api/members           add a member
 *   POST /api/members/:id/pay   record a dues payment → advance paid_through
 *   POST /api/sync              match recent paid orders to members by contact
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { mountAppCore } from "@inkress/apps-core";
import { openPg } from "@inkress/apps-core/pgdb";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";

for (const k of ["OAUTH_CLIENT_ID", "OAUTH_CLIENT_SECRET", "INKRESS_API_BASE"]) {
  if (!process.env[k]) {
    console.error(`[membership] Missing env: ${k}`);
    process.exit(1);
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS plans (
  id          bigserial PRIMARY KEY,
  merchant_id bigint NOT NULL,
  name        text   NOT NULL,
  amount      numeric NOT NULL DEFAULT 0,
  period      text   NOT NULL DEFAULT 'month',
  enabled     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS members (
  id           bigserial PRIMARY KEY,
  merchant_id  bigint NOT NULL,
  plan_id      bigint,
  name         text NOT NULL,
  contact      text,
  customer_ref text,
  paid_through date,
  joined_at    timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS payments (
  id          bigserial PRIMARY KEY,
  merchant_id bigint NOT NULL,
  member_id   bigint NOT NULL,
  amount      numeric NOT NULL,
  periods     integer NOT NULL DEFAULT 1,
  order_ref   text,
  note        text,
  paid_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS synced_orders (
  merchant_id bigint NOT NULL,
  order_ref   text NOT NULL,
  PRIMARY KEY (merchant_id, order_ref)
);
CREATE INDEX IF NOT EXISTS members_merchant_idx ON members (merchant_id);
`;

const app = express();
const core = mountAppCore(app, {
  clientId: process.env.OAUTH_CLIENT_ID,
  clientSecret: process.env.OAUTH_CLIENT_SECRET,
  apiBaseUrl: process.env.INKRESS_API_BASE,
  frameAncestors: process.env.FRAME_ANCESTORS,
  staticDir: path.join(__dirname, "dist"),
});
app.use(express.json());
const db = await openPg("membership", SCHEMA);

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
};
const int = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : d;
};
const UNIT = { week: "weeks", month: "months", year: "years" };
// Postgres interval string for N periods of a plan, e.g. (month,3) → "3 months".
const intervalFor = (period, n) => `${Math.max(1, n)} ${UNIT[period] || "months"}`;

// Inkress order status codes: 3=paid, 4=confirmed, 9=completed.
const PAID = new Set([3, 4, 9]);
const isPaid = (o) => PAID.has(Number(o.status));
const custName = (c) =>
  [c?.first_name, c?.last_name].filter(Boolean).join(" ") || c?.username || c?.email || "Member";

app.get("/api/overview", core.requireSession, async (req, res) => {
  try {
    const mid = req.session.merchantId;
    const plans = await db.q("SELECT * FROM plans WHERE merchant_id=$1 ORDER BY created_at", [mid]);
    const stats = await db.one(
      `SELECT
         (SELECT count(*) FROM members WHERE merchant_id=$1) AS members,
         (SELECT count(*) FROM members WHERE merchant_id=$1 AND paid_through >= current_date) AS current,
         (SELECT count(*) FROM members WHERE merchant_id=$1 AND (paid_through IS NULL OR paid_through < current_date)) AS behind,
         (SELECT coalesce(sum(amount),0) FROM payments WHERE merchant_id=$1 AND paid_at > now() - interval '30 days') AS collected_30d`,
      [mid],
    );
    res.json({ plans, stats });
  } catch (err) {
    res.status(500).json({ error: "overview_failed", message: err?.message });
  }
});

app.get("/api/plans", core.requireSession, async (req, res) => {
  res.json({ plans: await db.q("SELECT * FROM plans WHERE merchant_id=$1 ORDER BY created_at", [req.session.merchantId]) });
});

app.post("/api/plans", core.requireSession, async (req, res) => {
  const mid = req.session.merchantId;
  const b = req.body || {};
  const period = ["week", "month", "year"].includes(b.period) ? b.period : "month";
  const name = String(b.name || "Membership").slice(0, 80);
  if (b.id) {
    await db.run("UPDATE plans SET name=$2, amount=$3, period=$4, enabled=$5 WHERE id=$1 AND merchant_id=$6", [
      int(b.id, 0), name, num(b.amount, 0), period, b.enabled !== false, mid,
    ]);
  } else {
    await db.run("INSERT INTO plans (merchant_id, name, amount, period, enabled) VALUES ($1,$2,$3,$4,$5)", [
      mid, name, num(b.amount, 0), period, b.enabled !== false,
    ]);
  }
  res.json({ plans: await db.q("SELECT * FROM plans WHERE merchant_id=$1 ORDER BY created_at", [mid]) });
});

app.get("/api/members", core.requireSession, async (req, res) => {
  const mid = req.session.merchantId;
  const status = (req.query.status || "").toString();
  let where = "m.merchant_id=$1";
  if (status === "current") where += " AND m.paid_through >= current_date";
  else if (status === "behind") where += " AND (m.paid_through IS NULL OR m.paid_through < current_date)";
  const rows = await db.q(
    `SELECT m.*, p.name AS plan_name, p.amount AS plan_amount, p.period AS plan_period,
            (m.paid_through >= current_date) AS is_current
       FROM members m LEFT JOIN plans p ON p.id = m.plan_id
      WHERE ${where}
      ORDER BY (m.paid_through IS NULL OR m.paid_through < current_date) DESC, m.name LIMIT 300`,
    [mid],
  );
  res.json({ members: rows });
});

app.post("/api/members", core.requireSession, async (req, res) => {
  const mid = req.session.merchantId;
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: "name required" });
  const contact = b.contact ? String(b.contact).slice(0, 120) : null;
  const row = await db.one(
    "INSERT INTO members (merchant_id, plan_id, name, contact, customer_ref) VALUES ($1,$2,$3,$4,$4) RETURNING *",
    [mid, b.plan_id ? int(b.plan_id, null) : null, String(b.name).slice(0, 120), contact],
  );
  res.json({ member: row });
});

app.post("/api/members/:id/pay", core.requireSession, async (req, res) => {
  const mid = req.session.merchantId;
  const id = int(req.params.id, 0);
  const periods = Math.max(1, int(req.body?.periods, 1));
  try {
    const out = await db.tx(async (cx) => {
      const m = (
        await cx.query(
          `SELECT m.*, p.amount AS plan_amount, p.period AS plan_period
             FROM members m LEFT JOIN plans p ON p.id=m.plan_id
            WHERE m.id=$1 AND m.merchant_id=$2 FOR UPDATE`,
          [id, mid],
        )
      ).rows[0];
      if (!m) throw new Error("not_found");
      const iv = intervalFor(m.plan_period, periods);
      const amount = num(req.body?.amount, Number(m.plan_amount || 0) * periods);
      await cx.query(
        `UPDATE members SET paid_through =
           (GREATEST(COALESCE(paid_through, current_date), current_date) + $2::interval)::date WHERE id=$1`,
        [id, iv],
      );
      await cx.query(
        "INSERT INTO payments (merchant_id, member_id, amount, periods, note) VALUES ($1,$2,$3,$4,$5)",
        [mid, id, amount, periods, req.body?.note || null],
      );
      return (await cx.query("SELECT paid_through FROM members WHERE id=$1", [id])).rows[0];
    });
    res.json({ ok: true, paid_through: out.paid_through });
  } catch (e) {
    res.status(e.message === "not_found" ? 404 : 422).json({ error: e.message === "not_found" ? "Member not found" : "Payment failed" });
  }
});

// Enrol members from paid orders (find-or-create by contact) and record the
// order as a dues payment, advancing paid_through. Populates the roster from
// the merchant's real customers.
app.post("/api/sync", core.requireSession, async (req, res) => {
  try {
    const mid = req.session.merchantId;
    // Ensure a default plan so enrolled members have a billing period.
    let plan = await db.one("SELECT * FROM plans WHERE merchant_id=$1 ORDER BY created_at LIMIT 1", [mid]);
    if (!plan) {
      plan = await db.one(
        "INSERT INTO plans (merchant_id, name, amount, period) VALUES ($1,'General membership',0,'month') RETURNING *",
        [mid],
      );
    }
    const r = await core.callInkress(req.session, "orders?limit=200&order=id desc").catch(() => null);
    const orders = r?.result?.entries || r?.result || [];
    let matched = 0;
    let enrolled = 0;
    for (const o of orders) {
      if (!isPaid(o)) continue;
      const ref = String(o.id ?? o.code ?? "");
      if (!ref) continue;
      const seen = await db.one("SELECT 1 FROM synced_orders WHERE merchant_id=$1 AND order_ref=$2", [mid, ref]);
      if (seen) continue;
      await db.run("INSERT INTO synced_orders (merchant_id, order_ref) VALUES ($1,$2) ON CONFLICT DO NOTHING", [mid, ref]);
      const c = o.customer || {};
      const contact = c.phone || c.email || null;
      if (!contact) continue;
      let member = await db.one(
        "SELECT m.*, p.period AS plan_period FROM members m LEFT JOIN plans p ON p.id=m.plan_id WHERE m.merchant_id=$1 AND m.contact=$2 LIMIT 1",
        [mid, contact],
      );
      if (!member) {
        member = await db.one(
          "INSERT INTO members (merchant_id, plan_id, name, contact, customer_ref) VALUES ($1,$2,$3,$4,$5) RETURNING *",
          [mid, plan.id, custName(c), contact, String(c.id ?? "")],
        );
        member.plan_period = plan.period;
        enrolled += 1;
      }
      const iv = intervalFor(member.plan_period, 1);
      await db.tx(async (cx) => {
        await cx.query(
          `UPDATE members SET paid_through = (GREATEST(COALESCE(paid_through, current_date), current_date) + $2::interval)::date WHERE id=$1`,
          [member.id, iv],
        );
        await cx.query(
          "INSERT INTO payments (merchant_id, member_id, amount, periods, order_ref, note) VALUES ($1,$2,$3,1,$4,$5)",
          [mid, member.id, num(o.total ?? o.amount, 0), ref, `Order ${ref}`],
        );
      });
      matched += 1;
    }
    res.json({ matched, enrolled });
  } catch (err) {
    res.status(502).json({ error: "sync_failed", message: err?.message });
  }
});

app.listen(PORT, HOST, () => console.log(`[membership] listening on ${HOST}:${PORT}`));
