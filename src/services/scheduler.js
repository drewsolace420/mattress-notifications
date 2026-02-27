/**
 * Daily Scheduler
 *
 * TWO SCHEDULED EVENTS:
 *
 * 1) 6:00 PM EST (Mon–Fri) — Customer SMS
 *    Sends delivery confirmation texts for tomorrow's stops.
 *
 * 2) 9:00 PM EST (Mon–Fri) — Staff Summary
 *    Sends a summary text to the scheduling staff member with:
 *    - Confirmed stops (replied YES)
 *    - Declined stops (replied NO)
 *    - No-reply stops (sent but no response)
 *    - Pending stops (not yet sent, if any)
 *
 * SCHEDULE:
 *   Monday    → Tuesday deliveries
 *   Tuesday   → Wednesday deliveries
 *   Wednesday → Thursday deliveries
 *   Thursday  → Friday deliveries
 *   Friday    → Saturday deliveries
 *   Saturday  → NO SEND
 *   Sunday    → NO SEND
 */

const db = require("../database");
const { sendSms } = require("./quo");
const { getSmsBody, isSendDay } = require("./templates");

const SEND_HOUR = 18; // 6 PM — customer texts
const SEND_MINUTE = 0;
const SUMMARY_HOUR = 21; // 9 PM — staff summary
const SUMMARY_MINUTE = 0;
const CHECK_INTERVAL_MS = 60 * 1000; // check every minute

const STAFF_PHONE = "+18593336243";

let lastSendDate = null;    // prevent double customer sends
let lastSummaryDate = null; // prevent double summary sends

/**
 * Get current time in EST/EDT
 */
function getESTNow() {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/New_York" })
  );
}

/**
 * Check if it's time to send customer texts (6 PM EST on a weekday)
 */
function shouldSendNow() {
  const now = getESTNow();
  const today = now.toISOString().split("T")[0];

  if (lastSendDate === today) return false;
  if (!isSendDay(now)) return false;
  if (now.getHours() === SEND_HOUR && now.getMinutes() >= SEND_MINUTE) {
    return true;
  }
  return false;
}

/**
 * Check if it's time to send the staff summary (9 PM EST on a weekday)
 */
