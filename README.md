/**
 * Spoke Dispatch Webhook Handler
 *
 * Spoke Dispatch sends webhook events when delivery stops are created,
 * routes are optimized, and deliveries are completed.
 *
 * API Docs: https://developer.dispatch.spoke.com/
 *
 * Configure your webhook URL in Spoke Dispatch:
 *   Settings > Integrations > Webhooks
 *   URL: https://your-app.up.railway.app/api/spoke/webhook
 */

const db = require("../database");
const { sendSms } = require("../services/quo");
const { getSmsBody, computeDeliveryWindow, isSendDay, isDeliveryDay } = require("../services/templates");

/**
 * Map Spoke Dispatch store/depot names to your internal store IDs.
 * Update these to match your actual Spoke Dispatch depot names.
 */
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
 * Spoke sends different event shapes depending on the action.
 * We primarily care about stop-level data for customer notifications.
 */
async function handleSpokeWebhook(payload, headers) {
  // Optional: verify webhook signature if Spoke provides one
  // verifySignature(payload, headers);

  const results = { processed: 0, skipped: 0, errors: [] };

  // ─── Handle different payload structures ────────────────
  // Spoke's API can send stop data in different formats.
  // Adjust these based on your actual webhook payloads.

  // Case 1: Array of stops (batch import / route optimization)
  if (Array.isArray(payload)) {
    for (const stop of payload) {
      try {
        await processStop(stop);
        results.processed++;
      } catch (err) {
        results.errors.push({ stop: stop?.id, error: err.message });
      }
    }
    return results;
  }

  // Case 2: Single stop event
  if (payload.stop || payload.data?.stop) {
    const stop = payload.stop || payload.data.stop;
    try {
      await processStop(stop);
      results.processed++;
    } catch (err) {
      results.errors.push({ stop: stop?.id, error: err.message });
    }
    return results;
  }

  // Case 3: Route event with embedded stops
  if (payload.route || payload.data?.route) {
    const route = payload.route || payload.data.route;
    const stops = route.stops || [];
    for (const stop of stops) {
      try {
        await processStop(stop, route);
        results.processed++;
      } catch (err) {
        results.errors.push({ stop: stop?.id, error: err.message });
      }
    }
    logActivity("webhook_received", `Spoke route ${route.id || "unknown"} — ${stops.length} stops processed`);
    return results;
  }

  // Case 4: Generic event wrapper
  if (payload.event || payload.type) {
    const eventType = payload.event || payload.type;
    console.log(`[Spoke] Received event type: ${eventType}`);

    // Handle stop-related events
    if (eventType.includes("stop") || eventType.includes("delivery")) {
      const stopData = payload.data || payload;
      try {
        await processStop(stopData);
        results.processed++;
      } catch (err) {
        results.errors.push({ error: err.message });
      }
    }

    logActivity("webhook_received", `Spoke event: ${eventType}`);
    return results;
  }

  // Fallback: try to extract stop data from the payload
  if (payload.recipient || payload.address || payload.customer) {
    try {
      await processStop(payload);
      results.processed++;
    } catch (err) {
      results.errors.push({ error: err.message });
    }
    return results;
  }

  console.log("[Spoke] Unrecognized payload structure:", JSON.stringify(payload).substring(0, 500));
  logActivity("webhook_received", "Unrecognized Spoke payload — logged for review");
  results.skipped++;
  return results;
}

/**
 * Process a single delivery stop into a notification
 */
