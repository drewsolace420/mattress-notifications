/**
 * SMS Template Service — Mattress Overstock
 *
 * BUSINESS RULES:
 * - All delivery windows are exactly 2 hours
 * - Windows start on the hour or half-hour (7:00, 7:30, 8:00, etc.)
 * - If a delivery time falls within a 30-min block, ALWAYS round UP
 * - Messages sent at 6 PM EST for NEXT day's deliveries
 * - No messages on Saturday or Sunday
 * - No deliveries on Sunday or Monday
 * - Delivery days: Tuesday–Saturday
 * - Send days: Monday–Friday at 6 PM EST
 *
 * VALID WINDOWS (30-min increments, 2-hour spans):
 *   7:00–9:00 AM through 6:00–8:00 PM
 */

/**
 * Round a time (in minutes from midnight) UP to the nearest 30-minute mark.
 * e.g., 7:14 AM (434 min) → 7:30 AM (450 min)
 * e.g., 7:30 AM (450 min) → 7:30 AM (450 min) — already on mark
 * e.g., 9:01 AM (541 min) → 9:30 AM (570 min)
 */
function roundUpTo30(minutes) {
  return Math.ceil(minutes / 30) * 30;
}

/**
 * Format minutes-from-midnight into display components.
 */
function formatTime(minutes) {
  let hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  const ampm = hours < 12 ? "AM" : "PM";
  let displayHour = hours % 12;
  if (displayHour === 0) displayHour = 12;
  const displayMin = mins === 0 ? ":00" : ":30";
  return { display: `${displayHour}${displayMin}`, ampm, hours24: hours };
}

/**
 * Build the "between X and Y" string matching Drew's exact message format.
 *
 * From the examples:
 *   7:00–9:00 AM         → "between 7:00 and 9:00 AM"
 *   10:00 AM–12:00 PM    → "between 10:00 AM and 12:00 PM"
 *   11:00 AM–1:00 PM     → "between 11:00 AM and 1:00 PM"
 *   12:00–2:00 PM        → "between 12:00 and 2:00 PM"
 *   1:00–3:00 PM         → "between 1:00 and 3:00 PM"
 */
function formatWindow(startMinutes, endMinutes) {
  const s = formatTime(startMinutes);
  const e = formatTime(endMinutes);

  if (s.ampm === "AM" && e.ampm === "AM") {
    return `between ${s.display} and ${e.display} AM`;
  }
  if (s.ampm === "AM" && e.ampm === "PM") {
    return `between ${s.display} AM and ${e.display} PM`;
  }
  if (s.ampm === "PM" && e.ampm === "PM") {
    return `between ${s.display} and ${e.display} PM`;
  }
  return `between ${s.display} ${s.ampm} and ${e.display} ${e.ampm}`;
}

/**
 * Given a raw delivery time, compute the 2-hour window.
 *
 * @param {string|number} rawTime - Time string or minutes from midnight
 * @returns {{ windowStart, windowEnd, windowText, startDisplay, endDisplay }}
 */
function computeDeliveryWindow(rawTime) {
  let minutes;

  if (typeof rawTime === "number") {
    minutes = rawTime;
  } else if (typeof rawTime === "string") {
    minutes = parseTimeString(rawTime);
  } else {
    minutes = 540; // default 9:00 AM
  }

  // Round UP to nearest 30-minute mark
  const windowStart = roundUpTo30(minutes);

  // Clamp to valid range: 7:00 AM (420) to 6:00 PM (1080)
  const clampedStart = Math.max(420, Math.min(1080, windowStart));

  // End is always start + 2 hours
  const windowEnd = clampedStart + 120;

  return {
    windowStart: clampedStart,
    windowEnd,
    windowText: formatWindow(clampedStart, windowEnd),
    startDisplay: formatTimeFullDisplay(clampedStart),
    endDisplay: formatTimeFullDisplay(windowEnd),
  };
}

/**
 * Parse various time string formats into minutes from midnight.
 */
function parseTimeString(timeStr) {
  if (!timeStr) return 540;

  const cleaned = timeStr.trim().toUpperCase();

  // HH:MM AM/PM
  const ampmMatch = cleaned.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/);
  if (ampmMatch) {
    let hours = parseInt(ampmMatch[1], 10);
    const mins = parseInt(ampmMatch[2], 10);
    if (ampmMatch[3] === "PM" && hours !== 12) hours += 12;
    if (ampmMatch[3] === "AM" && hours === 12) hours = 0;
    return hours * 60 + mins;
  }

  // 24-hour HH:MM or HH:MM:SS
  const h24Match = cleaned.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (h24Match) {
    return parseInt(h24Match[1], 10) * 60 + parseInt(h24Match[2], 10);
  }

  // ISO datetime
  try {
    const date = new Date(timeStr);
    if (!isNaN(date.getTime())) {
      return date.getHours() * 60 + date.getMinutes();
    }
  } catch {}

  return 540;
}

function formatTimeFullDisplay(minutes) {
  const t = formatTime(minutes);
  return `${t.display} ${t.ampm}`;
}

/**
 * Build the SMS message body using Drew's exact format.
 */
function getSmsBody(notification) {
  let windowText;

  if (notification.time_window && notification.time_window !== "TBD") {
    // Already formatted as "between X and Y"
    if (notification.time_window.startsWith("between ")) {
      windowText = notification.time_window;
    } else {
      // Raw window like "9:00 AM - 11:00 AM" — recompute
      const parts = notification.time_window.split(/[-–]/);
      if (parts.length === 2) {
        const startMin = parseTimeString(parts[0].trim());
        const rounded = roundUpTo30(startMin);
        const clamped = Math.max(420, Math.min(1080, rounded));
        windowText = formatWindow(clamped, clamped + 120);
      } else {
        windowText = notification.time_window;
      }
    }
  } else if (notification.raw_delivery_time) {
    const window = computeDeliveryWindow(notification.raw_delivery_time);
    windowText = window.windowText;
  } else {
    windowText = "your scheduled time";
  }

  return [
    `Hello! Mattress Overstock here with a delivery update.`,
    `Your mattress delivery is scheduled for tomorrow ${windowText}.`,
    `Please reply YES if this time works for you.`,
    `If it does not, reply NO and a member of our team will follow up.`,
    `If the delivery window is not accepted, your delivery will need to be moved to a different day.`,
    `Thanks\u2014we look forward to delivering your mattress!`,
  ].join("\n");
}

/**
 * Schedule helpers
 */

// Is today a valid SEND day? (Mon=1 through Fri=5)
function isSendDay(date) {
  const day = date.getDay();
  return day >= 1 && day <= 5;
}

// Is a date a valid DELIVERY day? (Tue=2 through Sat=6)
function isDeliveryDay(date) {
  const day = date.getDay();
  return day >= 2 && day <= 6;
}

// Get tomorrow's date from a send date
function getDeliveryDateFromSendDate(sendDate) {
  const d = new Date(sendDate);
  d.setDate(d.getDate() + 1);
  return d;
}

module.exports = {
  getSmsBody,
  computeDeliveryWindow,
  roundUpTo30,
  parseTimeString,
  formatWindow,
  formatTimeFullDisplay,
  isSendDay,
  isDeliveryDay,
  getDeliveryDateFromSendDate,
};
