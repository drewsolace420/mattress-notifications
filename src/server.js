require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const db = require("./database");
const { handleSpokeWebhook } = require("./webhooks/spoke");
const { sendSms, getQuoStatus } = require("./services/quo");
const { getSmsBody, isSendDay, isDeliveryDay } = require("./services/templates");
const { startScheduler, executeDailySend, getSchedulerStatus } = require("./services/scheduler");

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

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
    query += " AND status = ?";
    params.push(status);
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
  const pending = db.prepare("SELECT * FROM notifications WHERE status = 'pending'").all();
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
  res.json(template || { body: getSmsBody.DEFAULT_TEMPLATE });
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
  const { limit = 30 } = req.query;
  const logs = db.prepare("SELECT * FROM activity_log ORDER BY created_at DESC LIMIT ?").all(Number(limit));
  res.json(logs);
});

// ─── Stats API ───────────────────────────────────────────
app.get("/api/stats", (req, res) => {
  const today = new Date().toISOString().split("T")[0];
  const stats = {
    total: db.prepare("SELECT COUNT(*) as count FROM notifications").get().count,
    sent: db.prepare("SELECT COUNT(*) as count FROM notifications WHERE status = 'sent'").get().count,
    pending: db.prepare("SELECT COUNT(*) as count FROM notifications WHERE status = 'pending'").get().count,
    failed: db.prepare("SELECT COUNT(*) as count FROM notifications WHERE status = 'failed'").get().count,
    delivered: db.prepare("SELECT COUNT(*) as count FROM notifications WHERE status = 'delivered'").get().count,
    today: db.prepare("SELECT COUNT(*) as count FROM notifications WHERE scheduled_date = ?").get(today).count,
    confirmedYes: db.prepare("SELECT COUNT(*) as count FROM notifications WHERE customer_response = 'yes'").get().count,
    declinedNo: db.prepare("SELECT COUNT(*) as count FROM notifications WHERE customer_response = 'no'").get().count,
    scheduler: getSchedulerStatus(),
  };
  res.json(stats);
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

// ─── Quo Reply Webhook (YES/NO responses) ────────────────
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
      const body = (message.body || message.content || "").trim().toUpperCase();

      if (!from || !body) {
        return res.status(200).json({ received: true });
      }

      // Clean the phone number for matching
      let cleanFrom = from.replace(/[^\d+]/g, "");
      if (cleanFrom.length === 10) cleanFrom = "+1" + cleanFrom;
      if (cleanFrom.length === 11 && cleanFrom.startsWith("1")) cleanFrom = "+" + cleanFrom;

      // Find the most recent notification for this phone number
      const notification = db.prepare(
        "SELECT * FROM notifications WHERE phone = ? AND status = 'sent' ORDER BY sent_at DESC LIMIT 1"
      ).get(cleanFrom);

      if (!notification) {
        console.log(`[Quo Webhook] No matching sent notification for ${cleanFrom.substring(0, 6)}****`);
        return res.status(200).json({ received: true });
      }

      if (body === "YES") {
        db.prepare(
          "UPDATE notifications SET customer_response = 'yes', response_at = ?, status = 'delivered', updated_at = ? WHERE id = ?"
        ).run(new Date().toISOString(), new Date().toISOString(), notification.id);

        logActivity("customer_confirmed", `${notification.customer_name} replied YES — delivery confirmed`, notification.id);
        console.log(`[Quo Webhook] ${notification.customer_name} confirmed delivery (YES)`);
      } else if (body === "NO") {
        db.prepare(
          "UPDATE notifications SET customer_response = 'no', response_at = ?, updated_at = ? WHERE id = ?"
        ).run(new Date().toISOString(), new Date().toISOString(), notification.id);

        logActivity("customer_declined", `${notification.customer_name} replied NO — needs rescheduling`, notification.id);
        console.log(`[Quo Webhook] ${notification.customer_name} declined delivery (NO) — needs follow-up`);
      } else if (body === "STOP") {
        db.prepare(
          "UPDATE notifications SET customer_response = 'stop', updated_at = ? WHERE id = ?"
        ).run(new Date().toISOString(), notification.id);

        logActivity("customer_optout", `${notification.customer_name} opted out (STOP)`, notification.id);
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

// ─── Catch-all: serve dashboard ──────────────────────────
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

// ─── Helper ──────────────────────────────────────────────
function logActivity(type, detail, notificationId = null) {
  db.prepare("INSERT INTO activity_log (type, detail, notification_id, created_at) VALUES (?, ?, ?, ?)").run(
    type,
    detail,
    notificationId,
    new Date().toISOString()
  );
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
║                                                           ║
║   Spoke API:   ${process.env.SPOKE_API_KEY ? "✓ Configured" : "✗ Missing — set SPOKE_API_KEY"}       ║
║   Quo API:     ${process.env.QUO_API_KEY ? "✓ Configured" : "✗ Missing — set QUO_API_KEY"}         ║
╚═══════════════════════════════════════════════════════════╝
  `);

  // Start the 6 PM EST daily scheduler
  startScheduler();
});