async function processStop(stop, route = null) {
  // Extract customer info — adapt field names to match your actual Spoke data
  const customerName =
    stop.recipient?.name ||
    stop.customer_name ||
    stop.recipientName ||
    stop.name ||
    `${stop.recipient?.firstName || ""} ${stop.recipient?.lastName || ""}`.trim() ||
    "Unknown Customer";

  const phone =
    stop.recipient?.phone ||
    stop.customer_phone ||
    stop.recipientPhone ||
    stop.phone ||
    stop.recipient?.phoneNumber ||
    null;

  if (!phone) {
    console.log(`[Spoke] Skipping stop — no phone number for ${customerName}`);
    return;
  }

  const address =
    stop.address?.formattedAddress ||
    stop.address?.addressLineOne ||
    stop.formattedAddress ||
    stop.address ||
    (typeof stop.address === "object"
      ? `${stop.address.line1 || ""} ${stop.address.city || ""} ${stop.address.state || ""}`.trim()
      : "") ||
    "";

  const scheduledDate = stop.scheduledDate || stop.date || route?.date || new Date().toISOString().split("T")[0];

  // Extract raw delivery time for window computation
  const rawDeliveryTime =
    stop.startTime ||
    stop.estimatedArrival ||
    stop.eta ||
    stop.deliveryTime ||
    stop.arrivalTime ||
    stop.time ||
    route?.startTime ||
    null;

  // Compute the 2-hour delivery window (rounds UP to nearest 30 min)
  let timeWindow;
  let rawTimeStore = rawDeliveryTime;
  if (rawDeliveryTime) {
    const window = computeDeliveryWindow(rawDeliveryTime);
    timeWindow = window.windowText; // e.g., "between 9:00 and 11:00 AM"
  } else if (stop.timeWindow || stop.deliveryWindow) {
    timeWindow = stop.timeWindow || stop.deliveryWindow;
    // If it's a range like "9:00 AM - 11:00 AM", extract start for raw storage
    const parts = (stop.timeWindow || stop.deliveryWindow || "").split(/[-–]/);
    if (parts.length >= 1) rawTimeStore = parts[0].trim();
  } else if (stop.startTime && stop.endTime) {
    rawTimeStore = stop.startTime;
    const window = computeDeliveryWindow(stop.startTime);
    timeWindow = window.windowText;
  } else {
    timeWindow = "TBD";
  }

  // Validate this is for a valid delivery day (Tue–Sat)
  const deliveryDate = new Date(scheduledDate + "T12:00:00");
  if (!isDeliveryDay(deliveryDate)) {
    console.log(`[Spoke] Skipping stop for ${customerName} — ${scheduledDate} is not a delivery day (Tue-Sat only)`);
    return;
  }

  const product =
    stop.notes ||
    stop.packageDescription ||
    stop.orderNotes ||
    stop.customFields?.product ||
    stop.customProperties?.product ||
    "";

  const driver = route?.driver?.name || stop.driver?.name || stop.driverName || "Your driver";

  const store = resolveStore(route?.depot?.name || stop.depot || stop.store || stop.team);

  const spokeStopId = stop.id || stop.stopId || null;
  const spokeRouteId = route?.id || stop.routeId || null;

  // Check for duplicate (same spoke_stop_id)
  if (spokeStopId) {
    const existing = db.prepare("SELECT id FROM notifications WHERE spoke_stop_id = ?").get(spokeStopId);
    if (existing) {
      console.log(`[Spoke] Duplicate stop ${spokeStopId} — skipping`);
      return;
    }
  }

  // Insert notification — always starts as 'pending'
  // The 6 PM EST scheduler will handle actual sending
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
      rawTimeStore || null,
      product,
      driver,
      spokeStopId,
      spokeRouteId,
      new Date().toISOString(),
      new Date().toISOString()
    );

  const notificationId = result.lastInsertRowid;
  logActivity("stop_imported", `New delivery: ${customerName} → ${store} (${timeWindow})`, notificationId);
  console.log(`[Spoke] Stored notification #${notificationId} for ${customerName} — ${scheduledDate} ${timeWindow}`);
}

/**
 * Clean/normalize phone numbers
 */
function cleanPhone(phone) {
  if (!phone) return "";
  // Strip everything except digits and leading +
  let cleaned = phone.replace(/[^\d+]/g, "");
  // Ensure US format
  if (cleaned.length === 10) cleaned = "+1" + cleaned;
  if (cleaned.length === 11 && cleaned.startsWith("1")) cleaned = "+" + cleaned;
  return cleaned;
}

function logActivity(type, detail, notificationId = null) {
  db.prepare("INSERT INTO activity_log (type, detail, notification_id, created_at) VALUES (?, ?, ?, ?)").run(
    type,
    detail,
    notificationId,
    new Date().toISOString()
  );
}

module.exports = { handleSpokeWebhook };
