/**
 * Quo SMS Service
 *
 * Sends SMS messages via the Quo API (v4).
 * API Docs: https://www.quo.com/docs
 *
 * Required env vars:
 *   QUO_API_KEY         — Your Quo API key
 *   QUO_PHONE_NUMBER_ID — The phone number ID to send from
 */

const fetch = require("node-fetch");

const QUO_BASE_URL = "https://api.openphone.com/v1";
// Note: Quo's API may use /v1 or /v4 depending on the endpoint.
// Check your Quo dashboard for the correct version.

/**
 * Send an SMS via Quo
 * @param {string} to - Recipient phone number (E.164 format, e.g. +18595550142)
 * @param {string} body - SMS message body
 * @returns {object} { success, messageId }
 */
async function sendSms(to, body) {
  const apiKey = process.env.QUO_API_KEY;
  const phoneNumberId = process.env.QUO_PHONE_NUMBER_ID;

  if (!apiKey) {
    throw new Error("QUO_API_KEY not configured — set it in Railway environment variables");
  }
  if (!phoneNumberId) {
    throw new Error("QUO_PHONE_NUMBER_ID not configured — set it in Railway environment variables");
  }
  if (!to) {
    throw new Error("No recipient phone number provided");
  }
  if (!body) {
    throw new Error("No message body provided");
  }

  // Clean the phone number
  let cleanTo = to.replace(/[^\d+]/g, "");
  if (cleanTo.length === 10) cleanTo = "+1" + cleanTo;
  if (cleanTo.length === 11 && cleanTo.startsWith("1")) cleanTo = "+" + cleanTo;

  console.log(`[Quo] Sending SMS to ${cleanTo.substring(0, 6)}****`);

  try {
    const response = await fetch(`${QUO_BASE_URL}/messages`, {
      method: "POST",
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: phoneNumberId,
        to: [cleanTo],
        content: body,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`[Quo] API error ${response.status}:`, errorBody);
      throw new Error(`Quo API returned ${response.status}: ${errorBody.substring(0, 200)}`);
    }

    const data = await response.json();
    console.log(`[Quo] SMS sent successfully — ID: ${data.data?.id || data.id || "unknown"}`);

    return {
      success: true,
      messageId: data.data?.id || data.id || null,
      response: data,
    };
  } catch (err) {
    if (err.message.includes("Quo API returned")) throw err;
    console.error("[Quo] Network error:", err.message);
    throw new Error(`Failed to reach Quo API: ${err.message}`);
  }
}

/**
 * Check if Quo API is reachable
 * @returns {boolean}
 */
async function getQuoStatus() {
  const apiKey = process.env.QUO_API_KEY;
  if (!apiKey) return false;

  try {
    const response = await fetch(`${QUO_BASE_URL}/phone-numbers`, {
      headers: { Authorization: apiKey },
    });
    return response.ok;
  } catch {
    return false;
  }
}

module.exports = { sendSms, getQuoStatus };
