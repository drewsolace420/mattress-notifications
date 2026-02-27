/**
 * Spoke Dispatch Webhook Handler
 *
 * Spoke webhooks strip recipient PII (name, phone, email come as null).
 * So after receiving a webhook, we call the Spoke REST API to fetch
 * the full stop details including recipient info.
 *
 * Spoke REST API: https://api.getcircuit.com/public/v0.2b
 * Auth: Bearer {SPOKE_API_KEY}
 */

const db = require("../database");
const { sendSms } = require("../services/quo");
const { getSmsBody, computeDeliveryWindow, isSendDay, isDeliveryDay } = require("../services/templates");
const fetch = require("node-fetch");

const SPOKE_API_BASE = "https://api.getcircuit.com/public/v0.2b";

const DEPOT_TO_STORE = {
  richmond: "richmond",
  "richmond ky": "richmond",
  somerset: "somerset",
  "somerset ky": "somerset",
  laurel: "laurel",
  "laurel county": "laurel",
  london: "london",
  "london ky": "london",
  winchester: "winchester",
  "winchester ky": "winchester",
};

function resolveStore(depotName) {
  if (!depotName) return "unknown";
  const key = depotName.toLowerCase().trim();
  return DEPOT_TO_STORE[key] || key;
}

/**
 * Fetch a resource from the Spoke REST API
 */
async function spokeApiFetch(resourcePath) {
  const apiKey = process.env.SPOKE_API_KEY;
  if (!apiKey) {
    console.log("[Spoke API] No SPOKE_API_KEY set — cannot fetch");
    return null;
  }

  const url = `${SPOKE_API_BASE}/${resourcePath}`;
  console.log("[Spoke API] Fetching:", url);

  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      console.error("[Spoke API] Error:", res.status, res.statusText);
      const text = await res.text();
      console.error("[Spoke API] Body:", text.substring(0, 500));
      return null;
    }

    const data = await res.json();
    return data;
  } catch (err) {
    console.error("[Spoke API] Fetch error:", err.message);
    return null;
  }
}

/**
 * Main webhook handler
 */
async function handleSpokeWebhook(payload, headers) {
  const results = { processed: 0, skipped: 0, errors: [] };

  // ─── Spoke Webhook Events ───
  if (payload.type && payload.data) {
    console.log("[Spoke] Event type:", payload.type);

    if (payload.type === "stop.allocated") {
      try {
        await processSpokeStop(payload.data);
        results.processed++;
      } catch (err) {
        console.error("[Spoke] Error:", err.message, err.stack);
        results.errors.push({ error: err.message });
      }
    } else {
      console.log("[Spoke] Ignoring event:", payload.type);
      results.skipped++;
    }
    return results;
  }

  // ─── Manual/Test webhook ───
  if (payload.stop) {
    try {
      await processManualStop(payload.stop);
      results.processed++;
    } catch (err) {
      console.error("[Spoke] Error:", err.message, err.stack);
      results.errors.push({ error: err.message });
    }
    return results;
  }

  // ─── Array of stops ───
  if (Array.isArray(payload)) {
    for (const stop of payload) {
      try {
        await processManualStop(stop);
        results.processed++;
      } catch (err) {
        results.errors.push({ error: err.message });
      }
    }
    return results;
  }

  console.log("[Spoke] Unrecognized payload:", JSON.stringify(payload).substring(0, 300));
  results.skipped++;
  return results;
}

/**
 * Process a stop.allocated webhook event.
 *
 * The webhook strips recipient PII, so we fetch full details from the REST API.
 * We use the projected ETA (estimatedArrivalAt) for the time window.
 */
