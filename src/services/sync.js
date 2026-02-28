/**
 * Route Sync Service
 *
 * Polls Spoke API to catch stops that were missed by webhooks, added later,
 * or updated after initial import.
 *
 * PLAN DISCOVERY:
 *   1. tracked_plans table — populated automatically by webhooks and manually via dashboard
 *   2. Existing notification spoke_stop_ids — extract plan IDs as fallback
 *
 * SCHEDULE:
 *   8 AM – 4 PM EST: every 15 minutes
 *   4 PM – 6 PM EST: every 5 minutes (crunch time before 6 PM send)
 *   Only on send days (Mon–Fri)
 *
 * SCOPE: Only syncs stops for the next delivery day
 */

const db = require("../database");
const fetch = require("node-fetch");
const { computeDeliveryWindow, isDeliveryDay, isSendDay } = require("./templates");

const SPOKE_API_BASE = "https://api.getcircuit.com/public/v0.2b";
const SYNC_INTERVAL_MS = 60 * 1000; // check every minute, decide frequency inside

const SALE_PREFIX_TO_STORE = {
  "1": "other",
  "2": "lexington",
  "3": "georgetown",
  "4": "somerset",
  "5": "london",
};

const STORE_DISPLAY_NAMES = {
  somerset: "Mattress Overstock - Somerset",
  lexington: "Mattress Overstock - Nicholasville Road",
  london: "Mattress Overstock - London",
  georgetown: "Mattress Overstock - Georgetown",
  other: "Mattress Overstock",
};

function resolveStoreFromSaleNumber(saleNumber) {
  if (!saleNumber) return "unknown";
  const prefix = String(saleNumber).charAt(0);
  return SALE_PREFIX_TO_STORE[prefix] || "unknown";
}

function extractSaleNumber(customProperties) {
  if (!customProperties || typeof customProperties !== "object") return null;
  const byName =
    customProperties["Sale Number"] ||
    customProperties["sale_number"] ||
    customProperties["saleNumber"] ||
    customProperties["Sale number"] ||
    customProperties["sale number"] ||
    null;
  if (byName) return byName;
  const values = Object.values(customProperties);
  if (values.length > 0 && values[0]) return values[0];
  return null;
}

function cleanPhone(phone) {
  if (!phone) return "";
  let cleaned = phone.replace(/[^\d+]/g, "");
  if (cleaned.length === 10) cleaned = "+1" + cleaned;
  if (cleaned.length === 11 && cleaned.startsWith("1")) cleaned = "+" + cleaned;
  return cleaned;
}

function logActivity(type, detail, notificationId = null) {
  db.prepare("INSERT INTO activity_log (type, detail, notification_id, created_at) VALUES (?, ?, ?, ?)").run(
    type, detail, notificationId, new Date().toISOString()
  );
}

function getESTNow() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
}

function parseDateFromRouteTitle(title) {
  if (!title) return null;
  try {
    const match = title.match(/(\w+),\s+(\w+)\s+(\d+)/);
    if (match) {
      const months = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 };
      const month = months[match[2]];
      if (month !== undefined) {
        const day = parseInt(match[3], 10);
        const year = new Date().getFullYear();
        const date = new Date(year, month, day);
        return date.toISOString().split("T")[0];
      }
    }
  } catch (e) {}
  return null;
}

// ─── Spoke API ───────────────────────────────────────────

async function spokeGet(path) {
  const apiKey = process.env.SPOKE_API_KEY;
  if (!apiKey) {
    console.log("[Sync] No SPOKE_API_KEY set");
    return null;
  }
  const url = path.startsWith("http") ? path : `${SPOKE_API_BASE}/${path}`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    });
    if (!res.ok) {
      console.error("[Sync] API error:", res.status, res.statusText, "for", path);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error("[Sync] Fetch error:", err.message);
    return null;
  }
}

// ─── Plan Discovery ──────────────────────────────────────

function getTrackedPlanIds(deliveryDate) {
  const planIds = new Set();

  // 1. From tracked_plans table
  const tracked = db.prepare(
    "SELECT plan_id FROM tracked_plans WHERE delivery_date = ?"
  ).all(deliveryDate);
  for (const row of tracked) {
    planIds.add(row.plan_id);
  }

  // 2. Extract from existing notifications as fallback
  const notifs = db.prepare(
    "SELECT DISTINCT spoke_stop_id FROM notifications WHERE scheduled_date = ? AND spoke_stop_id IS NOT NULL"
  ).all(deliveryDate);
  for (const row of notifs) {
    const match = row.spoke_stop_id.match(/^(plans\/[^/]+)/);
    if (match) planIds.add(match[1]);
  }

  return [...planIds];
}

// ─── Main Sync ───────────────────────────────────────────

