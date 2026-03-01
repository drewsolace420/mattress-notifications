require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const fetch = require("node-fetch");
const db = require("./database");
const { handleSpokeWebhook } = require("./webhooks/spoke");
const { sendSms, getQuoStatus } = require("./services/quo");
const { getSmsBody, isSendDay, isDeliveryDay } = require("./services/templates");
const { startScheduler, executeDailySend, executeStaffSummary, getSchedulerStatus } = require("./services/scheduler");
const { handleRescheduleMessage, startRescheduleConversation } = require("./services/reschedule");
const { syncRoutes, startAutoSync, registerPlan, getTrackedPlans } = require("./services/sync");
const { processSaleReview, recordClick, getComparisonData, cleanPhone } = require("./services/sale-review");
const { parsePosCsv } = require("./services/pos-parser");

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Spoke API helper ────────────────────────────────────
async function updateSpokeStopNotes(stopId, notes) {
  const apiKey = process.env.SPOKE_API_KEY;
  if (!apiKey || !stopId) return false;

  // Try standard PATCH first
  try {
    const res = await fetch(`https://api.getcircuit.com/public/v0.2b/${stopId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ notes }),
    });
    if (res.ok) {
      console.log("[Spoke API] Updated stop notes via standard PATCH:", stopId);
      return true;
    }
    const errText = await res.text();
    console.log("[Spoke API] Standard PATCH failed:", res.status, errText.substring(0, 200));
  } catch (e) {
    console.log("[Spoke API] Standard PATCH error:", e.message);
  }

  // Fallback: Live Stops API (for already-distributed routes)
  try {
    // stopId is like "plans/abc123/stops/xyz789" — extract planId and stopId
    const match = stopId.match(/plans\/([^/]+)\/stops\/([^/]+)/);
    if (!match) {
      console.error("[Spoke API] Cannot parse stop ID for live stops:", stopId);
      return false;
    }
    const [, planId, stopSubId] = match;
    const liveUrl = `https://api.getcircuit.com/public/v0.2b/plans/${planId}/liveStops/${stopSubId}`;

    console.log("[Spoke API] Trying Live Stops API:", liveUrl);

    const res = await fetch(liveUrl, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ notes }),
    });
    if (res.ok) {
      console.log("[Spoke API] Updated stop notes via Live Stops API:", stopId);
      return true;
    }
    console.error("[Spoke API] Live Stops PATCH also failed:", res.status, (await res.text()).substring(0, 200));
    return false;
  } catch (e) {
    console.error("[Spoke API] Live Stops error:", e.message);
    return false;
  }
}

// ─── Middleware ───────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use(express.text({ type: "text/csv", limit: "5mb" }));
app.use(express.static(path.join(__dirname, "../public")));

// ─── Authentication ─────────────────────────────────────
function requireAuth(req, res, next) {
  // Public paths — no auth needed
  if (req.path === "/api/health") return next();
  if (req.path === "/api/spoke/webhook") return next();
  if (req.path === "/api/quo/webhook") return next();
  if (req.path === "/api/auth/verify") return next();
  if (req.path.startsWith("/r/")) return next();

  // Static files (dashboard HTML/CSS/JS/images) — served without auth
  if (!req.path.startsWith("/api/")) return next();

  // Check admin password
  const password = process.env.ADMIN_PASSWORD;
  if (!password) return next(); // No password set = open access (local dev)

  const authHeader = req.headers.authorization;
  if (authHeader === `Bearer ${password}`) return next();

  res.status(401).json({ error: "Unauthorized" });
}

app.use(requireAuth);

// ─── Auth Verification Endpoint ─────────────────────────
app.post("/api/auth/verify", (req, res) => {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) return res.json({ valid: true, authRequired: false });

  const authHeader = req.headers.authorization;
  if (authHeader === `Bearer ${password}`) {
    return res.json({ valid: true });
  }
  res.status(401).json({ valid: false });
});

// ─── Health Check ────────────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    services: {
      spoke: process.env.SPOKE_API_KEY ? "configured" : "missing",
      quo: process.env.QUO_API_KEY ? "configured" : "missing",
    },
  });
});

// ─── Spoke Dispatch Webhook Endpoint ─────────────────────
// Configure this URL in Spoke Dispatch: Settings > Integrations > Webhooks
// URL: https://your-app.up.railway.app/api/spoke/webhook
app.post("/api/spoke/webhook", async (req, res) => {
  console.log("[Webhook] Received Spoke Dispatch event:", JSON.stringify(req.body).substring(0, 200));

  try {
    const result = await handleSpokeWebhook(req.body, req.headers);
    res.status(200).json({ received: true, processed: result.processed });
  } catch (err) {
    console.error("[Webhook] Error processing:", err.message);
    // Always return 200 to prevent Spoke from retrying
    res.status(200).json({ received: true, error: err.message });
  }
});

// ─── Notifications API ───────────────────────────────────