async function processSpokeStop(webhookData) {
  const stopId = webhookData.id; // e.g., "plans/abc123/stops/xyz789"
  console.log("[Spoke] Processing stop.allocated:", stopId);

  // ─── Fetch full stop from REST API (has recipient info) ───
  let fullStop = null;
  if (stopId) {
    fullStop = await spokeApiFetch(stopId);
    if (fullStop) {
      console.log("[Spoke API] Full stop recipient:", JSON.stringify(fullStop.recipient));
      console.log("[Spoke API] Full stop notes:", fullStop.notes);
      console.log("[Spoke API] Full stop customProperties:", JSON.stringify(fullStop.customProperties));
    } else {
      console.log("[Spoke API] Could not fetch full stop — using webhook data only");
    }
  }

  // Merge: prefer REST API data, fall back to webhook data
  const data = fullStop || webhookData;
  const webhookEta = webhookData.eta || {};

  // ─── Customer info ───
  const recipient = data.recipient || {};
  const customerName =
    recipient.name ||
    recipient.displayName ||
    `${recipient.firstName || ""} ${recipient.lastName || ""}`.trim() ||
    "Unknown Customer";

  const phone =
    recipient.phone ||
    recipient.phoneNumber ||
    recipient.mobile ||
    null;

  console.log("[Spoke] Customer:", customerName, "| Phone:", phone);

  if (!phone) {
    console.log("[Spoke] ⚠ No phone number — skipping");
    console.log("[Spoke] Recipient keys:", Object.keys(recipient));
    logActivity("stop_skipped", `No phone for ${customerName} at ${data.address?.addressLineOne || "unknown address"}`);
    return;
  }

  // ─── Address ───
  const addr = data.address || {};
  const address = addr.addressLineOne || addr.address || "";

  // ─── Scheduled date ───
  let scheduledDate = null;

  // Try route title like "Sat, Feb 28 Route"
  const routeData = data.route || webhookData.route || {};
  if (routeData.title) {
    scheduledDate = parseDateFromRouteTitle(routeData.title);
    console.log("[Spoke] Date from route title:", routeData.title, "→", scheduledDate);
  }
  if (!scheduledDate) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    scheduledDate = tomorrow.toISOString().split("T")[0];
  }

  // ─── Delivery time window from ETA ───
  // Spoke provides Unix timestamps (seconds):
  //   estimatedArrivalAt — projected arrival (USE THIS)
  //   estimatedEarliestArrivalAt — earliest possible
  //   estimatedLatestArrivalAt — latest possible
  //
  // We use the projected arrival and round UP to nearest 30 min for the window start.
  let rawDeliveryTime = null;
  let timeWindow = "TBD";

  const etaTimestamp =
    webhookEta.estimatedArrivalAt ||
    webhookEta.estimatedEarliestArrivalAt ||
    data.eta?.estimatedArrivalAt ||
    data.eta?.estimatedEarliestArrivalAt ||
    null;

  if (etaTimestamp) {
    // Convert Unix timestamp to EST time
    const etaDate = new Date(etaTimestamp * 1000);
    const estString = etaDate.toLocaleString("en-US", { timeZone: "America/New_York" });
    const estDate = new Date(estString);
    const hours = estDate.getHours();
    const minutes = estDate.getMinutes();
    const totalMinutes = hours * 60 + minutes;

    rawDeliveryTime = `${hours}:${String(minutes).padStart(2, "0")}`;
    const window = computeDeliveryWindow(totalMinutes);
    timeWindow = window.windowText;
    console.log("[Spoke] ETA timestamp:", etaTimestamp, "→ EST:", rawDeliveryTime, "→ Window:", timeWindow);
  } else {
    // Try timing field
    const timing = data.timing || {};
    if (timing.earliestAttemptTime) {
      const earliest = timing.earliestAttemptTime;
      const totalMinutes = (earliest.hour || 0) * 60 + (earliest.minute || 0);
      rawDeliveryTime = `${earliest.hour}:${String(earliest.minute || 0).padStart(2, "0")}`;
      const window = computeDeliveryWindow(totalMinutes);
      timeWindow = window.windowText;
    }
  }

  console.log("[Spoke] Time window:", timeWindow);

  // ─── Product / notes ───
  const product =
    data.notes ||
    data.orderInfo?.products?.join(", ") ||
    (data.customProperties ? JSON.stringify(data.customProperties) : "") ||
    "";

  // ─── Driver ───
  let driver = "Your driver";
  const driverRef = routeData.driver; // e.g., "drivers/4ccrTaAFAa1wol3twCY5"

  if (typeof driverRef === "string" && driverRef.startsWith("drivers/")) {
    const driverData = await spokeApiFetch(driverRef);
    if (driverData) {
      driver = driverData.displayName || driverData.name || "Your driver";
      console.log("[Spoke] Driver:", driver);
    }
  } else if (typeof driverRef === "object" && driverRef) {
    driver = driverRef.displayName || driverRef.name || "Your driver";
  }

  // ─── Store/depot ───
  let store = "unknown";

  // Try depot from webAppLink
  if (webhookData.webAppLink) {
    const depotMatch = webhookData.webAppLink.match(/depotId=([^&]+)/);
    if (depotMatch) {
      const depotData = await spokeApiFetch(`depots/${depotMatch[1]}`);
      if (depotData) {
        store = resolveStore(depotData.name || depotData.title || "");
        console.log("[Spoke] Store from depot:", store);
      }
    }
  }

  // Fallback: try driver's depots
  if (store === "unknown" && typeof driverRef === "string" && driverRef.startsWith("drivers/")) {
    const driverData = await spokeApiFetch(driverRef);
    if (driverData?.depots?.[0]) {
      const depotData = await spokeApiFetch(driverData.depots[0]);
      if (depotData) {
        store = resolveStore(depotData.name || depotData.title || "");
        console.log("[Spoke] Store from driver depot:", store);
      }
    }
  }

  // ─── Dedup ───
  const spokeStopId = stopId || null;
  const spokeRouteId = routeData.id || null;

  if (spokeStopId) {
    const existing = db.prepare("SELECT id FROM notifications WHERE spoke_stop_id = ?").get(spokeStopId);
    if (existing) {
      console.log("[Spoke] Duplicate stop — skipping");
      return;
    }
  }

  // ─── Validate delivery day (Tue–Sat) ───
  const deliveryDate = new Date(scheduledDate + "T12:00:00");
  if (!isDeliveryDay(deliveryDate)) {
    console.log("[Spoke]", scheduledDate, "is not a delivery day — skipping");
    return;
  }

  // ─── Insert notification ───
  console.log("[Spoke] Inserting:", customerName, "|", store, "|", scheduledDate, "|", timeWindow);

  const result = db
    .prepare(
      `INSERT INTO notifications
      (customer_name, phone, store, address, scheduled_date, time_window, raw_delivery_time, product, driver, status, spoke_stop_id, spoke_route_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`
    )
    .run(
      customerName,
      cleanPhone(phone),
      store,
      address,
      scheduledDate,
      timeWindow,
      rawDeliveryTime || null,
      product,
      driver,
      spokeStopId,
      spokeRouteId,
      new Date().toISOString(),
      new Date().toISOString()
    );

  const notificationId = result.lastInsertRowid;
  logActivity("stop_imported", `New delivery: ${customerName} → ${store} (${timeWindow})`, notificationId);
  console.log("[Spoke] ✓ Stored notification #" + notificationId);
}

