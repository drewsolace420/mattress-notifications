/**
 * AI-Powered Rescheduling Service
 *
 * Uses Claude to have a natural text conversation with customers who
 * replied NO to their delivery confirmation. Claude knows each store's
 * valid delivery days and guides the customer to pick a new date.
 *
 * Flow:
 *   1. Customer replies NO → status set to reschedule 'awaiting_date'
 *   2. Auto-reply asks when they'd like to reschedule
 *   3. Customer texts back (free-form natural language)
 *   4. Message → Claude API with store rules + conversation history
 *   5. Claude extracts date or asks for clarification
 *   6. Valid date confirmed → create unassigned stop in Spoke → confirm to customer
 *   7. New stop flows through normal pipeline (allocated → 6 PM text → etc.)
 *
 * Requires: ANTHROPIC_API_KEY environment variable
 */

const fetch = require("node-fetch");
const db = require("../database");
const { sendSms } = require("./quo");

const SPOKE_API_BASE = "https://api.getcircuit.com/public/v0.2b";

// ─── Store Delivery Day Rules ───────────────────────────
// Day numbers: 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
const STORE_DELIVERY_RULES = {
  lexington: {
    days: [2, 4, 6], // Tue, Thu, Sat
    dayNames: "Tuesdays, Thursdays, and Saturdays",
    flexible: [],
  },
  georgetown: {
    days: [2, 4, 6], // Tue, Thu, Sat
    dayNames: "Tuesdays, Thursdays, and Saturdays",
    flexible: [],
  },
  somerset: {
    days: [5], // Fri only
    dayNames: "Fridays",
    flexible: [],
  },
  london: {
    days: [3], // Wed
    dayNames: "Wednesdays",
    flexible: [5], // occasionally Fri
    flexibleNote: "We can occasionally do Fridays if you need it.",
  },
};

// ─── Blackout Dates ─────────────────────────────────────
const BLACKOUT_DATES = [
  "2026-11-26", // Thanksgiving
  "2026-11-27", // Day after Thanksgiving
  "2026-12-24", // Christmas Eve
  "2026-12-25", // Christmas Day
  "2026-12-31", // New Year's Eve
  "2027-01-01", // New Year's Day
  "2027-05-25", // Memorial Day
  "2027-07-04", // Independence Day
  "2027-09-07", // Labor Day
  "2027-11-25", // Thanksgiving 2027
  "2027-11-26", // Day after Thanksgiving 2027
  "2027-12-24", // Christmas Eve 2027
  "2027-12-25", // Christmas Day 2027
];

const SALE_PREFIX_TO_STORE = {
  "2": "lexington",
  "3": "georgetown",
  "4": "somerset",
  "5": "london",
};

/**
 * Handle an incoming text from a customer who is in rescheduling mode.
 *
 * @param {Object} notification — the original notification record
 * @param {string} customerMessage — what the customer texted
 * @returns {Object} { reply: string, rescheduled: boolean, newDate?: string }
 */