async function syncRoutes(targetDate) {
  const now = getESTNow();

  // Default: sync for next delivery day (tomorrow on Mon-Fri)
  let deliveryDate = targetDate;
  if (!deliveryDate) {
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    deliveryDate = tomorrow.toISOString().split("T")[0];
  }

  // Validate it's a delivery day
  const deliveryDateObj = new Date(deliveryDate + "T12:00:00");
  if (!isDeliveryDay(deliveryDateObj)) {
    console.log(`[Sync] ${deliveryDate} is not a delivery day — skipping`);
    return { newStops: 0, updated: 0, removed: 0, skipped: 0, errors: [] };
  }

  console.log("\n[Sync] ═══════════════════════════════════════");
  console.log(`[Sync] Route sync at ${now.toLocaleTimeString()}`);
  console.log(`[Sync] Delivery date: ${deliveryDate}`);

  const results = { newStops: 0, updated: 0, removed: 0, skipped: 0, errors: [] };

  try {
    const planIds = getTrackedPlanIds(deliveryDate);
    console.log(`[Sync] Tracking ${planIds.length} plan(s):`, planIds);

    if (planIds.length === 0) {
      console.log("[Sync] No tracked plans for this date");
      console.log("[Sync] ═══════════════════════════════════════\n");
      return results;
    }

    const allSpokeStopIds = new Set();

    for (const planId of planIds) {
      console.log(`[Sync] Fetching: ${planId}`);

      // Get plan details
      const planDetails = await spokeGet(planId);
      if (!planDetails) {
        console.log(`[Sync] Could not fetch plan ${planId}`);
        results.errors.push(`Failed to fetch ${planId}`);
        continue;
      }

      // Build driver lookup
      const driverMap = {};
      const routes = planDetails.routes || [];
      for (const route of routes) {
        const routeId = route.id || route;
        if (route.driver) {
          if (typeof route.driver === "string" && route.driver.startsWith("drivers/")) {
            const driverData = await spokeGet(route.driver);
            if (driverData) driverMap[routeId] = driverData.displayName || driverData.name || "Your driver";
          } else if (typeof route.driver === "object") {
            driverMap[routeId] = route.driver.displayName || route.driver.name || "Your driver";
          }
        }
      }

      // Get all stops
      const stopsRes = await spokeGet(`${planId}/stops`);
      const stops = Array.isArray(stopsRes) ? stopsRes : (stopsRes?.stops || []);
      console.log(`[Sync] Plan has ${stops.length} stop(s)`);

      for (const stop of stops) {
        if (stop.type === "start" || stop.type === "end") continue;
        if (stop.id) allSpokeStopIds.add(stop.id);

        try {
          const result = await processStopForSync(stop, planDetails, driverMap, deliveryDate);
          if (result === "new") results.newStops++;
          else if (result === "updated") results.updated++;
          else results.skipped++;
        } catch (err) {
          console.error(`[Sync] Stop error:`, err.message);
          results.errors.push(err.message);
        }
      }
    }

    // ─── Detect removed stops ───
    if (allSpokeStopIds.size > 0) {
      const dbNotifs = db.prepare(
        `SELECT id, customer_name, spoke_stop_id, status FROM notifications
         WHERE scheduled_date = ? AND spoke_stop_id IS NOT NULL AND status IN ('pending', 'sent')`
      ).all(deliveryDate);

      for (const n of dbNotifs) {
        if (!allSpokeStopIds.has(n.spoke_stop_id)) {
          db.prepare("UPDATE notifications SET status = 'cancelled', updated_at = ? WHERE id = ?")
            .run(new Date().toISOString(), n.id);
          console.log(`[Sync] ✗ Cancelled: ${n.customer_name} (removed from Spoke)`);
          logActivity("stop_removed", `Sync: ${n.customer_name} removed from route`, n.id);
          results.removed++;
        }
      }
    }

  } catch (err) {
    console.error("[Sync] Fatal error:", err.message);
    results.errors.push(err.message);
  }

  const summary = `Sync: ${results.newStops} new, ${results.updated} updated, ${results.removed} removed`;
  console.log(`[Sync] ${summary}`);
  console.log("[Sync] ═══════════════════════════════════════\n");

  if (results.newStops > 0 || results.updated > 0 || results.removed > 0) {
    logActivity("route_sync", summary);
  }

  return results;
}