// List all notifications (with optional filters)
app.get("/api/notifications", (req, res) => {
  const { store, status, date, limit = 50, offset = 0 } = req.query;
  let query = "SELECT * FROM notifications WHERE 1=1";
  const params = [];

  if (store) {
    query += " AND store = ?";
    params.push(store);
  }
  if (status) {
    if (status === 'rescheduling') {
      query += " AND conversation_state = 'rescheduling'";
    } else {
      query += " AND status = ?";
      params.push(status);
    }
  }
  if (date) {
    query += " AND scheduled_date = ?";
    params.push(date);
  }

  query += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
  params.push(Number(limit), Number(offset));

  const notifications = db.prepare(query).all(...params);
  const total = db
    .prepare(query.replace(/SELECT \*/, "SELECT COUNT(*) as count").replace(/ORDER BY.*/, ""))
    .get(...params.slice(0, -2));

  res.json({ notifications, total: total.count });
});

// Get a single notification
app.get("/api/notifications/:id", (req, res) => {
  const notification = db.prepare("SELECT * FROM notifications WHERE id = ?").get(req.params.id);
  if (!notification) return res.status(404).json({ error: "Not found" });
  res.json(notification);
});

// Delete a notification
app.delete("/api/notifications/:id", (req, res) => {
  const notification = db.prepare("SELECT * FROM notifications WHERE id = ?").get(req.params.id);
  if (!notification) return res.status(404).json({ error: "Not found" });
  db.prepare("DELETE FROM notifications WHERE id = ?").run(req.params.id);
  db.prepare("DELETE FROM activity_log WHERE notification_id = ?").run(req.params.id);
  logActivity("notification_deleted", `Deleted: ${notification.customer_name} — ${notification.scheduled_date} ${notification.time_window}`);
  res.json({ success: true, deleted: notification.id });
});

// Manually send (or retry) an SMS for a notification
app.post("/api/notifications/:id/send", async (req, res) => {
  const notification = db.prepare("SELECT * FROM notifications WHERE id = ?").get(req.params.id);
  if (!notification) return res.status(404).json({ error: "Not found" });

  try {
    const smsBody = getSmsBody(notification);
    const result = await sendSms(notification.phone, smsBody);

    db.prepare(
      "UPDATE notifications SET status = ?, sent_at = ?, quo_message_id = ?, retry_count = retry_count + 1, updated_at = ? WHERE id = ?"
    ).run("sent", new Date().toISOString(), result.messageId || null, new Date().toISOString(), notification.id);

    logActivity("sms_sent", `SMS sent to ${notification.customer_name}`, notification.id);
    res.json({ success: true, messageId: result.messageId });
  } catch (err) {
    db.prepare("UPDATE notifications SET status = ?, error_message = ?, retry_count = retry_count + 1, updated_at = ? WHERE id = ?").run(
      "failed",
      err.message,
      new Date().toISOString(),
      notification.id
    );
    logActivity("sms_failed", `SMS failed for ${notification.customer_name}: ${err.message}`, notification.id);
    res.status(500).json({ error: err.message });
  }
});

// Send all pending notifications
app.post("/api/notifications/actions/send-all-pending", async (req, res) => {
  // Only send notifications for the next delivery day
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split("T")[0];

  const pending = db.prepare("SELECT * FROM notifications WHERE status = 'pending' AND scheduled_date = ?").all(tomorrowStr);
  const results = { sent: 0, failed: 0, errors: [] };

  for (const notification of pending) {
    try {
      const smsBody = getSmsBody(notification);
      const result = await sendSms(notification.phone, smsBody);

      db.prepare(
        "UPDATE notifications SET status = ?, sent_at = ?, quo_message_id = ?, updated_at = ? WHERE id = ?"
      ).run("sent", new Date().toISOString(), result.messageId || null, new Date().toISOString(), notification.id);

      logActivity("sms_sent", `SMS sent to ${notification.customer_name}`, notification.id);
      results.sent++;
    } catch (err) {
      db.prepare("UPDATE notifications SET status = ?, error_message = ?, updated_at = ? WHERE id = ?").run(
        "failed",
        err.message,
        new Date().toISOString(),
        notification.id
      );
      logActivity("sms_failed", `SMS failed for ${notification.customer_name}: ${err.message}`, notification.id);
      results.failed++;
      results.errors.push({ id: notification.id, error: err.message });
    }
  }

  res.json(results);
});

// ─── SMS Template API ────────────────────────────────────
app.get("/api/template", (req, res) => {
  const template = db.prepare("SELECT * FROM sms_templates WHERE is_active = 1").get();
  res.json(template || { body: "Hi {{customer_first}}, your mattress delivery from {{business_name}} is confirmed for {{date}} between {{time_window}}. Your driver {{driver}} will text when en route. Reply STOP to opt out." });
});