async function handleRescheduleMessage(notification, customerMessage) {
  const store = notification.store;
  const rules = STORE_DELIVERY_RULES[store];

  if (!rules) {
    console.log("[Reschedule] No delivery rules for store:", store);
    return {
      reply: "We're having trouble looking up your delivery area. A team member will reach out to help reschedule. Thank you!",
      rescheduled: false,
      handoff: true,
    };
  }

  // Load conversation history
  const history = db
    .prepare("SELECT role, content FROM reschedule_conversations WHERE notification_id = ? ORDER BY created_at ASC")
    .all(notification.id);

  // Add customer's new message to history
  db.prepare("INSERT INTO reschedule_conversations (notification_id, role, content, created_at) VALUES (?, 'user', ?, ?)")
    .run(notification.id, customerMessage, new Date().toISOString());

  // Build messages for Claude
  const systemPrompt = buildSystemPrompt(store, rules, notification);
  const messages = [];

  // Add conversation history
  for (const msg of history) {
    messages.push({ role: msg.role === "user" ? "user" : "assistant", content: msg.content });
  }

  // Add current message
  messages.push({ role: "user", content: customerMessage });

  // Call Claude
  const claudeResponse = await callClaude(systemPrompt, messages);

  if (!claudeResponse) {
    return {
      reply: "We're having a little trouble right now. A team member will reach out to help reschedule. Thank you!",
      rescheduled: false,
      handoff: true,
    };
  }

  // Parse Claude's structured response
  let parsed;
  try {
    // Claude should return JSON
    const jsonMatch = claudeResponse.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[0]);
    } else {
      throw new Error("No JSON found in response");
    }
  } catch (e) {
    console.error("[Reschedule] Failed to parse Claude response:", e.message);
    console.log("[Reschedule] Raw response:", claudeResponse);
    return {
      reply: "We're having a little trouble right now. A team member will reach out to help reschedule. Thank you!",
      rescheduled: false,
      handoff: true,
    };
  }

  console.log("[Reschedule] Claude parsed:", JSON.stringify(parsed));

  // Save Claude's reply to conversation history
  db.prepare("INSERT INTO reschedule_conversations (notification_id, role, content, created_at) VALUES (?, 'assistant', ?, ?)")
    .run(notification.id, parsed.reply, new Date().toISOString());

  if (parsed.action === "confirm_date" && parsed.date) {
    // Validate the date one more time server-side
    const validation = validateDate(parsed.date, store, rules);
    if (!validation.valid) {
      return { reply: validation.reason, rescheduled: false };
    }

    // Create the rescheduled stop in Spoke
    const spokeCreated = await createRescheduledStop(notification, parsed.date);

    // Update the original notification
    db.prepare(
      "UPDATE notifications SET conversation_state = 'rescheduled', reschedule_count = reschedule_count + 1, updated_at = ? WHERE id = ?"
    ).run(new Date().toISOString(), notification.id);

    // Create a new notification record for the rescheduled delivery
    const newNotif = db.prepare(
      `INSERT INTO notifications
      (customer_name, phone, store, address, scheduled_date, time_window, product, driver, status, rescheduled_from, conversation_state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'TBD', ?, 'TBD', 'pending', ?, 'none', ?, ?)`
    ).run(
      notification.customer_name,
      notification.phone,
      notification.store,
      notification.address,
      parsed.date,
      notification.product,
      notification.id,
      new Date().toISOString(),
      new Date().toISOString()
    );

    logActivity(
      "reschedule_confirmed",
      `${notification.customer_name} rescheduled to ${parsed.date} (${parsed.day_name || ""})`,
      notification.id
    );

    return { reply: parsed.reply, rescheduled: true, newDate: parsed.date };
  }

  if (parsed.action === "handoff") {
    db.prepare(
      "UPDATE notifications SET conversation_state = 'handoff', updated_at = ? WHERE id = ?"
    ).run(new Date().toISOString(), notification.id);

    logActivity("reschedule_handoff", `${notification.customer_name} needs human assistance for rescheduling`, notification.id);

    return { reply: parsed.reply, rescheduled: false, handoff: true };
  }

  // Default: clarification needed, keep conversation going
  return { reply: parsed.reply, rescheduled: false };
}

/**
 * Build the system prompt for Claude with store-specific delivery rules.
 */