/**
 * Process a manually sent test stop (our custom format)
 */
async function processManualStop(stop) {
  const customerName = stop.recipient?.name || stop.customer_name || stop.name || "Unknown Customer";
  const phone = stop.recipient?.phone || stop.customer_phone || stop.phone || null;

  if (!phone) {
    console.log("[Spoke] No phone for", customerName, "— skipping");
    return;
  }

  const address = (typeof stop.address === "string" ? stop.address : "") || stop.address?.addressLineOne || "";
  const scheduledDate = stop.scheduledDate || stop.date || new Date().toISOString().split("T")[0];

  let timeWindow = "TBD";
  let rawDeliveryTime = stop.startTime || null;
  if (rawDeliveryTime) {
    const window = computeDeliveryWindow(rawDeliveryTime);
    timeWindow = window.windowText;
  }

  const product = stop.notes || stop.product || "";
  const driver = stop.driver?.name || stop.driverName || "Your driver";
  const store = resolveStore(stop.depot?.name || stop.depot || stop.store || "");
  const spokeStopId = stop.id || null;

  if (spokeStopId) {
    const existing = db.prepare("SELECT id FROM notifications WHERE spoke_stop_id = ?").get(spokeStopId);
    if (existing) {
      console.log("[Spoke] Duplicate stop — skipping");
      return;
    }
  }

  const deliveryDate = new Date(scheduledDate + "T12:00:00");
  if (!isDeliveryDay(deliveryDate)) {
    console.log("[Spoke]", scheduledDate, "is not a delivery day — skipping");
    return;
  }

  const result = db
    .prepare(
      `INSERT INTO notifications
      (customer_name, phone, store, address, scheduled_date, time_window, raw_delivery_time, product, driver, status, spoke_stop_id, spoke_route_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`
    )
    .run(
      customerName, cleanPhone(phone), store, address, scheduledDate,
      timeWindow, rawDeliveryTime, product, driver, spokeStopId, null,
      new Date().toISOString(), new Date().toISOString()
    );

  const notificationId = result.lastInsertRowid;
  logActivity("stop_imported", `New delivery: ${customerName} → ${store} (${timeWindow})`, notificationId);
  console.log("[Spoke] ✓ Stored notification #" + notificationId);
}

/**
 * Parse date from Spoke route title like "Sat, Feb 28 Route"
 */
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

module.exports = { handleSpokeWebhook };
