/**
 * Daily Scheduler — 6 PM EST Send + 9 PM AI Staff Summary
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
 * 9 PM STAFF SUMMARY:
 *   Uses Claude (Sonnet 4.5) to generate a natural, conversational
 *   SMS recap of tomorrow's deliveries for the scheduling team.
 *   Falls back to a simple template if the API call fails.
 *
 * This uses a simple interval check rather than a cron dependency.
 * Checks every minute if it's time to fire.
 */

const db = require("../database");
const fetch = require("node-fetch");
const { sendSms } = require("./quo");
const { getSmsBody, isSendDay } = require("./templates");

const SEND_HOUR = 18; // 6 PM
const SEND_MINUTE = 0;
const SUMMARY_HOUR = 21; // 9 PM
const SUMMARY_MINUTE = 0;
const CHECK_INTERVAL_MS = 60 * 1000; // check every minute

const STAFF_PHONES = ["+18593336243", "+19316500631"];

let lastSendDate = null; // prevent double-sends on the same day
let lastSummaryDate = null; // prevent double-summaries on the same day

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
  console.log(`[Scheduler] Customer SMS: 6:00 PM EST | Staff summary: 9:00 PM EST`);

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
 * Check if it's time to send the 9 PM staff summary.
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
 * Call Claude API to generate a natural staff summary message.
 */
async function generateSummaryWithClaude(data) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log("[Scheduler] No ANTHROPIC_API_KEY — falling back to template summary");
    return null;
  }

  const systemPrompt = `You are a dispatcher assistant for Mattress Overstock, a mattress delivery company in Kentucky. 
Write a brief SMS summary for the scheduling staff about tomorrow's deliveries.

RULES:
- Keep it under 300 characters if possible, max 450
- Be conversational but informative — this is a text to coworkers, not a formal report
- Lead with the most important info (total deliveries, confirmation status)
- Call out anything that needs attention: declines, no-replies, active rescheduling, failed sends
- If everyone confirmed, keep it short and upbeat
- If no deliveries, keep it very brief
- No emojis. No hashtags. Use plain text formatting
- Include the date and day of the week
- If there are per-store details worth noting, mention them briefly
- Sign off as "MO Delivery AI 1.0"`;

  const userMessage = `Generate a staff summary SMS for tomorrow's deliveries based on this data:

${JSON.stringify(data, null, 2)}`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5-20250929",
        max_tokens: 300,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("[Scheduler] Claude API error:", res.status, errText.substring(0, 500));
      return null;
    }

    const responseData = await res.json();
    const text = responseData.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");

    console.log("[Scheduler] Claude summary:", text);
    return text.trim();
  } catch (e) {
    console.error("[Scheduler] Claude API fetch error:", e.message);
    return null;
  }
}

/**
 * 9 PM Staff Summary (AI-Generated)
 *
 * Gathers delivery stats and per-store breakdowns, then uses Claude
 * to write a natural, conversational SMS summary for scheduling staff.
 * Falls back to a simple template if the API call fails.
 */
