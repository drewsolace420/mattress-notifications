/**
 * Daily Scheduler — 6 PM EST Send
 *
 * SCHEDULE:
 *   Monday 6 PM    → sends for Tuesday deliveries
 *   Tuesday 6 PM   → sends for Wednesday deliveries
 *   Wednesday 6 PM → sends for Thursday deliveries
 *   Thursday 6 PM  → sends for Friday deliveries
 *   Friday 6 PM    → sends for Saturday deliveries
 *   Saturday       → NO SEND (Sunday = no delivery)
 *   Sunday         → NO SEND (Monday = no delivery)
 *
 * This uses a simple interval check rather than a cron dependency.
 * Checks every minute if it's time to fire.
 */

const db = require("../database");
const { sendSms } = require("./quo");
const { getSmsBody, isSendDay } = require("./templates");

const SEND_HOUR = 18; // 6 PM
const SEND_MINUTE = 0;
const CHECK_INTERVAL_MS = 60 * 1000; // check every minute

let lastSendDate = null; // prevent double-sends on the same day

/**
 * Get current time in EST/EDT
 */
function getESTNow() {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/New_York" })
  );
}

/**
 * Check if it's time to send (6 PM EST on a weekday)
 * and we haven't already sent today.
 */
function shouldSendNow() {
  const now = getESTNow();
  const today = now.toISOString().split("T")[0];

  // Already sent today?
  if (lastSendDate === today) return false;

  // Is it a send day (Mon–Fri)?
  if (!isSendDay(now)) return false;

  // Is it 6 PM (or within the first minute of 6 PM)?
  if (now.getHours() === SEND_HOUR && now.getMinutes() >= SEND_MINUTE) {
    return true;
  }

  return false;
}

/**
 * Execute the daily send batch.
 * Finds all pending notifications for tomorrow and sends them.
 */
async function executeDailySend() {
  const now = getESTNow();
  const today = now.toISOString().split("T")[0];

  // Calculate tomorrow's date
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split("T")[0];

  console.log(`\n[Scheduler] ═══════════════════════════════════════`);
  console.log(`[Scheduler] Daily send triggered at 6 PM EST`);
  console.log(`[Scheduler] Sending for deliveries on: ${tomorrowStr}`);

  // Get all pending notifications for tomorrow
  const pending = db
    .prepare(
      "SELECT * FROM notifications WHERE status = 'pending' AND scheduled_date = ?"
    )
    .all(tomorrowStr);

  if (pending.length === 0) {
    console.log(`[Scheduler] No pending notifications for ${tomorrowStr}`);
    logActivity("scheduler_run", `Daily send — no pending notifications for ${tomorrowStr}`);
    lastSendDate = today;
    return { sent: 0, failed: 0 };
  }

  console.log(`[Scheduler] Found ${pending.length} notifications to send`);

  const results = { sent: 0, failed: 0, errors: [] };

  for (const notification of pending) {
    try {
      const smsBody = getSmsBody(notification);
      const result = await sendSms(notification.phone, smsBody);

      db.prepare(
        `UPDATE notifications
         SET status = 'sent', sent_at = ?, quo_message_id = ?, updated_at = ?
         WHERE id = ?`
      ).run(
        new Date().toISOString(),
        result.messageId || null,
        new Date().toISOString(),
        notification.id
      );

      logActivity(
        "sms_sent",
        `[6 PM Send] SMS sent to ${notification.customer_name}`,
        notification.id
      );
      results.sent++;

      // Small delay between sends to avoid rate limiting
      await sleep(500);
    } catch (err) {
      db.prepare(
        `UPDATE notifications
         SET status = 'failed', error_message = ?, retry_count = retry_count + 1, updated_at = ?
         WHERE id = ?`
      ).run(err.message, new Date().toISOString(), notification.id);

      logActivity(
        "sms_failed",
        `[6 PM Send] Failed for ${notification.customer_name}: ${err.message}`,
        notification.id
      );
      results.failed++;
      results.errors.push({ id: notification.id, error: err.message });
    }
  }

  console.log(`[Scheduler] Complete — Sent: ${results.sent}, Failed: ${results.failed}`);
  console.log(`[Scheduler] ═══════════════════════════════════════\n`);

  logActivity(
    "scheduler_complete",
    `Daily 6 PM send complete — ${results.sent} sent, ${results.failed} failed for ${tomorrowStr}`
  );

  lastSendDate = today;
  return results;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logActivity(type, detail, notificationId = null) {
  db.prepare(
    "INSERT INTO activity_log (type, detail, notification_id, created_at) VALUES (?, ?, ?, ?)"
  ).run(type, detail, notificationId, new Date().toISOString());
}

/**
 * Start the scheduler loop.
 * Checks every minute if it's time to send.
 */
function startScheduler() {
  const now = getESTNow();
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  console.log(`[Scheduler] Started — checking every minute`);
  console.log(`[Scheduler] Current EST time: ${now.toLocaleString()}`);
  console.log(`[Scheduler] Today is ${dayNames[now.getDay()]} — ${isSendDay(now) ? "SEND DAY ✓" : "NO SEND (weekend)"}`);
  console.log(`[Scheduler] Next send: 6:00 PM EST on next weekday`);

  logActivity("scheduler_started", `Scheduler initialized — send time: 6:00 PM EST, Mon–Fri`);

  // Check immediately on startup (in case server restarted after 6 PM)
  checkAndSend();

  // Then check every minute
  setInterval(checkAndSend, CHECK_INTERVAL_MS);
}

async function checkAndSend() {
  if (shouldSendNow()) {
    try {
      await executeDailySend();
    } catch (err) {
      console.error("[Scheduler] Fatal error during daily send:", err);
      logActivity("scheduler_error", `Fatal error: ${err.message}`);
    }
  }
}

/**
 * Get scheduler status for the dashboard
 */
function getSchedulerStatus() {
  const now = getESTNow();
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  // Find next send time
  let nextSend = new Date(now);
  nextSend.setHours(SEND_HOUR, SEND_MINUTE, 0, 0);

  // If past 6 PM today or not a send day, advance to next weekday
  if (now.getHours() >= SEND_HOUR || !isSendDay(now)) {
    do {
      nextSend.setDate(nextSend.getDate() + 1);
    } while (!isSendDay(nextSend));
    nextSend.setHours(SEND_HOUR, SEND_MINUTE, 0, 0);
  }

  // Tomorrow for delivery context
  const deliveryDate = new Date(nextSend);
  deliveryDate.setDate(deliveryDate.getDate() + 1);

  // Count pending for next delivery date
  const deliveryStr = deliveryDate.toISOString().split("T")[0];
  const pendingCount = db
    .prepare("SELECT COUNT(*) as count FROM notifications WHERE status = 'pending' AND scheduled_date = ?")
    .get(deliveryStr)?.count || 0;

  return {
    currentTimeEST: now.toLocaleString("en-US", { timeZone: "America/New_York" }),
    todayIsSendDay: isSendDay(now),
    todayName: dayNames[now.getDay()],
    lastSendDate,
    nextSendTime: nextSend.toLocaleString("en-US", { timeZone: "America/New_York" }),
    nextSendDay: dayNames[nextSend.getDay()],
    nextDeliveryDate: deliveryStr,
    pendingForNextDelivery: pendingCount,
  };
}

module.exports = { startScheduler, executeDailySend, getSchedulerStatus };
