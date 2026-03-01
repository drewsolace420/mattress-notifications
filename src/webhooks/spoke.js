/**
 * Spoke Dispatch Webhook Handler
 *
 * Spoke webhooks strip recipient PII (name, phone, email come as null).
 * So after receiving a webhook, we call the Spoke REST API to fetch
 * the full stop details including recipient info.
 *
 * Spoke REST API: https://api.getcircuit.com/public/v0.2b
 * Auth: Bearer {SPOKE_API_KEY}
 *
 * EVENTS HANDLED:
 *   stop.allocated          → route sent to driver → creates pending notification
 *   stop.attempted_delivery → driver marks complete → sends Google review request
 *
 * STORE RESOLUTION:
 *   All deliveries ship from a central depot, so store is determined by
 *   the leading digit of the "Sale Number" custom property in Spoke:
 *     1 = (skip review solicitation)
 *     2 = Nicholasville Road (Lexington)
 *     3 = Georgetown
 *     4 = Somerset
 *     5 = London
 */

const db = require("../database");
const { sendSms } = require("../services/quo");
const { getSmsBody, computeDeliveryWindow, isSendDay, isDeliveryDay } = require("../services/templates");
const {
  SPOKE_API_BASE,
  STORE_REVIEW_LINKS,
  STORE_DISPLAY_NAMES,
  resolveStoreFromSaleNumber,
  extractSaleNumber,
  cleanPhone,
  logActivity,
  parseDateFromRouteTitle,
} = require("../services/utils");
const fetch = require("node-fetch");

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
    } else if (payload.type === "stop.attempted_delivery") {
      try {
        await processDeliveryComplete(payload.data);
        results.processed++;
      } catch (err) {
        console.error("[Spoke] Delivery complete error:", err.message, err.stack);
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
 * Store is determined by the Sale Number custom property.
 */
async function processSpokeStop(webhookData) {
  const stopId = webhookData.id; // e.g., "plans/abc123/stops/xyz789"
  console.log("[Spoke] Processing stop.allocated:", stopId);

  // ─── Skip depot start/end stops ───
  const stopType = webhookData.type;
  if (stopType === "start" || stopType === "end") {
    console.log(`[Spoke] Skipping depot stop (type: ${stopType})`);
    return;
  }

  // ─── Fetch full stop from REST API (has recipient info + custom properties) ───
  let fullStop = null;
  if (stopId) {
    fullStop = await spokeApiFetch(stopId);
    if (fullStop) {
      console.log("[Spoke API] Full stop recipient:", JSON.stringify(fullStop.recipient));
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

  // ─── Store from Sale Number ───
  const saleNumber = extractSaleNumber(data.customProperties);
  const store = resolveStoreFromSaleNumber(saleNumber);
  console.log("[Spoke] Sale Number:", saleNumber, "→ Store:", store);

  // ─── Scheduled date ───
  let scheduledDate = null;

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
  let rawDeliveryTime = null;
  let timeWindow = "TBD";

  const etaTimestamp =
    webhookEta.estimatedArrivalAt ||
    webhookEta.estimatedEarliestArrivalAt ||
    data.eta?.estimatedArrivalAt ||
    data.eta?.estimatedEarliestArrivalAt ||
    null;

  if (etaTimestamp) {
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
    (saleNumber ? `Sale #${saleNumber}` : "") ||
    "";

  // ─── Driver ───
  let driver = "Your driver";
  const driverRef = routeData.driver;

  if (typeof driverRef === "string" && driverRef.startsWith("drivers/")) {
    const driverData = await spokeApiFetch(driverRef);
    if (driverData) {
      driver = driverData.displayName || driverData.name || "Your driver";
      console.log("[Spoke] Driver:", driver);
    }
  } else if (typeof driverRef === "object" && driverRef) {
    driver = driverRef.displayName || driverRef.name || "Your driver";
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
  trackPlan(spokeStopId, scheduledDate);
  logActivity("stop_imported", `New delivery: ${customerName} → ${STORE_DISPLAY_NAMES[store] || store} (${timeWindow})`, notificationId);
  console.log("[Spoke] ✓ Stored notification #" + notificationId);
}

/**
 * Process a stop.attempted_delivery event.
 *
 * When the driver marks a stop as complete/delivered, we send the customer
 * a thank-you text with a Google Review link for the correct store.
 *
 * If the store is "other" (sale number starts with 1), skip the review request.
 */
async function processDeliveryComplete(webhookData) {
  const stopId = webhookData.id;
  console.log("[Spoke] Processing stop.attempted_delivery:", stopId);
  console.log("[Spoke] Full webhook data keys:", Object.keys(webhookData));
  console.log("[Spoke] deliveryInfo:", JSON.stringify(webhookData.deliveryInfo));
  console.log("[Spoke] activity:", JSON.stringify(webhookData.activity));
  console.log("[Spoke] status:", webhookData.status);
  console.log("[Spoke] type:", webhookData.type);
  console.log("[Spoke] orderInfo:", JSON.stringify(webhookData.orderInfo));
  // Log any other fields that might distinguish "next in queue" vs "completed"
  console.log("[Spoke] Raw payload (first 1000 chars):", JSON.stringify(webhookData).substring(0, 1000));

  // ─── Skip depot start/end stops ───
  const stopType = webhookData.type;
  if (stopType === "start" || stopType === "end") {
    console.log(`[Spoke] Skipping depot stop (type: ${stopType})`);
    return;
  }

  // ─── Check if delivery was successful ───
  const deliveryInfo = webhookData.deliveryInfo || webhookData;
  const succeeded = deliveryInfo.succeeded === true;
  const attempted = deliveryInfo.attempted === true;
  console.log("[Spoke] succeeded:", succeeded, "| attempted:", attempted, "| deliveryInfo.succeeded:", deliveryInfo.succeeded, "| deliveryInfo.attempted:", deliveryInfo.attempted);

  if (!succeeded && attempted) {
    console.log("[Spoke] Delivery attempted but not successful — skipping review request");
    logActivity("delivery_failed", `Delivery attempt failed for stop ${stopId}`);
    return;
  }

  // ─── Find matching notification in our database ───
  let notification = null;
  if (stopId) {
    notification = db.prepare("SELECT * FROM notifications WHERE spoke_stop_id = ?").get(stopId);
  }

  // ─── No DB match — fetch from API and send directly ───
  if (!notification) {
    console.log("[Spoke] No matching notification — fetching from Spoke API for direct review send");
    const fullStop = stopId ? await spokeApiFetch(stopId) : null;

    if (!fullStop) {
      console.log("[Spoke] Could not fetch stop from API — skipping");
      return;
    }

    const recipient = fullStop.recipient || {};
    const phone = recipient.phone || recipient.phoneNumber || null;
    const customerName = recipient.name || "Customer";

    if (!phone) {
      console.log("[Spoke] No phone number in API data — cannot send review");
      return;
    }

    // Resolve store from sale number
    const saleNumber = extractSaleNumber(fullStop.customProperties);
    const store = resolveStoreFromSaleNumber(saleNumber);
    console.log("[Spoke] Direct review — Customer:", customerName, "| Phone:", phone, "| Sale#:", saleNumber, "→ Store:", store);

    if (store === "other") {
      console.log("[Spoke] Store is 'other' (sale prefix 1) — skipping review");
      logActivity("delivery_complete", `Delivery complete for ${customerName} — no review (store: other)`);
      return;
    }

    if (store === "unknown") {
      console.log("[Spoke] Store unknown — skipping review");
      logActivity("delivery_complete", `Delivery complete for ${customerName} — no review (unknown store)`);
      return;
    }

    // ─── Check if customer already clicked a sale-day review link ───
    const directSaleReviewClick = db.prepare(
      "SELECT id, clicked_at FROM sale_reviews WHERE phone = ? AND clicked_at IS NOT NULL ORDER BY created_at DESC LIMIT 1"
    ).get(cleanPhone(phone));

    if (directSaleReviewClick) {
      console.log(`[Spoke] Customer already clicked sale-day review link — suppressing delivery review for ${customerName}`);
      logActivity("delivery_review_suppressed",
        `Delivery review suppressed for ${customerName} — sale-day review already clicked`);
      return;
    }

    const reviewLink = STORE_REVIEW_LINKS[store] || null;
    const storeName = STORE_DISPLAY_NAMES[store] || "Mattress Overstock";

    let message;
    if (reviewLink) {
      message =
        `Your mattress has been delivered! Thank you for choosing ${storeName}. ` +
        `We'd love your feedback — tap here to leave a quick review:\n${reviewLink}`;
    } else {
      message =
        `Your mattress has been delivered! Thank you for choosing Mattress Overstock. ` +
        `We appreciate your business!`;
    }

    try {
      await sendSms(cleanPhone(phone), message);
      console.log(`[Spoke] ✓ Direct review request sent to ${customerName} (${store})`);
      logActivity("review_request_sent", `Google review request sent to ${customerName} → ${storeName} (no prior notification)`);
    } catch (err) {
      console.error("[Spoke] Failed to send direct review:", err.message);
      logActivity("review_request_failed", `Failed direct review for ${customerName}: ${err.message}`);
    }
    return;
  }

  const store = notification.store;
  console.log("[Spoke] Delivery complete for:", notification.customer_name, "| Store:", store);

  // ─── Skip review for "other" stores (sale number starts with 1) ───
  if (store === "other") {
    console.log("[Spoke] Store is 'other' (sale prefix 1) — skipping review solicitation");
    logActivity("delivery_complete", `Delivery complete for ${notification.customer_name} — no review (store: other)`, notification.id);
    db.prepare(
      "UPDATE notifications SET status = 'delivered', updated_at = ? WHERE id = ?"
    ).run(new Date().toISOString(), notification.id);
    return;
  }

  // ─── Check if customer already clicked a sale-day review link ───
  const saleReviewClick = db.prepare(
    "SELECT id, clicked_at FROM sale_reviews WHERE phone = ? AND clicked_at IS NOT NULL ORDER BY created_at DESC LIMIT 1"
  ).get(notification.phone);

  if (saleReviewClick) {
    console.log(`[Spoke] Customer already clicked sale-day review link — suppressing delivery review for ${notification.customer_name}`);
    logActivity("delivery_review_suppressed",
      `Delivery review suppressed for ${notification.customer_name} — sale-day review already clicked`,
      notification.id);

    // Still mark as delivered, just don't send the review
    db.prepare(
      "UPDATE notifications SET status = 'delivered', updated_at = ? WHERE id = ?"
    ).run(new Date().toISOString(), notification.id);
    return;
  }

  // ─── Build review request message ───
  const reviewLink = STORE_REVIEW_LINKS[store] || null;
  const storeName = STORE_DISPLAY_NAMES[store] || "Mattress Overstock";

  let message;
  if (reviewLink) {
    message =
      `Your mattress has been delivered! Thank you for choosing ${storeName}. ` +
      `We'd love your feedback — tap here to leave a quick review:\n${reviewLink}`;
  } else {
    message =
      `Your mattress has been delivered! Thank you for choosing Mattress Overstock. ` +
      `We appreciate your business!`;
  }

  // ─── Send review request ───
  try {
    await sendSms(notification.phone, message);
    console.log(`[Spoke] ✓ Review request sent to ${notification.customer_name} (${store})`);
    logActivity("review_request_sent", `Google review request sent to ${notification.customer_name} → ${storeName}`, notification.id);

    db.prepare(
      "UPDATE notifications SET status = 'delivered', review_sent_at = ?, updated_at = ? WHERE id = ?"
    ).run(new Date().toISOString(), new Date().toISOString(), notification.id);

  } catch (err) {
    console.error("[Spoke] Failed to send review request:", err.message);
    logActivity("review_request_failed", `Failed to send review request to ${notification.customer_name}: ${err.message}`, notification.id);
  }
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

  // Resolve store from sale number if provided
  const saleNumber = stop.saleNumber || stop.sale_number || null;
  const store = saleNumber ? resolveStoreFromSaleNumber(saleNumber) : (stop.store || "unknown");

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
  trackPlan(spokeStopId, scheduledDate);
  logActivity("stop_imported", `New delivery: ${customerName} → ${store} (${timeWindow})`, notificationId);
  console.log("[Spoke] ✓ Stored notification #" + notificationId);
}

/**
 * Track a Spoke plan ID for route sync.
 * Extracts plan ID from stop ID (e.g., "plans/abc123/stops/xyz" → "plans/abc123")
 * and stores it in tracked_plans with the delivery date.
 */
function trackPlan(spokeStopId, deliveryDate) {
  if (!spokeStopId) return;
  const match = spokeStopId.match(/^(plans\/[^/]+)/);
  if (!match) return;
  const planId = match[1];
  try {
    db.prepare(
      "INSERT OR IGNORE INTO tracked_plans (plan_id, delivery_date, created_at) VALUES (?, ?, ?)"
    ).run(planId, deliveryDate, new Date().toISOString());
    console.log(`[Spoke] Tracked plan: ${planId} for ${deliveryDate}`);
  } catch (e) {
    // Already tracked — that's fine
  }
}

module.exports = { handleSpokeWebhook };
