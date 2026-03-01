/**
 * Day-of-Sale Review Service
 *
 * Generates personalized Google review request messages using Claude Sonnet 4.5,
 * sends them via Quo SMS, and tracks click-throughs via redirect URLs.
 *
 * FLOW:
 *   1. Staff enters customer name, phone, sale number in dashboard
 *   2. Sale number prefix → store resolution (same 1-5 mapping)
 *   3. Claude Sonnet 4.5 generates a warm, personalized SMS
 *   4. Review link uses tracked redirect: /r/:trackingId → Google review page
 *   5. SMS sent immediately via Quo
 *
 * COMPARISON TRACKING:
 *   sale_reviews.review_source = "sale" (day of purchase)
 *   notifications.review_sent_at != NULL = "delivery" (post-delivery)
 *   Both track link clicks for conversion comparison
 */
const db = require("../database");
const { sendSms } = require("./quo");
const fetch = require("node-fetch");
const crypto = require("crypto");

// ─── Store mappings (mirrored from spoke.js) ─────────────
const SALE_PREFIX_TO_STORE = {
  "1": "other",
  "2": "lexington",
  "3": "georgetown",
  "4": "somerset",
  "5": "london",
};

const STORE_REVIEW_LINKS = {
  somerset: "https://g.page/r/CcHG8jVFzOK1EBM/review",
  lexington: "https://g.page/r/CRCnucIb-t91EBM/review",
  london: "https://g.page/r/CW69HHcXCceJEBM/review",
  georgetown: "https://g.page/r/CZQNrg3DMJIdEBM/review",
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
  const prefix = String(saleNumber).trim().charAt(0);
  return SALE_PREFIX_TO_STORE[prefix] || "unknown";
}

function cleanPhone(phone) {
  if (!phone) return "";
  let cleaned = phone.replace(/[^\d+]/g, "");
  if (cleaned.length === 10) cleaned = "+1" + cleaned;
  if (cleaned.length === 11 && cleaned.startsWith("1")) cleaned = "+" + cleaned;
  return cleaned;
}

function generateTrackingId() {
  // Short 6-char base36 ID (compact for SMS links)
  return crypto.randomBytes(4).toString("hex").substring(0, 6);
}

function logActivity(type, detail, notificationId = null) {
  db.prepare(
    "INSERT INTO activity_log (type, detail, notification_id, created_at) VALUES (?, ?, ?, ?)"
  ).run(type, detail, notificationId, new Date().toISOString());
}

/**
 * Compute a natural timing phrase based on when the sale happened.
 * Returns { timingContext, timingPrompt } for the AI prompt.
 */
function getSaleTimingContext(saleDate) {
  if (!saleDate) return { timingContext: "today", timingPrompt: "They visited the store today." };

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const sale = new Date(saleDate + "T12:00:00");
  sale.setHours(0, 0, 0, 0);
  const diffDays = Math.round((today - sale) / (1000 * 60 * 60 * 24));

  if (diffDays <= 0) {
    return { timingContext: "today", timingPrompt: "They visited the store today." };
  } else if (diffDays === 1) {
    return { timingContext: "yesterday", timingPrompt: "They visited the store yesterday." };
  } else if (diffDays <= 3) {
    return { timingContext: `${diffDays} days ago`, timingPrompt: `They visited the store ${diffDays} days ago.` };
  } else {
    return { timingContext: "recently", timingPrompt: "They visited the store recently." };
  }
}

/**
 * Generate a personalized review request message using Claude Sonnet 4.5
 *
 * @param {string} customerFirstName
 * @param {string} storeName
 * @param {string|null} saleDate - Optional YYYY-MM-DD sale date for timing context
 */
