// @inkress/apps-core/channel
// ───────────────────────────────────────────────────────────────────────────
// Permissioned inter-app messaging with attribution (the "cross-app channel").
//
// Marketplace apps run in separate containers but share the `bookerva_apps`
// Postgres. This module is the shared message bus: a SENDER app enqueues a
// message addressed to a VIA app (a hub that owns a delivery channel — e.g. the
// Central WhatsApp hub owns `whatsapp`). The hub claims queued messages it is
// permitted to deliver (per a per-merchant GRANT), sends them, and stamps
// ATTRIBUTION so the merchant always sees which app originated each message.
//
// Permission model: nothing flows unless the merchant has granted
// (merchant_id, from_app → via_app, channel). A revoked grant immediately stops
// that sender's queue (the claim query joins on enabled grants), so a merchant
// can cut off one app without touching the others.
import { openPg } from "./pgdb.mjs";

let _db = null;
async function db() {
  if (_db) return _db;
  _db = await openPg("app_channel", `
    CREATE TABLE IF NOT EXISTS channel_grants (
      id BIGSERIAL PRIMARY KEY, merchant_id BIGINT NOT NULL,
      from_app TEXT NOT NULL, via_app TEXT NOT NULL, channel TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT true, label TEXT, granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (merchant_id, from_app, via_app, channel)
    );
    CREATE TABLE IF NOT EXISTS channel_outbox (
      id BIGSERIAL PRIMARY KEY, merchant_id BIGINT NOT NULL,
      from_app TEXT NOT NULL, via_app TEXT NOT NULL, channel TEXT NOT NULL,
      to_addr TEXT, body TEXT, meta JSONB NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'queued', attribution TEXT, error TEXT, ext_id TEXT,
      claimed_at TIMESTAMPTZ, sent_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_ch_outbox_claim ON channel_outbox (via_app, channel, status, id);
    CREATE INDEX IF NOT EXISTS idx_ch_outbox_merchant ON channel_outbox (merchant_id, created_at DESC);
    ALTER TABLE channel_grants ADD COLUMN IF NOT EXISTS requested_at TIMESTAMPTZ;
    ALTER TABLE channel_grants ADD COLUMN IF NOT EXISTS dismissed BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE channel_grants ADD COLUMN IF NOT EXISTS reason TEXT;
  `);
  return _db;
}

/** Ensure the channel tables exist (call once at boot if you want eager setup). */
export async function initChannel() { await db(); }

/**
 * Sender side — enqueue a message for `viaApp` to deliver over `channel`.
 * Returns { id, status, allowed }. `status` is 'queued' when an enabled grant
 * exists, otherwise 'blocked' (the row is still recorded for the audit trail and
 * so the hub can surface a pending-permission request to the merchant).
 */
export async function enqueue({ merchantId, fromApp, viaApp, channel, to, body, meta }) {
  if (!merchantId || !fromApp || !viaApp || !channel) throw new Error("enqueue: merchantId, fromApp, viaApp, channel required");
  const d = await db();
  const grant = await d.one(`SELECT enabled FROM channel_grants WHERE merchant_id=$1 AND from_app=$2 AND via_app=$3 AND channel=$4`,
    [merchantId, fromApp, viaApp, channel]).catch(() => null);
  const allowed = grant ? grant.enabled === true : false;
  // A blocked send auto-registers a pending access request the merchant can
  // approve in the hub (unless they've already dismissed it).
  if (!allowed) await registerRequest(d, { merchantId, fromApp, viaApp, channel });
  const row = await d.one(`INSERT INTO channel_outbox (merchant_id, from_app, via_app, channel, to_addr, body, meta, status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, status`,
    [merchantId, fromApp, viaApp, channel, to || null, body || null, JSON.stringify(meta || {}), allowed ? "queued" : "blocked"]);
  return { id: Number(row.id), status: row.status, allowed };
}

async function registerRequest(d, { merchantId, fromApp, viaApp, channel, label, reason }) {
  await d.run(`INSERT INTO channel_grants (merchant_id, from_app, via_app, channel, enabled, label, reason, requested_at, granted_at)
      VALUES ($1,$2,$3,$4,false,$5,$6,now(),now())
      ON CONFLICT (merchant_id, from_app, via_app, channel) DO UPDATE
        SET requested_at = CASE WHEN channel_grants.enabled THEN channel_grants.requested_at ELSE COALESCE(channel_grants.requested_at, now()) END,
            label = COALESCE($5, channel_grants.label), reason = COALESCE($6, channel_grants.reason)`,
    [merchantId, fromApp, viaApp, channel, label || null, reason || null]).catch(() => {});
}

/**
 * Sender side — explicitly ask the merchant for permission to send via `viaApp`
 * over `channel` (so an app can request access up-front, before its first send,
 * with a human-readable label + reason). Surfaces in the hub as a pending request.
 */
export async function requestAccess({ merchantId, fromApp, viaApp, channel, label, reason }) {
  if (!merchantId || !fromApp || !viaApp || !channel) throw new Error("requestAccess: merchantId, fromApp, viaApp, channel required");
  const d = await db();
  await registerRequest(d, { merchantId, fromApp, viaApp, channel, label, reason });
  const g = await d.one(`SELECT enabled FROM channel_grants WHERE merchant_id=$1 AND from_app=$2 AND via_app=$3 AND channel=$4`, [merchantId, fromApp, viaApp, channel]).catch(() => null);
  return { status: g?.enabled ? "granted" : "pending" };
}