function buildSystemPrompt(store, rules, notification) {
  const today = new Date();
  const todayStr = today.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "America/New_York",
  });

  const storeDisplayNames = {
    lexington: "Mattress Overstock - Nicholasville Road (Lexington)",
    georgetown: "Mattress Overstock - Georgetown",
    somerset: "Mattress Overstock - Somerset",
    london: "Mattress Overstock - London",
  };

  const flexNote = rules.flexibleNote ? `\n- ${rules.flexibleNote}` : "";

  return `You are a friendly text message assistant for Mattress Overstock helping a customer reschedule their mattress delivery. Keep your messages short and conversational — this is SMS, not email.

CUSTOMER INFO:
- Name: ${notification.customer_name}
- Store: ${storeDisplayNames[store] || store}
- Original delivery date: ${notification.scheduled_date}
- Address: ${notification.address}

TODAY'S DATE: ${todayStr}

DELIVERY RULES FOR THIS STORE:
- Valid delivery days: ${rules.dayNames}${flexNote}
- The delivery must be on a future date (not today or in the past)
- No deliveries on these holidays: Thanksgiving, day after Thanksgiving, Christmas Eve, Christmas Day, New Year's Eve, New Year's Day, Memorial Day, Independence Day, Labor Day

IMPORTANT RULES:
- You CANNOT provide a time window. Time windows are set the day before delivery and the customer will be texted automatically.
- If the customer asks for a specific time, politely explain that delivery windows are assigned the day before and they'll receive a text with their window.
- If the customer asks for a day that doesn't match the store's delivery days, tell them which days are available.
- If the customer seems frustrated or has a complex request you can't handle, hand off to a human.
- Be warm and brief. Use first names. No emojis.
- Do NOT mention that you are an AI or automated system.
- The reschedule date must be at least 2 days from today to allow route planning.

You MUST respond with ONLY a JSON object (no other text) in this exact format:

For confirming a date:
{"action": "confirm_date", "date": "YYYY-MM-DD", "day_name": "Thursday", "reply": "Your delivery has been rescheduled for Thursday, March 5th! We'll text you the evening before with your delivery window."}

For asking clarification:
{"action": "clarify", "reply": "We deliver to your area on Tuesdays, Thursdays, and Saturdays. Which day works best for you?"}

For handing off to a human:
{"action": "handoff", "reply": "Let me have someone from our team reach out to help with that. They'll text you tomorrow after 10 AM."}

Respond with ONLY the JSON object, nothing else.`;
}

/**
 * Call Claude API to process the customer's message.
 */
async function callClaude(systemPrompt, messages) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("[Reschedule] No ANTHROPIC_API_KEY set");
    return null;
  }

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 300,
        system: systemPrompt,
        messages: messages,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("[Reschedule] Claude API error:", res.status, errText.substring(0, 500));
      return null;
    }

    const data = await res.json();
    const text = data.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");

    console.log("[Reschedule] Claude response:", text);
    return text;
  } catch (e) {
    console.error("[Reschedule] Claude API fetch error:", e.message);
    return null;
  }
}

/**
 * Server-side date validation as a safety net.
 */
function validateDate(dateStr, store, rules) {
  const date = new Date(dateStr + "T12:00:00");
  const now = new Date();
  const dayOfWeek = date.getDay();

  // Must be in the future
  if (date <= now) {
    return { valid: false, reason: `That date has already passed. What day works for you? We deliver on ${rules.dayNames}.` };
  }

  // Must be at least 2 days out
  const twoDaysOut = new Date(now);
  twoDaysOut.setDate(twoDaysOut.getDate() + 2);
  if (date < twoDaysOut) {
    return { valid: false, reason: `We need at least 2 days to plan the route. Could you pick a day after ${twoDaysOut.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}?` };
  }

  // Must be a valid delivery day
  const allValidDays = [...rules.days, ...(rules.flexible || [])];
  if (!allValidDays.includes(dayOfWeek)) {
    return { valid: false, reason: `We deliver to your area on ${rules.dayNames}. Which of those days works for you?` };
  }

  // Not a blackout date
  if (BLACKOUT_DATES.includes(dateStr)) {
    return { valid: false, reason: `We're closed on that holiday. What other day works for you?` };
  }

  return { valid: true };
}

/**
 * Create an unassigned stop in Spoke for the rescheduled delivery.
 * The dispatcher will assign it to a route when building that day's deliveries.
 */
