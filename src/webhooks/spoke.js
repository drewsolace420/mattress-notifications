/**
 * Spoke Dispatch Webhook Handler
 *
 * Spoke sends these webhook events:
 *   - stop.allocated: When dispatcher clicks "Send route to driver"
 *   - stop.out_for_delivery: When driver starts their route
 *   - stop.attempted_delivery: When delivery status changes
 *
 * Payload format:
 *   { "type": "stop.allocated", "version": "v0.2b", "created": ..., "data": { ...stop... } }
 */

const db = require("../database");
const { sendSms } = require("../services/quo");
const { getSmsBody, computeDeliveryWindow, isSendDay, isDeliveryDay } = require("../services/templates");

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
 * Main webhook handler
 */
async function handleSpokeWebhook(payload, headers) {
  const results = { processed: 0, skipped: 0, errors: [] };

  // ─── Spoke Webhook Events (stop.allocated, stop.out_for_delivery, etc.) ───
  if (payload.type && payload.data) {
    console.log("[Spoke] Event type:", payload.type);
    console.log("[Spoke] FULL PAYLOAD:", JSON.stringify(payload, null, 2));

    if (payload.type === "stop.allocated") {
      try {
        await processSpokeStop(payload.data);
        results.processed++;
      } catch (err) {
        console.error("[Spoke] Error processing stop.allocated:", err.message, err.stack);
        results.errors.push({ error: err.message });
      }
    } else {
      console.log("[Spoke] Ignoring event type:", payload.type);
      results.skipped++;
    }
    return results;
  }

  // ─── Manual/Test webhook (our test format) ───
  if (payload.stop) {
    try {
      await processManualStop(payload.stop);
      results.processed++;
    } catch (err) {
      console.error("[Spoke] Error processing manual stop:", err.message, err.stack);
      results.errors.push({ stop: payload.stop?.id, error: err.message });
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
        console.error("[Spoke] Error:", err.message);
        results.errors.push({ error: err.message });
      }
    }
    return results;
  }

  console.log("[Spoke] Unrecognized payload:", JSON.stringify(payload).substring(0, 500));
  results.skipped++;
  return results;
}

/**
 * Process a stop from Spoke's stop.allocated webhook event.
 *
 * Spoke Stop model (from their docs):
 *   id, plan, route { id, title, stopCount, state, driver, plan },
 *   address { address, addressLineOne, addressLineTwo, latitude, longitude },
 *   recipient { name, phone, email },
 *   timing { earliestAttemptTime { hour, minute }, latestAttemptTime { hour, minute }, estimatedAttemptDuration },
 *   notes, driverIdentifier, orderInfo, customProperties, barcodes
 */
async function processSpokeStop(data) {
  console.log("[Spoke] Processing stop.allocated...");
  console.log("[Spoke] Top-level keys:", Object.keys(data));

  // ─── Customer info ───
  const recipient = data.recipient || {};
  console.log("[Spoke] Recipient:", JSON.stringify(recipient));

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

  console.log("[Spoke] Customer:", customerName, "Phone:", phone);

  if (!phone) {
    console.log("[Spoke] ⚠ No phone number — skipping");
    logActivity("stop_skipped", `No phone number for ${customerName}`);
    return;
  }

  // ─── Address ───
  const addr = data.address || {};
  console.log("[Spoke] Address object:", JSON.stringify(addr));

  const address =
    addr.addressLineOne ||
    addr.address ||
    addr.formattedAddress ||
    (typeof data.address === "string" ? data.address : "") ||
    "";

  // ─── Scheduled date ───
  let scheduledDate = null;

  // Try route title like "Fri, Feb 28 Route 1"
  if (data.route?.title) {
    scheduledDate = parseDateFromRouteTitle(data.route.title);
    console.log("[Spoke] Date from route title:", data.route.title, "→", scheduledDate);
  }

  // Fallback to tomorrow
  if (!scheduledDate) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    scheduledDate = tomorrow.toISOString().split("T")[0];
    console.log("[Spoke] Using tomorrow as scheduled date:", scheduledDate);
  }

  // ─── Delivery time / window ───
  const timing = data.timing || {};
  console.log("[Spoke] Timing:", JSON.stringify(timing));

  let rawDeliveryTime = null;
  let timeWindow = "TBD";

  if (timing.earliestAttemptTime) {
    const earliest = timing.earliestAttemptTime;
    const minutes = (earliest.hour || 0) * 60 + (earliest.minute || 0);
    rawDeliveryTime = `${earliest.hour}:${String(earliest.minute || 0).padStart(2, "0")}`;
    const window = computeDeliveryWindow(minutes);
    timeWindow = window.windowText;
    console.log("[Spoke] Window from timing:", rawDeliveryTime, "→", timeWindow);
  } else if (data.eta?.estimatedArrivalTimestamp) {
    const eta = new Date(data.eta.estimatedArrivalTimestamp * 1000);
    rawDeliveryTime = `${eta.getHours()}:${String(eta.getMinutes()).padStart(2, "0")}`;
    const window = computeDeliveryWindow(rawDeliveryTime);
    timeWindow = window.windowText;
    console.log("[Spoke] Window from ETA:", rawDeliveryTime, "→", timeWindow);
  }

  // ─── Product / notes ───
  const product =
    data.orderInfo?.products ||
    data.notes ||
    (data.customProperties ? JSON.stringify(data.customProperties) : "") ||
    "";

  // ─── Driver ───
  const driver =
    data.route?.driver?.displayName ||
    data.route?.driver?.name ||
    data.driverIdentifier ||
    "Your driver";

  // ─── Store/depot ───
  const store = resolveStore(
    data.route?.depot?.name ||
    data.depot?.name ||
    data.depot ||
    ""
  );

  // ─── Dedup ───
  const spokeStopId = data.id || null;
  const spokeRouteId = data.route?.id || null;

  if (spokeStopId) {
    const existing = db.prepare("SELECT id FROM notifications WHERE spoke_stop_id = ?").get(spokeStopId);
    if (existing) {
      console.log("[Spoke] Duplicate stop", spokeStopId, "— skipping");
      return;
    }
  }

  // ─── Validate delivery day ───
  const deliveryDate = new Date(scheduledDate + "T12:00:00");
  if (!isDeliveryDay(deliveryDate)) {
    console.log("[Spoke]", scheduledDate, "is not a delivery day (Tue-Sat) — skipping");
    return;
  }

  // ─── Insert ───
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
      console.log("[Spoke] Duplicate stop", spokeStopId, "— skipping");
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
 * Parse date from Spoke route title like "Fri, Feb 28 Route 1"
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
