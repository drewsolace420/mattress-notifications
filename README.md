# Mattress Overstock — Delivery Notification Server

Automated SMS delivery confirmations and post-delivery review requests via **Spoke Dispatch** → **Railway** → **Quo SMS**, with AI-powered rescheduling and staff summaries via the **Claude API**.

## How It Works

```
Spoke Dispatch              Railway Server               Quo SMS
(route planned)  ──POST──→  (process + store)  ──6PM──→  (send SMS)
                             webhook                      │
                                                         ↓
Quo Reply        ──POST──→  (track YES/NO/STOP) ←─reply─ Customer
(message.received) webhook         │
                                   ├── YES → confirmed, driver delivers → Google review request
                                   ├── NO  → AI rescheduling conversation via Claude
                                   └── STOP → opt-out recorded
```

1. Deliveries are scheduled in Spoke Dispatch throughout the day
2. Spoke fires `stop.allocated` webhooks — stops are stored as "pending" notifications
3. At **6:00 PM EST** (Mon–Fri), the scheduler sends all pending SMS for tomorrow's deliveries
4. Customers reply **YES** or **NO** — tracked via Quo's reply webhook
5. **NO** replies trigger an AI-powered rescheduling conversation (Claude picks a valid date per store rules)
6. When the driver marks a stop complete (`stop.attempted_delivery`), a **Google review request** is sent automatically
7. At **9:00 PM EST**, an AI-generated **staff summary SMS** goes out to scheduling staff
8. The dashboard lets you monitor, retry failures, sync routes, and manage templates

## Business Rules

### Delivery Schedule

- **Delivery days:** Tuesday through Saturday
- **No deliveries:** Sunday and Monday

### Per-Store Delivery Days

| Store | Days |
|-------|------|
| Lexington (Nicholasville Rd) | Tue, Thu, Sat |
| Georgetown | Tue, Thu, Sat |
| Somerset | Fri |
| London | Wed (occasionally Fri) |

### SMS Send Schedule

- Messages sent at **6:00 PM EST** daily, Monday through Friday
- Each message confirms **tomorrow's** delivery:
  - Monday 6 PM → Tuesday delivery
  - Tuesday 6 PM → Wednesday delivery
  - Wednesday 6 PM → Thursday delivery
  - Thursday 6 PM → Friday delivery
  - Friday 6 PM → Saturday delivery
- **No sends** Saturday or Sunday

### Staff Summary

- Sent at **9:00 PM EST**, Monday through Friday
- AI-generated via Claude API — conversational tone, highlights confirmations, declines, and no-replies
- Falls back to a simple template if `ANTHROPIC_API_KEY` is not set

### Time Windows

- All windows are exactly **2 hours**
- Windows start on the hour or half-hour (7:00, 7:30, 8:00, etc.)
- Valid range: 7:00 AM through 8:00 PM
- **Rounding:** Times within a 30-minute block always round **up**
  - 9:00 AM → 9:00–11:00 AM
  - 9:14 AM → 9:30–11:30 AM
  - 2:15 PM → 2:30–4:30 PM

### Store Resolution (Sale Number Prefix)

All deliveries ship from a central depot. The store is determined by the leading digit of the **Sale Number** custom property in Spoke:

| Prefix | Store |
|--------|-------|
| 1 | Other (skip review solicitation) |
| 2 | Nicholasville Road (Lexington) |
| 3 | Georgetown |
| 4 | Somerset |
| 5 | London |

### Google Review Links

After a driver marks a delivery complete, the customer receives an automatic review request SMS linking to the correct store's Google Business page. Stops with sale prefix `1` (store "other") are excluded from review solicitation.

### Customer Replies

- **YES** → Delivery confirmed
- **NO** → AI rescheduling conversation begins (per-store day rules + blackout dates)
- **STOP** → Opt-out recorded, confirmation reply sent

### Message Template

The default SMS template (editable via dashboard):

```
Hi {{customer_first}}, your mattress delivery from {{business_name}} is confirmed
for {{date}} between {{time_window}}. Your driver {{driver}} will text when en route.
Reply STOP to opt out.
```

Available template variables: `{{customer_first}}`, `{{customer_last}}`, `{{date}}`, `{{time_window}}`, `{{driver}}`, `{{store}}`, `{{product}}`, `{{address}}`, `{{business_name}}`

## Deploy to Railway

### Step 1: Push to GitHub

```bash
cd mattress-notifications
git init && git add . && git commit -m "Initial commit"
gh repo create mattress-overstock-notifications --private --source=. --push
```

### Step 2: Deploy on Railway