async function createRescheduledStop(notification, newDate) {
  const apiKey = process.env.SPOKE_API_KEY;
  if (!apiKey) {
    console.log("[Reschedule] No SPOKE_API_KEY — cannot create Spoke stop");
    return false;
  }

  try {
    // Extract sale number from product field if it has "Sale #"
    const saleMatch = notification.product ? notification.product.match(/Sale #(\d+)/) : null;
    const saleNumber = saleMatch ? saleMatch[1] : null;

    // Get the custom property UUID for sale number
    // We'll fetch the team's custom stop properties to find the right key
    let customProperties = {};
    if (saleNumber) {
      try {
        const propsRes = await fetch(`${SPOKE_API_BASE}/teams/customStopProperties`, {
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        });
        if (propsRes.ok) {
          const propsData = await propsRes.json();
          // Find the sale number property
          const saleProp = propsData.customStopProperties?.find(
            (p) => p.name?.toLowerCase().includes("sale") || p.label?.toLowerCase().includes("sale")
          );
          if (saleProp) {
            customProperties[saleProp.id] = saleNumber;
            console.log("[Reschedule] Using custom property UUID:", saleProp.id, "=", saleNumber);
          }
        }
      } catch (e) {
        console.log("[Reschedule] Could not fetch custom properties:", e.message);
      }
    }

    const stopData = {
      address: {
        addressLineOne: notification.address,
      },
      recipient: {
        name: notification.customer_name,
        phone: notification.phone,
      },
      notes: `Rescheduled from ${notification.scheduled_date}. Original notification #${notification.id}`,
      orderInfo: {
        products: notification.product ? [notification.product] : [],
      },
    };

    if (Object.keys(customProperties).length > 0) {
      stopData.customProperties = customProperties;
    }

    console.log("[Reschedule] Creating unassigned stop in Spoke:", JSON.stringify(stopData).substring(0, 500));

    const res = await fetch(`${SPOKE_API_BASE}/unassignedStops`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(stopData),
    });

    if (res.ok) {
      const data = await res.json();
      console.log("[Reschedule] ✓ Created unassigned stop:", data.id);
      logActivity("spoke_stop_created", `Rescheduled stop created in Spoke for ${notification.customer_name} — ${newDate}`);
      return true;
    }

    const errText = await res.text();
    console.error("[Reschedule] Failed to create Spoke stop:", res.status, errText.substring(0, 500));
    return false;
  } catch (e) {
    console.error("[Reschedule] Spoke API error:", e.message);
    return false;
  }
}

/**
 * Kick off the reschedule conversation after a customer replies NO.
 */
async function startRescheduleConversation(notification) {
  const store = notification.store;
  const rules = STORE_DELIVERY_RULES[store];

  if (!rules) {
    // Store not configured for automated rescheduling
    await sendSms(
      notification.phone,
      "No problem! A member of our team will text you tomorrow after 10 AM to reschedule your delivery. Thank you!"
    );
    return;
  }

  // Set conversation state
  db.prepare("UPDATE notifications SET conversation_state = 'rescheduling', updated_at = ? WHERE id = ?")
    .run(new Date().toISOString(), notification.id);

  // Send initial reschedule message with available days
  const firstName = notification.customer_name.split(" ")[0];
  let message = `No problem, ${firstName}! We can reschedule your delivery. We deliver to your area on ${rules.dayNames}. What day works best for you?`;

  if (rules.flexibleNote) {
    message = `No problem, ${firstName}! We can reschedule your delivery. We typically deliver to your area on ${rules.dayNames}. ${rules.flexibleNote} What day works best for you?`;
  }

  await sendSms(notification.phone, message);

  // Log the initial assistant message
  db.prepare("INSERT INTO reschedule_conversations (notification_id, role, content, created_at) VALUES (?, 'assistant', ?, ?)")
    .run(notification.id, message, new Date().toISOString());

  logActivity("reschedule_started", `Reschedule conversation started with ${notification.customer_name}`, notification.id);
}

function logActivity(type, detail, notificationId = null) {
  db.prepare("INSERT INTO activity_log (type, detail, notification_id, created_at) VALUES (?, ?, ?, ?)").run(
    type,
    detail,
    notificationId,
    new Date().toISOString()
  );
}

module.exports = { handleRescheduleMessage, startRescheduleConversation };