app.put("/api/template", (req, res) => {
  const { body } = req.body;
  if (!body) return res.status(400).json({ error: "Template body required" });

  // Deactivate existing
  db.prepare("UPDATE sms_templates SET is_active = 0").run();
  // Insert new
  db.prepare("INSERT INTO sms_templates (body, is_active, created_at) VALUES (?, 1, ?)").run(body, new Date().toISOString());

  logActivity("template_updated", "SMS template updated");
  res.json({ success: true });
});

// ─── Activity Log API ────────────────────────────────────
app.get("/api/activity", (req, res) => {
  const { limit = 30, hours } = req.query;
  let logs;
  if (hours) {
    const cutoff = new Date(Date.now() - Number(hours) * 60 * 60 * 1000).toISOString();
    logs = db.prepare("SELECT * FROM activity_log WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?").all(cutoff, Number(limit));
  } else {
    logs = db.prepare("SELECT * FROM activity_log ORDER BY created_at DESC LIMIT ?").all(Number(limit));
  }
  res.json(logs);
});

// ─── Stats API ───────────────────────────────────────────
app.get("/api/stats", (req, res) => {
  const now = new Date();
  const estNow = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const today = estNow.toISOString().split("T")[0];

  // Tomorrow
  const tomorrow = new Date(estNow);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split("T")[0];

  // Next delivery date (skip Sun/Mon)
  let nextDelivery = new Date(estNow);
  nextDelivery.setDate(nextDelivery.getDate() + 1);
  while (nextDelivery.getDay() === 0 || nextDelivery.getDay() === 1) {
    nextDelivery.setDate(nextDelivery.getDate() + 1);
  }
  const nextDeliveryStr = nextDelivery.toISOString().split("T")[0];

  // Today's actual deliveries (things being delivered today)
  const todayDeliveries = {
    date: today,
    total: db.prepare("SELECT COUNT(*) as count FROM notifications WHERE scheduled_date = ?").get(today).count,
    confirmed: db.prepare("SELECT COUNT(*) as count FROM notifications WHERE scheduled_date = ? AND customer_response = 'yes'").get(today).count,
    declined: db.prepare("SELECT COUNT(*) as count FROM notifications WHERE scheduled_date = ? AND customer_response = 'no'").get(today).count,
    delivered: db.prepare("SELECT COUNT(*) as count FROM notifications WHERE scheduled_date = ? AND status = 'delivered'").get(today).count,
  };

  // Next delivery day stats (the main view)
  const nd = nextDeliveryStr;
  const nextDay = {
    date: nd,
    total: db.prepare("SELECT COUNT(*) as count FROM notifications WHERE scheduled_date = ? AND status != 'cancelled'").get(nd).count,
    sent: db.prepare("SELECT COUNT(*) as count FROM notifications WHERE scheduled_date = ? AND status IN ('sent','delivered')").get(nd).count,
    pending: db.prepare("SELECT COUNT(*) as count FROM notifications WHERE scheduled_date = ? AND status = 'pending'").get(nd).count,
    failed: db.prepare("SELECT COUNT(*) as count FROM notifications WHERE scheduled_date = ? AND status = 'failed'").get(nd).count,
    confirmed: db.prepare("SELECT COUNT(*) as count FROM notifications WHERE scheduled_date = ? AND customer_response = 'yes'").get(nd).count,
    declined: db.prepare("SELECT COUNT(*) as count FROM notifications WHERE scheduled_date = ? AND customer_response = 'no'").get(nd).count,
    cancelled: db.prepare("SELECT COUNT(*) as count FROM notifications WHERE scheduled_date = ? AND status = 'cancelled'").get(nd).count,
    rescheduling: db.prepare("SELECT COUNT(*) as count FROM notifications WHERE scheduled_date = ? AND conversation_state = 'rescheduling'").get(nd).count,
  };
  nextDay.noReply = nextDay.sent - nextDay.confirmed - nextDay.declined;

  const stats = {
    allTime: {
      total: db.prepare("SELECT COUNT(*) as count FROM notifications WHERE status != 'cancelled'").get().count,
      sent: db.prepare("SELECT COUNT(*) as count FROM notifications WHERE status = 'sent'").get().count,
      pending: db.prepare("SELECT COUNT(*) as count FROM notifications WHERE status = 'pending'").get().count,
      failed: db.prepare("SELECT COUNT(*) as count FROM notifications WHERE status = 'failed'").get().count,
      delivered: db.prepare("SELECT COUNT(*) as count FROM notifications WHERE status = 'delivered'").get().count,
      confirmedYes: db.prepare("SELECT COUNT(*) as count FROM notifications WHERE customer_response = 'yes'").get().count,
      declinedNo: db.prepare("SELECT COUNT(*) as count FROM notifications WHERE customer_response = 'no'").get().count,
    },
    // "today" now shows next delivery day stats (the useful view)
    today: {
      date: nd,
      total: nextDay.total,
      sent: nextDay.sent,
      pending: nextDay.pending,
      failed: nextDay.failed,
      delivered: nextDay.confirmed, // "delivered" card shows confirmed count
    },
    todayDeliveries, // actual today (being delivered right now)
    nextDelivery: nextDay,
    // Tomorrow queue (used by the dashboard panel)
    tomorrow: {
      date: tomorrowStr,
      total: db.prepare("SELECT COUNT(*) as count FROM notifications WHERE scheduled_date = ? AND status != 'cancelled'").get(tomorrowStr).count,
      pending: db.prepare("SELECT COUNT(*) as count FROM notifications WHERE scheduled_date = ? AND status = 'pending'").get(tomorrowStr).count,
      sent: db.prepare("SELECT COUNT(*) as count FROM notifications WHERE scheduled_date = ? AND status IN ('sent','delivered')").get(tomorrowStr).count,
    },
    scheduler: getSchedulerStatus(),
  };
  res.json(stats);
});