1. Go to [railway.app](https://railway.app) → sign in with GitHub
2. **New Project** → **Deploy from GitHub repo** → select your repo
3. Railway auto-detects Node.js and builds automatically

### Step 3: Set Environment Variables

In Railway → **Variables**:

| Variable | Value | Required |
|----------|-------|----------|
| `QUO_API_KEY` | Your Quo (OpenPhone) API key | Yes |
| `QUO_PHONE_NUMBER_ID` | Quo phone number ID to send from | Yes |
| `SPOKE_API_KEY` | Your Spoke Dispatch API key | Yes |
| `BUSINESS_NAME` | `Mattress Overstock` | Yes |
| `ANTHROPIC_API_KEY` | Anthropic API key (for AI rescheduling + staff summaries) | Optional |
| `STAFF_PHONES` | Comma-separated staff phone numbers for 9 PM summary | Optional |
| `DATABASE_URL` | Custom SQLite path (default: `./data/notifications.db`) | Optional |
| `PORT` | Server port (default: `3000`) | Optional |

### Step 4: Generate a Domain

Railway → **Settings** → **Networking** → **Generate Domain**

You'll get: `https://your-app.up.railway.app`

### Step 5: Configure Webhooks

**In Spoke Dispatch** (Settings → Integrations → Webhooks):

```
https://your-app.up.railway.app/api/spoke/webhook
```

Events to subscribe: `stop.allocated`, `stop.attempted_delivery`

**In Quo** (Settings → Webhooks → message.received):

```
https://your-app.up.railway.app/api/quo/webhook
```

## API Endpoints

### Webhooks

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/spoke/webhook` | Receives Spoke Dispatch delivery events (`stop.allocated`, `stop.attempted_delivery`) |
| POST | `/api/quo/webhook` | Receives customer YES/NO/STOP replies and rescheduling messages |

### Notifications

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/notifications` | List notifications (filter by `store`, `status`, `date`) |
| POST | `/api/notifications/:id/send` | Manually send/retry a single SMS |
| DELETE | `/api/notifications/:id` | Delete a notification |
| POST | `/api/notifications/actions/send-all-pending` | Batch send all pending |

### Scheduler

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/scheduler` | Scheduler status (next send time, pending count) |
| POST | `/api/scheduler/send-now` | Manually trigger the 6 PM customer send |
| POST | `/api/scheduler/summary-now` | Manually trigger the 9 PM staff summary |

### Route Sync & Plans

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/sync` | Sync routes from Spoke for tomorrow's deliveries |
| GET | `/api/plans` | List tracked Spoke plan IDs |
| POST | `/api/plans` | Manually register a plan ID + delivery date |

### Dashboard Data

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/stats` | Dashboard stats + scheduler status |
| GET | `/api/activity` | Activity log (last 24h by default) |
| GET | `/api/conversations/:notificationId` | Rescheduling conversation history |
| GET | `/api/charts/daily` | Daily send volume (last 30 days) |
| GET | `/api/charts/stores` | Per-store delivery breakdown + review counts |
| GET | `/api/charts/responses` | Response breakdown (yes/no/stop/no-reply) |
| GET | `/api/charts/time-windows` | Delivery time window distribution |

### Configuration

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/template` | Current SMS template |
| PUT | `/api/template` | Update SMS template |
| GET | `/api/settings` | All settings |
| PUT | `/api/settings` | Update settings |
| GET | `/api/connections` | API connection status (Spoke + Quo) |
| GET | `/api/health` | Health check |

## Project Structure

```
├── server.js               # Express app + all API routes
├── public/
│   └── index.html          # Dashboard (single-page, dark theme)
├── src/
│   ├── database.js         # SQLite schema, migrations, seed data
│   ├── webhooks/
│   │   └── spoke.js        # Spoke webhook handler (stop.allocated + attempted_delivery)
│   └── services/
│       ├── quo.js           # Quo SMS send + status check
│       ├── templates.js     # SMS body builder + time window logic
│       ├── scheduler.js     # 6 PM send + 9 PM AI staff summary
│       ├── sync.js          # Route sync from Spoke REST API
│       └── reschedule.js    # AI rescheduling conversations via Claude
├── data/
│   └── notifications.db    # SQLite database (auto-created)
└── package.json
```

## Database

SQLite with WAL mode. Tables:

- **notifications** — core delivery records (customer, phone, store, status, time window, response, review tracking)
- **sms_templates** — editable SMS templates
- **activity_log** — all system events (imports, sends, replies, errors)
- **settings** — key-value config store
- **tracked_plans** — Spoke plan IDs discovered from webhooks or manual entry
- **reschedule_conversations** — message history for AI rescheduling threads

## Local Development

```bash
cp .env.example .env
# Edit .env with your API keys
npm install
npm run dev
```

The dashboard is served at `http://localhost:3000`.

## Notes

- SQLite database stored in `/data/notifications.db` (auto-created on first run)
- Duplicate Spoke stop IDs are automatically ignored
- Scheduler checks every minute if it's time to send (6 PM for customers, 9 PM for staff)
- Manual send available via dashboard or `POST /api/scheduler/send-now`
- Route sync pulls current stops from Spoke's REST API and reconciles with local DB (adds new, updates changed, removes cancelled)
- AI features (rescheduling + staff summaries) require `ANTHROPIC_API_KEY` — the system works without it using template fallbacks
- For production persistence on Railway, consider adding a persistent volume for the SQLite database
