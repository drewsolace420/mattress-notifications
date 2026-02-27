# Mattress Overstock — Delivery Notification Server

Automated SMS delivery confirmations via **Spoke Dispatch** → **Railway** → **Quo SMS**

## Business Rules

### Delivery Schedule
- **Delivery days:** Tuesday through Saturday
- **No deliveries:** Sunday and Monday

### SMS Send Schedule
- Messages sent at **6:00 PM EST** daily, Monday through Friday
- Each message confirms **tomorrow's** delivery
- Monday 6 PM → Tuesday delivery
- Tuesday 6 PM → Wednesday delivery
- Wednesday 6 PM → Thursday delivery
- Thursday 6 PM → Friday delivery
- Friday 6 PM → Saturday delivery
- **No sends** Saturday or Sunday

### Time Windows
- All windows are exactly **2 hours**
- Windows start on the hour or half-hour (7:00, 7:30, 8:00, etc.)
- Valid range: 7:00 AM through 8:00 PM
- **Rounding:** If a delivery time falls within a 30-minute block, **always round UP**
  - 9:00 AM → 9:00–11:00 AM window
  - 9:14 AM → 9:30–11:30 AM window (rounded up to 9:30)
  - 2:15 PM → 2:30–4:30 PM window (rounded up to 2:30)

### Message Format
```
Hello! Mattress Overstock here with a delivery update.
Your mattress delivery is scheduled for tomorrow between [WINDOW].
Please reply YES if this time works for you.
If it does not, reply NO and a member of our team will follow up.
If the delivery window is not accepted, your delivery will need to be moved to a different day.
Thanks—we look forward to delivering your mattress!
```

### Customer Replies
- **YES** → Delivery confirmed, marked as "delivered"
- **NO** → Needs rescheduling, flagged for team follow-up
- **STOP** → Opt-out recorded

## How It Works

```
Spoke Dispatch              Railway Server               Quo
(route planned)  ──POST──→  (process + store)  ──6PM──→  (send SMS)
                             webhook                      │
                                                         ↓
Quo Reply        ──POST──→  (track YES/NO)    ←──reply── Customer
(message.received) webhook
```

1. You schedule deliveries in Spoke Dispatch throughout the day
2. Spoke fires webhooks to Railway — stops are stored as "pending"
3. At 6 PM EST, the scheduler sends all pending SMS for tomorrow's deliveries
4. Customer replies YES or NO — tracked via Quo's reply webhook
5. Dashboard lets you monitor, retry failures, and manage templates

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

| Variable | Value |
|----------|-------|
| `QUO_API_KEY` | Your Quo API key |
| `QUO_PHONE_NUMBER_ID` | Quo phone number ID to send from |
| `SPOKE_API_KEY` | Your Spoke Dispatch API key |
| `BUSINESS_NAME` | `Mattress Overstock` |

### Step 4: Generate a Domain

Railway → **Settings** → **Networking** → **Generate Domain**
You'll get: `https://your-app.up.railway.app`

### Step 5: Configure Webhooks

**In Spoke Dispatch** (Settings → Integrations → Webhooks):
```
https://your-app.up.railway.app/api/spoke/webhook
```

**In Quo** (Settings → Webhooks → message.received):
```
https://your-app.up.railway.app/api/quo/webhook
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/spoke/webhook` | Receives Spoke Dispatch delivery events |
| POST | `/api/quo/webhook` | Receives customer YES/NO/STOP replies |
| GET | `/api/notifications` | List all notifications (filter by store, status, date) |
| POST | `/api/notifications/:id/send` | Manually send/retry a single SMS |
| POST | `/api/notifications/actions/send-all-pending` | Batch send all pending |
| GET | `/api/stats` | Dashboard stats + scheduler status |
| GET | `/api/activity` | Activity log |
| GET | `/api/scheduler` | Scheduler status (next send time, pending count) |
| POST | `/api/scheduler/send-now` | Manually trigger the 6 PM send |
| GET | `/api/template` | Current SMS template |
| PUT | `/api/template` | Update SMS template |
| GET | `/api/connections` | API connection status |
| GET | `/api/health` | Health check |

## Store Mapping

Update `src/webhooks/spoke.js` → `DEPOT_TO_STORE` to match your Spoke Dispatch depot names:

```js
const DEPOT_TO_STORE = {
  "richmond": "richmond",
  "somerset": "somerset",
  "laurel county": "laurel",
  "london": "london",
  "winchester": "winchester",
};
```

## Local Development

```bash
cp .env.example .env
# Edit .env with your API keys
npm install
npm run dev
```

## Notes

- SQLite database stored in `/data/notifications.db`
- Duplicate Spoke stop IDs are automatically ignored
- Scheduler checks every minute if it's 6 PM EST on a weekday
- Manual send available via dashboard or `POST /api/scheduler/send-now`
- For production persistence on Railway, consider adding PostgreSQL