async function executeStaffSummary() {
  const now = getESTNow();
  const today = now.toISOString().split("T")[0];

  // Tomorrow's date
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split("T")[0];
  const tomorrowDisplay = tomorrow.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  console.log(`\n[Scheduler] ═══════════════════════════════════════`);
  console.log(`[Scheduler] 9 PM Staff Summary triggered`);
  console.log(`[Scheduler] Summary for deliveries on: ${tomorrowStr}`);

  // ─── Gather overall stats ───
  const total = db.prepare("SELECT COUNT(*) as count FROM notifications WHERE scheduled_date = ? AND status != 'cancelled'").get(tomorrowStr).count;
  const sent = db.prepare("SELECT COUNT(*) as count FROM notifications WHERE scheduled_date = ? AND status IN ('sent','delivered')").get(tomorrowStr).count;
  const confirmed = db.prepare("SELECT COUNT(*) as count FROM notifications WHERE scheduled_date = ? AND customer_response = 'yes'").get(tomorrowStr).count;
  const declined = db.prepare("SELECT COUNT(*) as count FROM notifications WHERE scheduled_date = ? AND customer_response = 'no'").get(tomorrowStr).count;
  const noReply = sent - confirmed - declined;
  const pending = db.prepare("SELECT COUNT(*) as count FROM notifications WHERE scheduled_date = ? AND status = 'pending'").get(tomorrowStr).count;
  const failed = db.prepare("SELECT COUNT(*) as count FROM notifications WHERE scheduled_date = ? AND status = 'failed'").get(tomorrowStr).count;
  const rescheduling = db.prepare("SELECT COUNT(*) as count FROM notifications WHERE scheduled_date = ? AND conversation_state = 'rescheduling'").get(tomorrowStr).count;

  // ─── Per-store breakdown ───
  const storeBreakdown = db.prepare(`
    SELECT store,
      COUNT(*) as total,
      SUM(CASE WHEN customer_response = 'yes' THEN 1 ELSE 0 END) as confirmed,
      SUM(CASE WHEN customer_response = 'no' THEN 1 ELSE 0 END) as declined,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
    FROM notifications
    WHERE scheduled_date = ? AND status != 'cancelled'
    GROUP BY store
  `).all(tomorrowStr);

  // ─── Notable details (who declined, who's rescheduling, who hasn't replied) ───
  const declinedCustomers = db.prepare(
    "SELECT customer_name, store FROM notifications WHERE scheduled_date = ? AND customer_response = 'no'"
  ).all(tomorrowStr);

  const reschedulingCustomers = db.prepare(
    "SELECT customer_name, store FROM notifications WHERE scheduled_date = ? AND conversation_state = 'rescheduling'"
  ).all(tomorrowStr);

  const noReplyCustomers = db.prepare(
    "SELECT customer_name, store FROM notifications WHERE scheduled_date = ? AND status IN ('sent','delivered') AND customer_response IS NULL"
  ).all(tomorrowStr);

  // ─── Build data payload for Claude ───
  const summaryData = {
    date: tomorrowDisplay,
    dateStr: tomorrowStr,
    overall: { total, sent, confirmed, declined, noReply, pending, failed, rescheduling },
    byStore: storeBreakdown,
    declinedCustomers: declinedCustomers.map(c => `${c.customer_name} (${c.store})`),
    reschedulingCustomers: reschedulingCustomers.map(c => `${c.customer_name} (${c.store})`),
    noReplyCustomers: noReplyCustomers.map(c => `${c.customer_name} (${c.store})`),
  };

  // ─── Generate summary with Claude ───
  let message = await generateSummaryWithClaude(summaryData);

  // ─── Fallback if Claude fails ───
  if (!message) {
    console.log("[Scheduler] Using fallback template for staff summary");
    message = `MATTRESS OVERSTOCK\n`;
    message += `${tomorrowDisplay}\n`;
    message += `━━━━━━━━━━━━━━━━━━\n`;
    message += `${total} Deliveries on deck\n\n`;
    message += `${confirmed} Confirmed\n`;
    message += `${declined} Declined\n`;
    message += `${noReply} Awaiting reply\n`;

    if (pending > 0) message += `${pending} Not yet sent\n`;
    if (rescheduling > 0) message += `${rescheduling} Rescheduling\n`;

    if (confirmed === total && total > 0) {
      message += `\nAll confirmed. Let's roll.`;
    } else if (noReply > 0) {
      message += `\n${noReply} still haven't replied.`;
    }

    if (total === 0) {
      message = `MATTRESS OVERSTOCK\n${tomorrowDisplay}\n━━━━━━━━━━━━━━━━━━\nNo deliveries tomorrow. Enjoy the break.`;
    }
  }

  // ─── Send to each staff member ───
  let sentCount = 0;
  for (const phone of STAFF_PHONES) {
    try {
      await sendSms(phone, message);
      console.log(`[Scheduler] Staff summary sent to ${phone}`);
      sentCount++;
    } catch (err) {
      console.error(`[Scheduler] Failed to send summary to ${phone}:`, err.message);
    }
  }

  logActivity("staff_summary_sent", `9 PM summary sent to ${sentCount} staff — ${confirmed} confirmed, ${declined} declined, ${noReply} no reply for ${tomorrowStr}`);

  console.log(`[Scheduler] Staff summary complete — sent to ${sentCount} recipients`);
  console.log(`[Scheduler] ═══════════════════════════════════════\n`);

  lastSummaryDate = today;
  return { sent: sentCount };
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

module.exports = { startScheduler, executeDailySend, executeStaffSummary, getSchedulerStatus };