/** Hub side — apps that have requested (or attempted) access but aren't granted yet. */
export async function pendingRequests(merchantId, viaApp) {
  const d = await db();
  return d.q(`SELECT g.from_app, g.label, g.reason, g.requested_at,
      (SELECT COUNT(*)::int FROM channel_outbox o WHERE o.merchant_id=g.merchant_id AND o.from_app=g.from_app AND o.via_app=g.via_app AND o.channel=g.channel AND o.status='blocked') AS attempts
    FROM channel_grants g
    WHERE g.merchant_id=$1 AND g.via_app=$2 AND g.enabled=false AND g.dismissed=false AND g.requested_at IS NOT NULL
    ORDER BY g.requested_at DESC`, [merchantId, viaApp]);
}
/** Hub side — dismiss a pending request without granting (the app stays blocked but stops nagging). */
export async function dismissRequest({ merchantId, fromApp, viaApp, channel }) {
  const d = await db();
  await d.run(`UPDATE channel_grants SET dismissed=true WHERE merchant_id=$1 AND from_app=$2 AND via_app=$3 AND channel=$4`, [merchantId, fromApp, viaApp, channel]);
}

/**
 * Hub side — atomically claim up to `limit` queued messages for this
 * via_app+channel that have an ENABLED grant. Returns the claimed rows; deliver
 * them then call markSent/markFailed for each.
 */
export async function claim({ viaApp, channel, limit = 20 }) {
  const d = await db();
  return d.q(`
    UPDATE channel_outbox o SET status='claimed', claimed_at=now()
    WHERE o.id IN (
      SELECT o2.id FROM channel_outbox o2
      JOIN channel_grants g
        ON g.merchant_id=o2.merchant_id AND g.from_app=o2.from_app AND g.via_app=o2.via_app AND g.channel=o2.channel AND g.enabled=true
      WHERE o2.via_app=$1 AND o2.channel=$2 AND o2.status='queued'
      ORDER BY o2.id LIMIT $3
    ) RETURNING *`, [viaApp, channel, limit]);
}
export async function markSent(id, attribution, extId) {
  const d = await db();
  await d.run(`UPDATE channel_outbox SET status='sent', sent_at=now(), attribution=$2, ext_id=$3 WHERE id=$1`, [id, attribution || null, extId || null]);
}
export async function markFailed(id, error) {
  const d = await db();
  await d.run(`UPDATE channel_outbox SET status='failed', error=$2 WHERE id=$1`, [id, String(error || "").slice(0, 300)]);
}
/** Re-queue claimed-but-stuck messages (older than `staleSeconds`) — call before claim to self-heal a crashed hub. */
export async function requeueStale({ viaApp, channel, staleSeconds = 600 }) {
  const d = await db();
  await d.run(`UPDATE channel_outbox SET status='queued', claimed_at=NULL WHERE via_app=$1 AND channel=$2 AND status='claimed' AND claimed_at < now() - ($3 || ' seconds')::interval`, [viaApp, channel, String(staleSeconds)]);
}

/* ---- grants (hub UI) ---- */
export async function listGrants(merchantId, viaApp) {
  const d = await db();
  return d.q(`SELECT * FROM channel_grants WHERE merchant_id=$1 AND via_app=$2 ORDER BY from_app`, [merchantId, viaApp]);
}
export async function setGrant({ merchantId, fromApp, viaApp, channel, enabled, label }) {
  const d = await db();
  const on = enabled !== false;
  // Approving clears any pending-request / dismissed state.
  return d.one(`INSERT INTO channel_grants (merchant_id, from_app, via_app, channel, enabled, label) VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (merchant_id, from_app, via_app, channel) DO UPDATE
      SET enabled=$5, label=COALESCE($6, channel_grants.label),
          dismissed = CASE WHEN $5 THEN false ELSE channel_grants.dismissed END,
          requested_at = CASE WHEN $5 THEN NULL ELSE channel_grants.requested_at END RETURNING *`,
    [merchantId, fromApp, viaApp, channel, on, label || null]);
}

/* ---- message log + stats (attribution view) ---- */
export async function recentMessages(merchantId, viaApp, limit = 100) {
  const d = await db();
  return d.q(`SELECT * FROM channel_outbox WHERE merchant_id=$1 AND via_app=$2 ORDER BY id DESC LIMIT $3`, [merchantId, viaApp, limit]);
}
export async function channelStats(merchantId, viaApp) {
  const d = await db();
  const rows = await d.q(`SELECT from_app, status, COUNT(*)::int AS n FROM channel_outbox WHERE merchant_id=$1 AND via_app=$2 GROUP BY from_app, status`, [merchantId, viaApp]);
  const byApp = {}; let sent = 0, blocked = 0, queued = 0, failed = 0;
  for (const r of rows) {
    byApp[r.from_app] = byApp[r.from_app] || { from_app: r.from_app, sent: 0, queued: 0, blocked: 0, failed: 0 };
    if (byApp[r.from_app][r.status] != null) byApp[r.from_app][r.status] += r.n;
    if (r.status === "sent") sent += r.n; else if (r.status === "blocked") blocked += r.n; else if (r.status === "queued" || r.status === "claimed") queued += r.n; else if (r.status === "failed") failed += r.n;
  }
  return { sent, queued, blocked, failed, by_app: Object.values(byApp) };
}