// ─── Charts / Reporting API ─────────────────────────────
app.get("/api/charts/daily", (req, res) => {
  const days = Number(req.query.days) || 14;
  const rows = db.prepare(`
    SELECT scheduled_date as date,
      COUNT(*) as total,
      SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as sent,
      SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) as delivered,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN customer_response = 'yes' THEN 1 ELSE 0 END) as confirmed,
      SUM(CASE WHEN customer_response = 'no' THEN 1 ELSE 0 END) as declined,
      SUM(CASE WHEN review_sent_at IS NOT NULL THEN 1 ELSE 0 END) as reviews_sent
    FROM notifications
    WHERE scheduled_date IS NOT NULL
    GROUP BY scheduled_date
    ORDER BY scheduled_date DESC
    LIMIT ?
  `).all(days);
  res.json(rows.reverse());
});

app.get("/api/charts/stores", (req, res) => {
  const rows = db.prepare(`
    SELECT store,
      COUNT(*) as total,
      SUM(CASE WHEN customer_response = 'yes' THEN 1 ELSE 0 END) as confirmed,
      SUM(CASE WHEN customer_response = 'no' THEN 1 ELSE 0 END) as declined,
      SUM(CASE WHEN review_sent_at IS NOT NULL THEN 1 ELSE 0 END) as reviews_sent
    FROM notifications
    WHERE store IS NOT NULL AND store != 'unknown'
    GROUP BY store
    ORDER BY total DESC
  `).all();
  res.json(rows);
});

app.get("/api/charts/responses", (req, res) => {
  const total = db.prepare("SELECT COUNT(*) as count FROM notifications WHERE status IN ('sent','delivered')").get().count;
  const yes = db.prepare("SELECT COUNT(*) as count FROM notifications WHERE customer_response = 'yes'").get().count;
  const no = db.prepare("SELECT COUNT(*) as count FROM notifications WHERE customer_response = 'no'").get().count;
  const stop = db.prepare("SELECT COUNT(*) as count FROM notifications WHERE customer_response = 'stop'").get().count;
  const noReply = total - yes - no - stop;
  const reviewsSent = db.prepare("SELECT COUNT(*) as count FROM notifications WHERE review_sent_at IS NOT NULL").get().count;
  res.json({ total, yes, no, stop, noReply, reviewsSent });
});

app.get("/api/charts/time-windows", (req, res) => {
  const rows = db.prepare(`
    SELECT time_window, COUNT(*) as count
    FROM notifications
    WHERE time_window IS NOT NULL AND time_window != 'TBD'
    GROUP BY time_window
    ORDER BY count DESC
  `).all();
  res.json(rows);
});

// ─── Settings API ────────────────────────────────────────
app.get("/api/settings", (req, res) => {
  const settings = {};
  const rows = db.prepare("SELECT key, value FROM settings").all();
  rows.forEach((r) => (settings[r.key] = r.value));
  res.json(settings);
});

app.put("/api/settings", (req, res) => {
  const updates = req.body;
  const upsert = db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)");
  const now = new Date().toISOString();
  Object.entries(updates).forEach(([key, value]) => {
    upsert.run(key, String(value), now);
  });
  logActivity("settings_updated", `Settings updated: ${Object.keys(updates).join(", ")}`);
  res.json({ success: true });
});

// ─── Connection Status API ───────────────────────────────
app.get("/api/connections", async (req, res) => {
  const spokeConfigured = !!process.env.SPOKE_API_KEY;
  const quoConfigured = !!process.env.QUO_API_KEY;

  let quoLive = false;
  if (quoConfigured) {
    try {
      quoLive = await getQuoStatus();
    } catch (e) {
      quoLive = false;
    }
  }

  res.json({
    spoke: { configured: spokeConfigured, webhookUrl: `${req.protocol}://${req.get("host")}/api/spoke/webhook` },
    quo: { configured: quoConfigured, live: quoLive },
  });
});