function shouldSendSummary() {
  const now = getESTNow();
  const today = now.toISOString().split("T")[0];

  if (lastSummaryDate === today) return false;
  if (!isSendDay(now)) return false;
  if (now.getHours() === SUMMARY_HOUR && now.getMinutes() >= SUMMARY_MINUTE) {
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

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split("T")[0];

  console.log(`\n[Scheduler] ═══════════════════════════════════════`);
  console.log(`[Scheduler] Daily send triggered at 6 PM EST`);
  console.log(`[Scheduler] Sending for deliveries on: ${tomorrowStr}`);

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

/**
 * Execute the 9 PM staff summary.
 * Sends a text to the staff member summarizing tomorrow's delivery status.
 */
async function executeStaffSummary() {
  const now = getESTNow();
  const today = now.toISOString().split("T")[0];

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split("T")[0];

  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const tomorrowDay = dayNames[tomorrow.getDay()];
  const tomorrowFormatted = tomorrow.toLocaleDateString("en-US", { month: "short", day: "numeric" });

  console.log(`\n[Scheduler] ═══════════════════════════════════════`);
  console.log(`[Scheduler] Staff summary triggered at 9 PM EST`);
  console.log(`[Scheduler] Summary for deliveries on: ${tomorrowStr}`);

  // Get all notifications for tomorrow
  const all = db
    .prepare("SELECT * FROM notifications WHERE scheduled_date = ?")
    .all(tomorrowStr);

  if (all.length === 0) {
    console.log(`[Scheduler] No deliveries scheduled for ${tomorrowStr} — skipping summary`);
    logActivity("summary_skipped", `No deliveries for ${tomorrowStr} — no summary sent`);
    lastSummaryDate = today;
    return;
  }

  // Categorize
  const confirmed = all.filter(n => n.customer_response === "yes");
  const declined = all.filter(n => n.customer_response === "no");
  const noReply = all.filter(n => n.status === "sent" && !n.customer_response);
  const pending = all.filter(n => n.status === "pending");
  const failed = all.filter(n => n.status === "failed");

  // Build summary message
  let msg = `Delivery Summary for ${tomorrowDay}, ${tomorrowFormatted}\n`;
  msg += `${all.length} total stop${all.length !== 1 ? "s" : ""}\n`;
  msg += `─────────────\n`;

  if (confirmed.length > 0) {
    msg += `\n✅ CONFIRMED (${confirmed.length}):\n`;
    for (const n of confirmed) {
      msg += `• ${n.customer_name} — ${n.time_window}`;
      if (n.address) msg += ` — ${n.address}`;
      msg += `\n`;
    }
  }

  if (declined.length > 0) {
    msg += `\n❌ DECLINED (${declined.length}):\n`;
    for (const n of declined) {
      msg += `• ${n.customer_name} — ${n.time_window}`;
      if (n.address) msg += ` — ${n.address}`;
      msg += ` ⚠️ NEEDS RESCHEDULE\n`;
    }
  }

  if (noReply.length > 0) {
    msg += `\n⏳ NO REPLY (${noReply.length}):\n`;
    for (const n of noReply) {
      msg += `• ${n.customer_name} — ${n.time_window}`;
      if (n.address) msg += ` — ${n.address}`;
      msg += `\n`;
    }
  }

  if (pending.length > 0) {
    msg += `\n🔸 NOT YET SENT (${pending.length}):\n`;
    for (const n of pending) {
      msg += `• ${n.customer_name} — ${n.time_window}`;
      if (n.address) msg += ` — ${n.address}`;
      msg += `\n`;
    }
  }

  if (failed.length > 0) {
    msg += `\n🔴 FAILED TO SEND (${failed.length}):\n`;
    for (const n of failed) {
      msg += `• ${n.customer_name} — ${n.phone}`;
      if (n.address) msg += ` — ${n.address}`;
      msg += `\n`;
    }
  }

  console.log(`[Scheduler] Summary message:\n${msg}`);

  // Send to staff
  try {
    await sendSms(STAFF_PHONE, msg);
    console.log(`[Scheduler] ✓ Staff summary sent to ${STAFF_PHONE}`);
    logActivity("staff_summary_sent", `9 PM summary sent — ${confirmed.length} confirmed, ${declined.length} declined, ${noReply.length} no reply, ${pending.length} pending, ${failed.length} failed`);
  } catch (err) {
    console.error(`[Scheduler] ✗ Failed to send staff summary:`, err.message);
    logActivity("staff_summary_failed", `Failed to send 9 PM summary: ${err.message}`);
  }

  console.log(`[Scheduler] ═══════════════════════════════════════\n`);
  lastSummaryDate = today;
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
 * Checks every minute for both 6 PM and 9 PM triggers.
 */
function startScheduler() {
  const now = getESTNow();
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  console.log(`[Scheduler] Started — checking every minute`);
  console.log(`[Scheduler] Current EST time: ${now.toLocaleString()}`);
  console.log(`[Scheduler] Today is ${dayNames[now.getDay()]} — ${isSendDay(now) ? "SEND DAY ✓" : "NO SEND (weekend)"}`);
  console.log(`[Scheduler] Customer SMS: 6:00 PM EST | Staff summary: 9:00 PM EST`);

  logActivity("scheduler_started", `Scheduler initialized — 6 PM customer send + 9 PM staff summary, Mon–Fri`);

  // Check immediately on startup
  checkAndSend();

  // Then check every minute
  setInterval(checkAndSend, CHECK_INTERVAL_MS);
}

async function checkAndSend() {
  // 6 PM — customer texts
  if (shouldSendNow()) {
    try {
      await executeDailySend();
    } catch (err) {
      console.error("[Scheduler] Fatal error during daily send:", err);
      logActivity("scheduler_error", `Fatal error: ${err.message}`);
    }
  }

  // 9 PM — staff summary
  if (shouldSendSummary()) {
    try {
      await executeStaffSummary();
    } catch (err) {
      console.error("[Scheduler] Fatal error during staff summary:", err);
      logActivity("scheduler_error", `Staff summary error: ${err.message}`);
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

  if (now.getHours() >= SEND_HOUR || !isSendDay(now)) {
    do {
      nextSend.setDate(nextSend.getDate() + 1);
    } while (!isSendDay(nextSend));
    nextSend.setHours(SEND_HOUR, SEND_MINUTE, 0, 0);
  }

  // Find next summary time
  let nextSummary = new Date(now);
  nextSummary.setHours(SUMMARY_HOUR, SUMMARY_MINUTE, 0, 0);

  if (now.getHours() >= SUMMARY_HOUR || !isSendDay(now)) {
    do {
      nextSummary.setDate(nextSummary.getDate() + 1);
    } while (!isSendDay(nextSummary));
    nextSummary.setHours(SUMMARY_HOUR, SUMMARY_MINUTE, 0, 0);
  }

  // Delivery date context
  const deliveryDate = new Date(nextSend);
  deliveryDate.setDate(deliveryDate.getDate() + 1);
  const deliveryStr = deliveryDate.toISOString().split("T")[0];

  const pendingCount = db
    .prepare("SELECT COUNT(*) as count FROM notifications WHERE status = 'pending' AND scheduled_date = ?")
    .get(deliveryStr)?.count || 0;

  return {
    currentTimeEST: now.toLocaleString("en-US", { timeZone: "America/New_York" }),
    todayIsSendDay: isSendDay(now),
    todayName: dayNames[now.getDay()],
    lastSendDate,
    lastSummaryDate,
    nextSendTime: nextSend.toLocaleString("en-US", { timeZone: "America/New_York" }),
    nextSendDay: dayNames[nextSend.getDay()],
    nextSummaryTime: nextSummary.toLocaleString("en-US", { timeZone: "America/New_York" }),
    nextDeliveryDate: deliveryStr,
    pendingForNextDelivery: pendingCount,
    staffPhone: STAFF_PHONE,
  };
}

module.exports = { startScheduler, executeDailySend, executeStaffSummary, getSchedulerStatus };