async function generateReviewMessage(customerFirstName, storeName, saleDate) {
  const { timingContext, timingPrompt } = getSaleTimingContext(saleDate);
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    // Fallback template if no API key
    console.log("[SaleReview] No ANTHROPIC_API_KEY — using template fallback");
    return `Hi ${customerFirstName}! Thank you for visiting ${storeName} ${timingContext}. We'd love to hear about your experience in the store — your review helps our small team a lot!`;
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5-20250929",
        max_tokens: 200,
        system: `You write short, warm SMS messages asking customers to leave a Google review for a mattress store. The review is about their IN-STORE shopping experience — the staff, the service, the atmosphere. Rules:
- Use the customer's first name naturally
- Mention the store name once
- Keep it under 250 characters (CRITICAL — this is an SMS)
- Sound human and genuine, not corporate or salesy
- Don't use exclamation marks more than once
- Don't use emojis
- Don't include any links — the link will be appended separately
- Don't say "click" or "tap" — just end with something natural that flows into a link
- Vary your messages — don't always start with "Hi" or "Hey"
- IMPORTANT: Focus on their shopping/store experience, NOT the product itself. They may not have received their mattress yet — do NOT mention delivery, sleeping on it, or how the mattress feels.
- The customer visited ${timingContext}. Use appropriate timing language — do NOT say "today" if they visited yesterday or earlier.`,
        messages: [
          {
            role: "user",
            content: `Write an SMS review request for ${customerFirstName} who shopped at ${storeName}. ${timingPrompt} Ask about their in-store experience. Keep it brief and warm.`,
          },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("[SaleReview] Claude API error:", response.status, errText.substring(0, 200));
      throw new Error(`Claude API returned ${response.status}`);
    }

    const data = await response.json();
    const aiMessage = data.content?.[0]?.text?.trim();
    if (!aiMessage) {
      throw new Error("Empty response from Claude");
    }

    console.log(`[SaleReview] Claude generated: "${aiMessage.substring(0, 80)}..."`);
    return aiMessage;
  } catch (err) {
    console.error("[SaleReview] Claude generation failed, using fallback:", err.message);
    return `Hi ${customerFirstName}! Thank you for visiting ${storeName} ${timingContext}. We'd love to hear about your experience in the store — your review helps our small team a lot!`;
  }
}

/**
 * Process a day-of-sale review request
 *
 * @param {object} params
 * @param {string} params.customerName - Full customer name
 * @param {string} params.phone - Customer phone number
 * @param {string} params.saleNumber - Sale number (prefix determines store)
 * @param {string} params.baseUrl - App base URL for building tracked redirect links
 * @param {string} [params.saleDate] - Optional YYYY-MM-DD sale date for AI timing context
 * @returns {object} { success, saleReview, message }
 */