// ─── Quo Reply Webhook (YES/NO/rescheduling responses) ───
// Configure in Quo: Webhooks → message.received
// URL: https://your-app.up.railway.app/api/quo/webhook
app.post("/api/quo/webhook", async (req, res) => {
  console.log("[Quo Webhook] Received:", JSON.stringify(req.body).substring(0, 300));

  try {
    const event = req.body;
    const type = event.type || event.data?.type;

    // Only handle incoming messages
    if (type === "message.received" || event.data?.object?.direction === "incoming") {
      const message = event.data?.object || event.data || {};
      const from = message.from || message.identifier || "";
      const rawBody = (message.text || message.body || message.content || "").trim();
      const body = rawBody.toUpperCase();

      if (!from || !rawBody) {
        return res.status(200).json({ received: true });
      }

      // Clean the phone number for matching
      let cleanFrom = from.replace(/[^\d+]/g, "");
      if (cleanFrom.length === 10) cleanFrom = "+1" + cleanFrom;
      if (cleanFrom.length === 11 && cleanFrom.startsWith("1")) cleanFrom = "+" + cleanFrom;

      // ─── Check if this customer is mid-rescheduling ───
      const reschedulingNotif = db.prepare(
        "SELECT * FROM notifications WHERE phone = ? AND conversation_state = 'rescheduling' ORDER BY updated_at DESC LIMIT 1"
      ).get(cleanFrom);

      if (reschedulingNotif) {
        console.log(`[Quo Webhook] ${reschedulingNotif.customer_name} is rescheduling — routing to Claude`);

        // Handle STOP even during rescheduling
        if (body === "STOP") {
          db.prepare("UPDATE notifications SET customer_response = 'stop', conversation_state = 'none', updated_at = ? WHERE id = ?")
            .run(new Date().toISOString(), reschedulingNotif.id);
          logActivity("customer_optout", `${reschedulingNotif.customer_name} opted out during rescheduling (STOP)`, reschedulingNotif.id);
          try {
            await sendSms(cleanFrom, "You've been opted out of delivery notifications from Mattress Overstock. Thank you!");
          } catch (e) { console.error("[Quo Webhook] Failed to send STOP reply:", e.message); }
          return res.status(200).json({ received: true });
        }

        // Process through Claude
        const result = await handleRescheduleMessage(reschedulingNotif, rawBody);

        // Send Claude's reply
        try {
          await sendSms(cleanFrom, result.reply);
          console.log(`[Quo Webhook] Reschedule reply sent to ${reschedulingNotif.customer_name}: ${result.reply.substring(0, 80)}...`);
        } catch (e) {
          console.error("[Quo Webhook] Failed to send reschedule reply:", e.message);
        }

        return res.status(200).json({ received: true });
      }

      // ─── Normal YES/NO/STOP flow ───
      const notification = db.prepare(
        "SELECT * FROM notifications WHERE phone = ? AND status = 'sent' ORDER BY sent_at DESC LIMIT 1"
      ).get(cleanFrom);

      if (!notification) {
        console.log(`[Quo Webhook] No matching notification for ${cleanFrom.substring(0, 6)}****`);
        return res.status(200).json({ received: true });
      }

      if (body === "YES") {
        db.prepare(
          "UPDATE notifications SET customer_response = 'yes', response_at = ?, status = 'delivered', updated_at = ? WHERE id = ?"
        ).run(new Date().toISOString(), new Date().toISOString(), notification.id);

        logActivity("customer_confirmed", `${notification.customer_name} replied YES — delivery confirmed`, notification.id);
        console.log(`[Quo Webhook] ${notification.customer_name} confirmed delivery (YES)`);

        // Auto-reply confirmation
        try {
          await sendSms(cleanFrom, `Thank you! Your delivery is confirmed for tomorrow ${notification.time_window}. See you then!`);
          logActivity("auto_reply_sent", `Confirmation reply sent to ${notification.customer_name}`, notification.id);
        } catch (e) {
          console.error("[Quo Webhook] Failed to send YES auto-reply:", e.message);
        }

      } else if (body === "NO") {
        db.prepare(
          "UPDATE notifications SET customer_response = 'no', response_at = ?, updated_at = ? WHERE id = ?"
        ).run(new Date().toISOString(), new Date().toISOString(), notification.id);

        logActivity("customer_declined", `${notification.customer_name} replied NO — needs rescheduling`, notification.id);
        console.log(`[Quo Webhook] ${notification.customer_name} declined delivery (NO)`);

        // Start AI rescheduling conversation
        try {
          const reschedResult = await startRescheduleConversation(notification);
          await sendSms(cleanFrom, reschedResult.reply);
          logActivity("reschedule_started", `AI rescheduling started for ${notification.customer_name}`, notification.id);
        } catch (e) {
          console.error("[Quo Webhook] Failed to start rescheduling:", e.message);
          try {
            await sendSms(cleanFrom, "We understand you can't make the scheduled delivery. Please call us at (859) 555-0100 to reschedule.");
          } catch (e2) { console.error("[Quo Webhook] Failed to send fallback reply:", e2.message); }
        }

      } else if (body === "STOP") {
        db.prepare(
          "UPDATE notifications SET customer_response = 'stop', response_at = ?, updated_at = ? WHERE id = ?"
        ).run(new Date().toISOString(), new Date().toISOString(), notification.id);

        logActivity("customer_optout", `${notification.customer_name} opted out (STOP)`, notification.id);

        // Auto-reply opt-out confirmation
        try {
          await sendSms(cleanFrom, `You've been opted out of delivery notifications from Mattress Overstock. Thank you!`);
          logActivity("auto_reply_sent", `Opt-out reply sent to ${notification.customer_name}`, notification.id);
        } catch (e) {
          console.error("[Quo Webhook] Failed to send STOP auto-reply:", e.message);
        }
      } else {
        console.log(`[Quo Webhook] Unrecognized response from ${notification.customer_name}: "${rawBody}"`);
        logActivity("unrecognized_reply", `${notification.customer_name} sent unrecognized reply: "${rawBody.substring(0, 100)}"`, notification.id);
      }
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error("[Quo Webhook] Error:", err.message);
    res.status(200).json({ received: true, error: err.message });
  }
});

// ─── Scheduler API ───────────────────────────────────────
app.get("/api/scheduler", (req, res) => {
  res.json(getSchedulerStatus());
});

// Manual trigger for the daily send (for testing or catch-up)
app.post("/api/scheduler/send-now", async (req, res) => {
  try {
    const results = await executeDailySend();
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual trigger for the 9 PM staff summary
app.post("/api/scheduler/summary-now", async (req, res) => {
  try {
    await executeStaffSummary();
    res.json({ success: true, message: "Staff summary sent" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual route sync
app.post("/api/sync", async (req, res) => {
  try {
    const results = await syncRoutes(req.body?.date);
    res.json({ success: true, ...results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Plan Management ────────────────────────────────────
app.get("/api/plans", (req, res) => {
  res.json(getTrackedPlans());
});

app.post("/api/plans", (req, res) => {
  const { planId, deliveryDate, label } = req.body;
  if (!planId || !deliveryDate) {
    return res.status(400).json({ error: "planId and deliveryDate required" });
  }
  // Normalize: ensure it starts with "plans/"
  const normalized = planId.startsWith("plans/") ? planId : `plans/${planId}`;
  const ok = registerPlan(normalized, deliveryDate, label);
  if (ok) {
    res.json({ success: true, planId: normalized, deliveryDate });
  } else {
    res.status(500).json({ error: "Failed to register plan" });
  }
});

// ─── Reschedule Conversations ────────────────────────────
app.get("/api/conversations/:notificationId", (req, res) => {
  const messages = db.prepare(
    "SELECT * FROM reschedule_conversations WHERE notification_id = ? ORDER BY created_at ASC"
  ).all(req.params.notificationId);
  res.json(messages);
});

// Restore notifications from backup
app.post("/api/restore", express.json({ limit: "5mb" }), (req, res) => {
  try {
    const notifications = req.body.notifications || req.body;
    if (!Array.isArray(notifications)) {
      return res.status(400).json({ error: "Expected { notifications: [...] } or an array" });
    }

    const insert = db.prepare(
      `INSERT OR IGNORE INTO notifications
      (customer_name, phone, store, address, scheduled_date, time_window, raw_delivery_time,
       product, driver, status, sent_at, quo_message_id, spoke_stop_id, spoke_route_id,
       customer_response, response_at, error_message, retry_count,
       created_at, updated_at, review_sent_at, conversation_state, reschedule_count, rescheduled_from)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    let restored = 0;
    for (const n of notifications) {
      try {
        insert.run(
          n.customer_name, n.phone, n.store, n.address, n.scheduled_date, n.time_window, n.raw_delivery_time,
          n.product, n.driver, n.status, n.sent_at, n.quo_message_id, n.spoke_stop_id, n.spoke_route_id,
          n.customer_response, n.response_at, n.error_message, n.retry_count || 0,
          n.created_at, n.updated_at, n.review_sent_at, n.conversation_state || "none", n.reschedule_count || 0, n.rescheduled_from
        );
        restored++;
      } catch (err) {
        console.log("[Restore] Skipped:", n.customer_name, err.message);
      }
    }

    logActivity("data_restored", `Restored ${restored} notifications from backup`);
    res.json({ success: true, restored });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// ─── POS CSV Upload Routes ────────────────────────────────
// ═══════════════════════════════════════════════════════════

// Upload POS CSV — preview or send review requests
app.post("/api/pos-upload", async (req, res) => {
  try {
    // Accept CSV as raw text body (Content-Type: text/csv) or JSON { csv: "..." }
    let csvText;
    if (typeof req.body === "string") {
      csvText = req.body;
    } else if (req.body && req.body.csv) {
      csvText = req.body.csv;
    } else {
      return res.status(400).json({ error: "No CSV data provided. Send as text/csv body or JSON { csv: '...' }" });
    }

    const isPreview = req.query.preview === "true";

    // Optional: list of sale numbers to exclude (customer removed from preview)
    const excludeSales = new Set(
      Array.isArray(req.body?.exclude) ? req.body.exclude.map(String) : []
    );

    // Parse the CSV
    let parsedSales = parsePosCsv(csvText);
    const totalParsedLines = csvText.split(/\r?\n/).filter((l) => l.trim()).length;

    // Filter out excluded customers
    if (excludeSales.size > 0) {
      parsedSales = parsedSales.filter((s) => !excludeSales.has(s.sale_number));
    }

    // Deduplicate against existing data
    const toSend = [];
    const skipped = [];
    const seenPhones = new Set();
    const now = new Date();
    const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();

    for (const sale of parsedSales) {
      // Skip if phone already seen in this upload batch
      if (seenPhones.has(sale.phone)) {
        skipped.push({ customer_name: sale.customer_name, reason: `Duplicate phone in upload (sale #${sale.sale_number})` });
        continue;
      }

      // Check: same phone + sale number already in sale_reviews
      const existingExact = db.prepare(
        "SELECT id FROM sale_reviews WHERE phone = ? AND sale_number = ?"
      ).get(sale.phone, sale.sale_number);
      if (existingExact) {
        skipped.push({ customer_name: sale.customer_name, reason: `Already reviewed (sale #${sale.sale_number})` });
        continue;
      }

      // Check: same phone got ANY sale_reviews entry in last 7 days
      const recentSaleReview = db.prepare(
        "SELECT id FROM sale_reviews WHERE phone = ? AND created_at >= ? LIMIT 1"
      ).get(sale.phone, sevenDaysAgo);
      if (recentSaleReview) {
        skipped.push({ customer_name: sale.customer_name, reason: "Recent review sent (last 7 days)" });
        continue;
      }

      // Check: same phone has notifications.review_sent_at in last 7 days
      const recentDeliveryReview = db.prepare(
        "SELECT id FROM notifications WHERE phone = ? AND review_sent_at IS NOT NULL AND review_sent_at >= ? LIMIT 1"
      ).get(sale.phone, sevenDaysAgo);
      if (recentDeliveryReview) {
        skipped.push({ customer_name: sale.customer_name, reason: "Delivery review already sent (last 7 days)" });
        continue;
      }

      seenPhones.add(sale.phone);
      toSend.push(sale);
    }

    const deliveryCustomers = toSend.filter((s) => s.has_delivery).length;
    const carryOutCustomers = toSend.filter((s) => !s.has_delivery).length;

    // Preview mode — return what would be sent
    if (isPreview) {
      return res.json({
        preview: true,
        parsed_total: totalParsedLines,
        unique_sales: parsedSales.length,
        to_send: toSend.map((s) => ({
          sale_number: s.sale_number,
          customer_name: s.customer_name,
          phone: s.phone,
          store: s.store,
          has_delivery: s.has_delivery,
          products: s.products,
          type: s.has_delivery ? "delivery" : "carry_out",
        })),
        skipped,
        delivery_customers: deliveryCustomers,
        carry_out_customers: carryOutCustomers,
      });
    }

    // Send mode — process each customer
    const baseUrl = process.env.SHORT_BASE_URL || `${req.protocol}://${req.get("host")}`;
    const results = [];
    let sentCount = 0;
    let failedCount = 0;

    for (const sale of toSend) {
      try {
        const result = await processSaleReview({
          customerName: sale.customer_name,
          phone: sale.phone,
          saleNumber: sale.sale_number,
          baseUrl,
          saleDate: sale.sale_date,
        });
        results.push({
          customer_name: sale.customer_name,
          status: "sent",
          tracking_id: result.saleReview?.trackingId || null,
        });
        sentCount++;
      } catch (err) {
        results.push({
          customer_name: sale.customer_name,
          status: "failed",
          error: err.message,
        });
        failedCount++;
      }
    }

    // Add skipped customers to results
    for (const s of skipped) {
      results.push({
        customer_name: s.customer_name,
        status: "skipped",
        reason: s.reason,
      });
    }

    // Log the upload
    const filename = req.headers["x-filename"] || "pos-upload.csv";
    try {
      db.prepare(
        "INSERT INTO pos_uploads (filename, total_parsed, total_sent, total_skipped, total_failed, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(filename, parsedSales.length, sentCount, skipped.length, failedCount, new Date().toISOString());
    } catch (e) {
      console.error("[POS Upload] Failed to log upload:", e.message);
    }

    logActivity("pos_upload", `POS CSV uploaded: ${sentCount} sent, ${skipped.length} skipped, ${failedCount} failed`);

    res.json({
      preview: false,
      sent: sentCount,
      failed: failedCount,
      skipped: skipped.length,
      results,
    });
  } catch (err) {
    console.error("[POS Upload] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get POS upload history
app.get("/api/pos-uploads", (req, res) => {
  try {
    const uploads = db.prepare(
      "SELECT * FROM pos_uploads ORDER BY created_at DESC LIMIT 20"
    ).all();
    res.json(uploads);
  } catch (e) {
    res.json([]);
  }
});

// ═══════════════════════════════════════════════════════════
// ─── Sale Review Routes (Day-of-Sale Review Solicitation) ─
// ═══════════════════════════════════════════════════════════

// Submit a new day-of-sale review request
app.post("/api/reviews/sale", async (req, res) => {
  const { customerName, phone, saleNumber } = req.body;

  if (!customerName || !phone || !saleNumber) {
    return res.status(400).json({ error: "customerName, phone, and saleNumber are required" });
  }

  try {
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const result = await processSaleReview({ customerName, phone, saleNumber, baseUrl });
    res.json(result);
  } catch (err) {
    console.error("[SaleReview] Error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

// List all sale reviews (with optional filters)
app.get("/api/reviews/sale", (req, res) => {
  const { store, status, limit = 50, offset = 0 } = req.query;
  let query = "SELECT * FROM sale_reviews WHERE 1=1";
  const params = [];

  if (store) {
    query += " AND store = ?";
    params.push(store);
  }
  if (status) {
    query += " AND status = ?";
    params.push(status);
  }

  query += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
  params.push(Number(limit), Number(offset));

  const reviews = db.prepare(query).all(...params);
  const total = db
    .prepare(query.replace(/SELECT \*/, "SELECT COUNT(*) as count").replace(/ORDER BY.*/, ""))
    .get(...params.slice(0, -2));

  res.json({ reviews, total: total.count });
});

// Delete a sale review
app.delete("/api/reviews/sale/:id", (req, res) => {
  const review = db.prepare("SELECT * FROM sale_reviews WHERE id = ?").get(req.params.id);
  if (!review) return res.status(404).json({ error: "Not found" });
  db.prepare("DELETE FROM sale_reviews WHERE id = ?").run(req.params.id);
  logActivity("sale_review_deleted", `Deleted sale review: ${review.customer_name} (Sale #${review.sale_number})`);
  res.json({ success: true, deleted: review.id });
});

// Comparison data: sale vs delivery review performance
app.get("/api/reviews/comparison", (req, res) => {
  try {
    const data = getComparisonData();
    res.json(data);
  } catch (err) {
    console.error("[SaleReview] Comparison error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Tracked Redirect Endpoint ───────────────────────────
// Short URL that logs the click, then redirects to the actual Google review page
app.get("/r/:trackingId", (req, res) => {
  const { trackingId } = req.params;
  const reviewUrl = recordClick(trackingId);

  if (reviewUrl) {
    console.log(`[Redirect] Click tracked: ${trackingId} → ${reviewUrl}`);
    return res.redirect(302, reviewUrl);
  }

  // Fallback: if tracking ID not found, redirect to a generic page
  console.log(`[Redirect] Unknown tracking ID: ${trackingId}`);
  res.redirect(302, "https://mattressoverstock.com");
});

// ─── Catch-all: serve dashboard ──────────────────────────
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

// ─── Helper ──────────────────────────────────────────────
function logActivity(type, detail, notificationId = null) {
  db.prepare("INSERT INTO activity_log (type, detail, notification_id, created_at) VALUES (?, ?, ?, ?)")
    .run(type, detail, notificationId, new Date().toISOString());
}

// Make logActivity available to other modules
app.locals.logActivity = logActivity;

// ─── Start Server ────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║   Mattress Overstock — Delivery Notification Server      ║
║   Running on port ${PORT}                                    ║
║                                                           ║
║   Spoke Webhook: /api/spoke/webhook                       ║
║   Quo Replies:   /api/quo/webhook                         ║
║   Dashboard:     http://localhost:${PORT}                    ║
║                                                           ║
║   SCHEDULE: 6 PM EST Mon–Fri (for Tue–Sat deliveries)    ║
║   SYNC:     Every 15 min, 8 AM – 6 PM EST               ║
║                                                           ║
║   Spoke API:   ${process.env.SPOKE_API_KEY ? "✓ Configured" : "✗ Missing — set SPOKE_API_KEY"}       ║
║   Quo API:     ${process.env.QUO_API_KEY ? "✓ Configured" : "✗ Missing — set QUO_API_KEY"}         ║
╚═══════════════════════════════════════════════════════════╝
  `);

  // Start the 6 PM EST daily scheduler
  startScheduler();

  // Start auto-sync (every 15 min, 8 AM – 6 PM EST)
  startAutoSync();
});
