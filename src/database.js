const Database = require("better-sqlite3");
const path = require("path");

// Use /tmp on Railway for writable storage, or local data dir
const DB_PATH = process.env.DATABASE_URL || path.join(__dirname, "../data/notifications.db");

// Ensure data directory exists
const fs = require("fs");
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent performance
db.pragma("journal_mode = WAL");

// ─── Schema ──────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    store TEXT,
    address TEXT,
    scheduled_date TEXT,
    time_window TEXT,
    product TEXT,
    driver TEXT,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'sent', 'failed', 'delivered')),
    sent_at TEXT,
    quo_message_id TEXT,
    spoke_stop_id TEXT,
    spoke_route_id TEXT,
    raw_delivery_time TEXT,
    customer_response TEXT CHECK(customer_response IN ('yes', 'no', 'stop', NULL)),
    response_at TEXT,
    error_message TEXT,
    retry_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sms_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    body TEXT NOT NULL,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    detail TEXT,
    notification_id INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status);
  CREATE INDEX IF NOT EXISTS idx_notifications_date ON notifications(scheduled_date);
  CREATE INDEX IF NOT EXISTS idx_notifications_store ON notifications(store);
  CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at);
`);

// ─── Seed default settings ──────────────────────────────
const upsert = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
upsert.run("auto_send_enabled", process.env.AUTO_SEND_ENABLED || "true");
upsert.run("business_name", process.env.BUSINESS_NAME || "Mattress Overstock");
upsert.run("retry_max", "3");
upsert.run("retry_interval_minutes", "5");

// Seed default SMS template if none exists
const templateCount = db.prepare("SELECT COUNT(*) as count FROM sms_templates").get().count;
if (templateCount === 0) {
  db.prepare("INSERT INTO sms_templates (body, is_active) VALUES (?, 1)").run(
    `Hi {{customer_first}}, your mattress delivery from {{business_name}} is confirmed for {{date}} between {{time_window}}. Your driver {{driver}} will text when en route. Reply STOP to opt out.`
  );
}

console.log("[DB] Database initialized at", DB_PATH);

// ─── Migrations (safe to run multiple times) ─────────────
try { db.exec("ALTER TABLE notifications ADD COLUMN review_sent_at TEXT"); } catch(e) {}

module.exports = db;