async function processSaleReview({ customerName, phone, saleNumber, baseUrl, saleDate }) {
  const cleanedPhone = cleanPhone(phone);
  if (!cleanedPhone) {
    throw new Error("Invalid phone number");
  }
  if (!customerName || !customerName.trim()) {
    throw new Error("Customer name required");
  }
  if (!saleNumber || !String(saleNumber).trim()) {
    throw new Error("Sale number required");
  }

  const store = resolveStoreFromSaleNumber(saleNumber);
  if (store === "other" || store === "unknown") {
    throw new Error(`Sale number prefix "${String(saleNumber).charAt(0)}" maps to "${store}" — no Google review link available`);
  }

  const reviewLink = STORE_REVIEW_LINKS[store];
  if (!reviewLink) {
    throw new Error(`No Google review link configured for store: ${store}`);
  }

  const storeName = STORE_DISPLAY_NAMES[store];
  const firstName = customerName.trim().split(/\s+/)[0];

  // Check for duplicate (same phone + sale number)
  const existing = db.prepare(
    "SELECT id FROM sale_reviews WHERE phone = ? AND sale_number = ?"
  ).get(cleanedPhone, String(saleNumber).trim());
  if (existing) {
    throw new Error("Review request already sent for this sale");
  }

  // Generate tracking ID and tracked redirect URL
  const trackingId = generateTrackingId();
  const shortBase = process.env.SHORT_BASE_URL || baseUrl;
  const trackedLink = `${shortBase}/r/${trackingId}`;

  // Generate AI message via Claude Sonnet 4.5
  const aiMessage = await generateReviewMessage(firstName, storeName, saleDate || null);

  // Combine message + tracked link
  const fullMessage = `${aiMessage}\n${trackedLink}`;

  // Insert into database BEFORE sending (so we have the record even if send fails)
  const now = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO sale_reviews
    (customer_name, phone, sale_number, store, ai_message, tracking_id, review_url, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(customerName.trim(), cleanedPhone, String(saleNumber).trim(), store, aiMessage, trackingId, reviewLink, now, now);

  const saleReviewId = result.lastInsertRowid;

  // Send SMS via Quo
  try {
    const smsResult = await sendSms(cleanedPhone, fullMessage);

    db.prepare(
      "UPDATE sale_reviews SET status = 'sent', sent_at = ?, quo_message_id = ?, updated_at = ? WHERE id = ?"
    ).run(now, smsResult.messageId || null, now, saleReviewId);

    logActivity("sale_review_sent", `Day-of-sale review request sent to ${customerName} → ${storeName} (Sale #${saleNumber})`);
    console.log(`[SaleReview] ✓ Sent to ${customerName} (${store}) — tracking: ${trackingId}`);

    return {
      success: true,
      saleReview: {
        id: saleReviewId,
        customerName: customerName.trim(),
        phone: cleanedPhone,
        saleNumber: String(saleNumber).trim(),
        store,
        storeName,
        aiMessage,
        trackingId,
        trackedLink,
        status: "sent",
      },
      message: `Review request sent to ${firstName} (${storeName})`,
    };
  } catch (err) {
    db.prepare(
      "UPDATE sale_reviews SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?"
    ).run(err.message, now, saleReviewId);

    logActivity("sale_review_failed", `Failed to send sale review to ${customerName}: ${err.message}`);
    throw new Error(`SMS send failed: ${err.message}`);
  }
}

/**
 * Record a link click (called from redirect endpoint)
 */
function recordClick(trackingId) {
  const now = new Date().toISOString();

  // Check sale_reviews first
  const saleReview = db.prepare(
    "SELECT id, clicked_at FROM sale_reviews WHERE tracking_id = ?"
  ).get(trackingId);

  if (saleReview) {
    // Only record first click
    if (!saleReview.clicked_at) {
      db.prepare(
        "UPDATE sale_reviews SET clicked_at = ?, updated_at = ? WHERE id = ?"
      ).run(now, now, saleReview.id);
      logActivity("sale_review_clicked", `Customer clicked sale review link (tracking: ${trackingId})`);
    }
    return db.prepare("SELECT review_url FROM sale_reviews WHERE tracking_id = ?").get(trackingId)?.review_url;
  }

  // Check notifications table (for delivery review click tracking)
  try {
    const notification = db.prepare(
      "SELECT id, review_clicked_at FROM notifications WHERE review_tracking_id = ?"
    ).get(trackingId);

    if (notification) {
      if (!notification.review_clicked_at) {
        db.prepare(
          "UPDATE notifications SET review_clicked_at = ?, updated_at = ? WHERE id = ?"
        ).run(now, now, notification.id);
        logActivity("delivery_review_clicked", `Customer clicked delivery review link (tracking: ${trackingId})`, notification.id);
      }
      // Look up the store to get the review URL
      const notifFull = db.prepare("SELECT store FROM notifications WHERE id = ?").get(notification.id);
      return STORE_REVIEW_LINKS[notifFull?.store] || null;
    }
  } catch (e) {
    // review_tracking_id column may not exist yet
  }

  return null;
}

/**
 * Get comparison data: sale reviews vs delivery reviews
 */
function getComparisonData() {
  // Day-of-sale stats
  const saleTotal = db.prepare("SELECT COUNT(*) as count FROM sale_reviews WHERE status = 'sent'").get().count;
  const saleClicked = db.prepare("SELECT COUNT(*) as count FROM sale_reviews WHERE clicked_at IS NOT NULL").get().count;

  // Delivery review stats (from notifications table)
  const deliveryTotal = db.prepare("SELECT COUNT(*) as count FROM notifications WHERE review_sent_at IS NOT NULL").get().count;
  let deliveryClicked = 0;
  try {
    deliveryClicked = db.prepare("SELECT COUNT(*) as count FROM notifications WHERE review_clicked_at IS NOT NULL").get().count;
  } catch (e) {
    // Column may not exist yet
  }

  // Per-store breakdown
  const saleByStore = db.prepare(`
    SELECT store,
      COUNT(*) as total,
      SUM(CASE WHEN clicked_at IS NOT NULL THEN 1 ELSE 0 END) as clicked
    FROM sale_reviews
    WHERE status = 'sent'
    GROUP BY store
  `).all();

  const deliveryByStore = db.prepare(`
    SELECT store,
      COUNT(*) as total,
      SUM(CASE WHEN review_sent_at IS NOT NULL THEN 1 ELSE 0 END) as review_sent
    FROM notifications
    WHERE store IS NOT NULL AND store != 'unknown' AND store != 'other'
      AND review_sent_at IS NOT NULL
    GROUP BY store
  `).all();

  // Daily trend (last 30 days)
  const saleDailyTrend = db.prepare(`
    SELECT DATE(created_at) as date,
      COUNT(*) as sent,
      SUM(CASE WHEN clicked_at IS NOT NULL THEN 1 ELSE 0 END) as clicked
    FROM sale_reviews
    WHERE status = 'sent'
    GROUP BY DATE(created_at)
    ORDER BY date DESC
    LIMIT 30
  `).all().reverse();

  return {
    sale: {
      total: saleTotal,
      clicked: saleClicked,
      clickRate: saleTotal > 0 ? Math.round((saleClicked / saleTotal) * 100) : 0,
    },
    delivery: {
      total: deliveryTotal,
      clicked: deliveryClicked,
      clickRate: deliveryTotal > 0 ? Math.round((deliveryClicked / deliveryTotal) * 100) : 0,
    },
    saleByStore,
    deliveryByStore,
    saleDailyTrend,
  };
}

module.exports = {
  processSaleReview,
  recordClick,
  getComparisonData,
  resolveStoreFromSaleNumber,
  cleanPhone,
  STORE_REVIEW_LINKS,
  STORE_DISPLAY_NAMES,
};
