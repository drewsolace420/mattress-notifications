/**
 * Shared Utilities — Mattress Overstock
 *
 * Centralized constants and helper functions used across multiple modules.
 * Previously duplicated in spoke.js, sync.js, sale-review.js, pos-parser.js,
 * reschedule.js, scheduler.js, and server.js.
 */

const db = require("../database");

// ─── Spoke API Base URL ──────────────────────────────────
const SPOKE_API_BASE = "https://api.getcircuit.com/public/v0.2b";

// ─── Sale Number Leading Digit → Store ──────────────────
const SALE_PREFIX_TO_STORE = {
  "1": "other",       // skip review solicitation
  "2": "lexington",   // Nicholasville Road
  "3": "georgetown",
  "4": "somerset",
  "5": "london",
};

// ─── Google Review Links ────────────────────────────────
const STORE_REVIEW_LINKS = {
  somerset: "https://g.page/r/CcHG8jVFzOK1EBM/review",
  lexington: "https://g.page/r/CRCnucIb-t91EBM/review",
  london: "https://g.page/r/CW69HHcXCceJEBM/review",
  georgetown: "https://g.page/r/CZQNrg3DMJIdEBM/review",
};

// ─── Store Display Names ────────────────────────────────
const STORE_DISPLAY_NAMES = {
  somerset: "Mattress Overstock - Somerset",
  lexington: "Mattress Overstock - Nicholasville Road",
  london: "Mattress Overstock - London",
  georgetown: "Mattress Overstock - Georgetown",
  other: "Mattress Overstock",
};

/**
 * Resolve store from Sale Number custom property.
 * The leading digit determines the store.
 */
function resolveStoreFromSaleNumber(saleNumber) {
  if (!saleNumber) return "unknown";
  const str = String(saleNumber).trim();
  if (!str) return "unknown";
  const leadingDigit = str.charAt(0);
  return SALE_PREFIX_TO_STORE[leadingDigit] || "unknown";
}

/**
 * Extract Sale Number from Spoke custom properties.
 * Spoke uses UUIDs as keys, not display names. Example:
 *   { "4a43ff9b-475d-4c55-985d-e852ae2b0dfa": "20162800" }
 * Since Sale Number is the only custom property, grab the first value.
 */
function extractSaleNumber(customProperties) {
  if (!customProperties || typeof customProperties !== "object") return null;

  // Try known display name keys first
  const byName =
    customProperties["Sale Number"] ||
    customProperties["sale_number"] ||
    customProperties["saleNumber"] ||
    customProperties["Sale number"] ||
    customProperties["sale number"] ||
    customProperties["SaleNumber"] ||
    null;
  if (byName) return byName;

  // Spoke uses UUID keys — grab the first value
  const values = Object.values(customProperties);
  if (values.length > 0 && values[0]) {
    console.log("[Utils] Extracted sale number from UUID key:", values[0]);
    return values[0];
  }

  return null;
}

/**
 * Clean a phone number: strip formatting, ensure +1 prefix.
 */
function cleanPhone(phone) {
  if (!phone) return "";
  let cleaned = phone.replace(/[^\d+]/g, "");
  if (cleaned.length === 10) cleaned = "+1" + cleaned;
  if (cleaned.length === 11 && cleaned.startsWith("1")) cleaned = "+" + cleaned;
  return cleaned;
}

/**
 * Log an activity to the activity_log table.
 */
function logActivity(type, detail, notificationId = null) {
  db.prepare(
    "INSERT INTO activity_log (type, detail, notification_id, created_at) VALUES (?, ?, ?, ?)"
  ).run(type, detail, notificationId, new Date().toISOString());
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
        const now = new Date();
        let year = now.getFullYear();
        // Handle year crossover: if route month is Jan-Feb and current month is Nov-Dec,
        // the route is likely for next year
        if (month <= 1 && now.getMonth() >= 10) year++;
        const date = new Date(year, month, day);
        return date.toISOString().split("T")[0];
      }
    }
  } catch (e) {}
  return null;
}

/**
 * Get current time in EST/EDT
 */
function getESTNow() {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/New_York" })
  );
}

module.exports = {
  SPOKE_API_BASE,
  SALE_PREFIX_TO_STORE,
  STORE_REVIEW_LINKS,
  STORE_DISPLAY_NAMES,
  resolveStoreFromSaleNumber,
  extractSaleNumber,
  cleanPhone,
  logActivity,
  parseDateFromRouteTitle,
  getESTNow,
};
