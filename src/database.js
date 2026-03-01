const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = process.env.DATABASE_URL || path.join(__dirname, "../data/notifications.db");

const fs = require("fs");
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(DB_PATH);
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
    status TEXT DEFAULT 'pending',
    sent_at TEXT,
    quo_message_id TEXT,
    spoke_stop_id TEXT,
    spoke_route_id TEXT,
    raw_delivery_time TEXT,
    customer_response TEXT,
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

// ─── Seed defaults ───────────────────────────────────────
const upsert = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
upsert.run("auto_send_enabled", process.env.AUTO_SEND_ENABLED || "true");
upsert.run("business_name", process.env.BUSINESS_NAME || "Mattress Overstock");
upsert.run("retry_max", "3");
upsert.run("retry_interval_minutes", "5");

const templateCount = db.prepare("SELECT COUNT(*) as count FROM sms_templates").get().count;
if (templateCount === 0) {
  db.prepare("INSERT INTO sms_templates (body, is_active) VALUES (?, 1)").run(
    `Hi {{customer_first}}, your mattress delivery from {{business_name}} is confirmed for {{date}} between {{time_window}}. Your driver {{driver}} will text when en route. Reply STOP to opt out.`
  );
}

console.log("[DB] Database initialized at", DB_PATH);

// ─── Migrations (safe to run multiple times) ─────────────
try { db.exec("ALTER TABLE notifications ADD COLUMN review_sent_at TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE notifications ADD COLUMN conversation_state TEXT DEFAULT 'none'"); } catch(e) {}
try { db.exec("ALTER TABLE notifications ADD COLUMN reschedule_count INTEGER DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE notifications ADD COLUMN rescheduled_from INTEGER"); } catch(e) {}
try { db.exec(`
  CREATE TABLE IF NOT EXISTS reschedule_conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    notification_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )
`); } catch(e) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_reschedule_notif ON reschedule_conversations(notification_id)"); } catch(e) {}

// tracked_plans — Spoke plan IDs discovered from webhooks or manual entry
try { db.exec(`
  CREATE TABLE IF NOT EXISTS tracked_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id TEXT NOT NULL UNIQUE,
    delivery_date TEXT,
    label TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )
`); } catch(e) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_tracked_plans_date ON tracked_plans(delivery_date)"); } catch(e) {}

// ─── Sale Reviews table (day-of-sale review solicitations) ───
try { db.exec(`
  CREATE TABLE IF NOT EXISTS sale_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    sale_number TEXT NOT NULL,
    store TEXT NOT NULL,
    ai_message TEXT,
    tracking_id TEXT UNIQUE,
    review_url TEXT,
    status TEXT DEFAULT 'pending',
    sent_at TEXT,
    quo_message_id TEXT,
    clicked_at TEXT,
    error_message TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )
`); } catch(e) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_sale_reviews_tracking ON sale_reviews(tracking_id)"); } catch(e) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_sale_reviews_store ON sale_reviews(store)"); } catch(e) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_sale_reviews_status ON sale_reviews(status)"); } catch(e) {}
try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_sale_reviews_phone_sale ON sale_reviews(phone, sale_number)"); } catch(e) {}

// Migration: delivery review click tracking columns
try { db.exec("ALTER TABLE notifications ADD COLUMN review_tracking_id TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE notifications ADD COLUMN review_clicked_at TEXT"); } catch(e) {}

// pos_uploads — track CSV upload history
try { db.exec(`
  CREATE TABLE IF NOT EXISTS pos_uploads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT,
    total_parsed INTEGER DEFAULT 0,
    total_sent INTEGER DEFAULT 0,
    total_skipped INTEGER DEFAULT 0,
    total_failed INTEGER DEFAULT 0,
    uploaded_by TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )
`); } catch(e) {}

// Migration: remove CHECK constraint on status column if present
// Old schema had CHECK(status IN ('pending','sent','failed','delivered')) which blocks 'cancelled'
try {
  const testStmt = db.prepare("INSERT INTO notifications (customer_name, phone, status) VALUES ('__test__', '__test__', 'cancelled')");
  try {
    testStmt.run();
    db.prepare("DELETE FROM notifications WHERE customer_name = '__test__'").run();
  } catch (checkErr) {
    console.log("[DB] Rebuilding table to remove status CHECK constraint...");
    db.exec(`
      CREATE TABLE notifications_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_name TEXT NOT NULL, phone TEXT NOT NULL, store TEXT, address TEXT,
        scheduled_date TEXT, time_window TEXT, product TEXT, driver TEXT,
        status TEXT DEFAULT 'pending', sent_at TEXT, quo_message_id TEXT,
        spoke_stop_id TEXT, spoke_route_id TEXT, raw_delivery_time TEXT,
        customer_response TEXT, response_at TEXT, error_message TEXT,
        retry_count INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
        review_sent_at TEXT, conversation_state TEXT DEFAULT 'none',
        reschedule_count INTEGER DEFAULT 0, rescheduled_from INTEGER,
        review_tracking_id TEXT, review_clicked_at TEXT
      );
      INSERT INTO notifications_new SELECT
        id, customer_name, phone, store, address, scheduled_date, time_window,
        product, driver, status, sent_at, quo_message_id, spoke_stop_id, spoke_route_id,
        raw_delivery_time, customer_response, response_at, error_message, retry_count,
        created_at, updated_at, review_sent_at, conversation_state, reschedule_count, rescheduled_from,
        review_tracking_id, review_clicked_at
      FROM notifications;
      DROP TABLE notifications;
      ALTER TABLE notifications_new RENAME TO notifications;
      CREATE INDEX idx_notifications_status ON notifications(status);
      CREATE INDEX idx_notifications_date ON notifications(scheduled_date);
      CREATE INDEX idx_notifications_store ON notifications(store);
    `);
    console.log("[DB] ✓ Table rebuilt — 'cancelled' status now allowed");
  }
} catch(e) {}

module.exports = db;