async function processStopForSync(stop, planDetails, driverMap, deliveryDate) {
  const stopId = stop.id || null;
  if (!stopId) return "skipped";

  // Fetch full stop details (list endpoint may strip PII)
  let fullStop = stop;
  const recipient = stop.recipient || {};
  if (!recipient.phone && !recipient.phoneNumber) {
    fullStop = await spokeGet(stopId) || stop;
  }

  const r = fullStop.recipient || {};
  const phone = r.phone || r.phoneNumber || r.mobile || null;
  const name = r.name || r.displayName || `${r.firstName || ""} ${r.lastName || ""}`.trim() || "Unknown Customer";

  if (!phone) return "skipped";

  const saleNumber = extractSaleNumber(fullStop.customProperties || stop.customProperties);
  const store = resolveStoreFromSaleNumber(saleNumber);
  const addr = fullStop.address || stop.address || {};
  const address = addr.addressLineOne || addr.address || "";

  // Time window
  let rawDeliveryTime = null;
  let timeWindow = "TBD";
  const eta = fullStop.eta || stop.eta || {};
  const etaTs = eta.estimatedArrivalAt || eta.estimatedEarliestArrivalAt || null;
  if (etaTs) {
    const etaDate = new Date(etaTs * 1000);
    const estStr = etaDate.toLocaleString("en-US", { timeZone: "America/New_York" });
    const estDate = new Date(estStr);
    const h = estDate.getHours(), m = estDate.getMinutes();
    rawDeliveryTime = `${h}:${String(m).padStart(2, "0")}`;
    const w = computeDeliveryWindow(h * 60 + m);
    timeWindow = w.windowText;
  }

  const product = fullStop.notes || fullStop.orderInfo?.products?.join(", ") || (saleNumber ? `Sale #${saleNumber}` : "") || "";
  const routeRef = stop.route?.id || stop.route || null;
  const driver = (routeRef && driverMap[routeRef]) || "Your driver";

  // Check existing
  const existing = db.prepare("SELECT * FROM notifications WHERE spoke_stop_id = ?").get(stopId);

  if (existing) {
    if (existing.status !== "pending") return "skipped";

    const needsUpdate =
      (!existing.phone && phone) ||
      (existing.customer_name === "Unknown Customer" && name !== "Unknown Customer") ||
      (existing.store === "unknown" && store !== "unknown") ||
      (existing.time_window === "TBD" && timeWindow !== "TBD");

    if (!needsUpdate) return "skipped";

    db.prepare(
      `UPDATE notifications SET customer_name=?, phone=?, store=?, address=?, time_window=?, raw_delivery_time=?, product=?, driver=?, updated_at=? WHERE id=?`
    ).run(
      name !== "Unknown Customer" ? name : existing.customer_name,
      phone ? cleanPhone(phone) : existing.phone,
      store !== "unknown" ? store : existing.store,
      address || existing.address,
      timeWindow !== "TBD" ? timeWindow : existing.time_window,
      rawDeliveryTime || existing.raw_delivery_time,
      product || existing.product,
      driver !== "Your driver" ? driver : existing.driver,
      new Date().toISOString(), existing.id
    );
    console.log(`[Sync] ✓ Updated #${existing.id}: ${name}`);
    logActivity("stop_updated", `Sync updated: ${name}`, existing.id);
    return "updated";
  }

  // New stop
  const result = db.prepare(
    `INSERT INTO notifications
    (customer_name, phone, store, address, scheduled_date, time_window, raw_delivery_time, product, driver, status, spoke_stop_id, spoke_route_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`
  ).run(
    name, cleanPhone(phone), store, address, deliveryDate, timeWindow,
    rawDeliveryTime, product, driver, stopId, routeRef,
    new Date().toISOString(), new Date().toISOString()
  );

  const nid = result.lastInsertRowid;
  logActivity("stop_imported", `Sync imported: ${name} → ${STORE_DISPLAY_NAMES[store] || store} (${timeWindow})`, nid);
  console.log(`[Sync] ✓ New #${nid}: ${name} | ${store} | ${timeWindow}`);
  return "new";
}

// ─── Auto-sync Timer ─────────────────────────────────────

let syncInterval = null;
let lastSyncTime = 0;

function startAutoSync() {
  console.log("[Sync] Auto-sync enabled — 15 min (8-4), 5 min (4-6), Mon–Fri");
  logActivity("sync_started", "Auto-sync initialized");
  syncInterval = setInterval(checkAndSync, SYNC_INTERVAL_MS);
}

async function checkAndSync() {
  const now = getESTNow();
  const hour = now.getHours();
  const day = now.getDay();

  // Only Mon-Fri
  if (day === 0 || day === 6) return;
  // Only 8 AM - 6 PM
  if (hour < 8 || hour >= 18) return;

  // Frequency: every 5 min from 4-6 PM, every 15 min otherwise
  const intervalMs = hour >= 16 ? 5 * 60 * 1000 : 15 * 60 * 1000;
  const elapsed = Date.now() - lastSyncTime;
  if (elapsed < intervalMs) return;

  lastSyncTime = Date.now();
  try {
    await syncRoutes();
  } catch (err) {
    console.error("[Sync] Auto-sync error:", err.message);
  }
}

// ─── Manual plan registration ────────────────────────────

function registerPlan(planId, deliveryDate, label) {
  try {
    db.prepare(
      "INSERT OR REPLACE INTO tracked_plans (plan_id, delivery_date, label, created_at) VALUES (?, ?, ?, ?)"
    ).run(planId, deliveryDate, label || null, new Date().toISOString());
    logActivity("plan_registered", `Manually tracked plan: ${planId} for ${deliveryDate}`);
    return true;
  } catch (e) {
    console.error("[Sync] Failed to register plan:", e.message);
    return false;
  }
}

function getTrackedPlans() {
  return db.prepare("SELECT * FROM tracked_plans ORDER BY delivery_date DESC LIMIT 20").all();
}

module.exports = { syncRoutes, startAutoSync, registerPlan, getTrackedPlans };
