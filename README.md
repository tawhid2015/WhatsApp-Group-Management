# WACMS — WhatsApp Community Management System

A headless Node.js service that automates WhatsApp group membership with expiry tracking via Google Sheets. Designed to run 24/7 inside a container with auto-restart on crash.

---

## What It Does

1. **Monitors a WhatsApp group** via the Baileys library (no WhatsApp Business API needed).
2. **Auto-detects new joins** — when someone joins the group, they get a 10-day trial added to Google Sheets.
3. **Auto-removes expired members** — checks every 5 minutes; anyone past their expiry date is kicked from the group and their Sheet row is marked "Removed".
4. **Tracks permanent members** — anyone with `Expire = Permanent` is never removed.
5. **Serves a web dashboard** — real-time stats, member list, activity log, manual removal, WhatsApp QR connection.
6. **Handles rejoins** — if a removed/expired member rejoins, they get a fresh 10-day trial.

---

## Tech Stack

| Layer | Tech |
|-------|------|
| Runtime | Node.js 20+ (ES modules) |
| WhatsApp | `@whiskeysockets/baileys` v7 (WebSocket-based, no official API) |
| Web | Express 5, vanilla JS SPA |
| Data | Google Sheets (via Apps Script web app) |
| Auth | Multi-file auth state (Baileys) |
| Process | `run.sh` forever loop with 5s crash recovery |

---

## Project Structure

```
wacms/
├── src/
│   ├── server.js          # Express server, HTTP API, business logic
│   ├── wa.js              # WhatsAppManager — Baileys connection, group ops
│   └── sheets.js          # SheetsClient — Google Sheets read/write helpers
├── public/
│   ├── index.html           # Dashboard SPA
│   ├── app.js               # Dashboard frontend logic
│   ├── app.css              # Dashboard styles
│   └── qr.html              # WhatsApp QR scan page
├── data/
│   └── activity.json        # Persisted activity log (last 500 events)
├── auth_info/               # Baileys auth state (created at runtime, gitignored)
├── .env                     # Secrets (gitignored)
├── .env.example             # Template
├── package.json
├── run.sh                   # 24/7 forever runner
└── README.md
```

---

## Quick Start

### 1. Install

```bash
npm install
```

### 2. Configure `.env`

Copy `.env.example` to `.env` and fill in:

```env
PORT=3000
SHEET_API_URL=https://script.google.com/macros/s/YOUR_SCRIPT_ID/exec
SHEET_NAME=Sheet1
MONITORED_GROUP_ID=123456789@g.us
TIMEZONE=Asia/Dhaka
EXPIRY_CHECK_MS=300000
```

**How to get `MONITORED_GROUP_ID`:** Start the app, go to `/qr.html`, scan the QR to connect WhatsApp, then hit `/api/wa/groups` to list your groups. Copy the `id`.

**How to get `SHEET_API_URL`:** See [Google Sheets Setup](#google-sheets-setup) below.

### 3. Run

Development (auto-reload on file change):
```bash
npm run dev
```

Production (24/7 with crash recovery):
```bash
chmod +x run.sh
./run.sh
```

The dashboard is at `http://localhost:3000`. The QR page is at `/qr.html`.

---

## Google Sheets Setup

WACMS talks to Google Sheets through a **Google Apps Script web app**, not the Sheets API directly. This avoids OAuth complexity.

### 1. Create the Sheet

Make a Google Sheet with these columns in Row 1:

| A | B | C | D |
|---|---|---|---|
| Name | Phone | Joining | Expire |

### 2. Add the Apps Script

1. In the Sheet, go to **Extensions → Apps Script**.
2. Replace the default code with the script below.
3. Click **Deploy → New deployment → Web app**.
4. Set "Execute as: Me", "Who has access: Anyone".
5. Copy the deployed URL into `SHEET_API_URL` in `.env`.

#### Apps Script Code

```javascript
function doGet(e) {
  const sheetName = e.parameter.path || 'Sheet1';
  const action = e.parameter.action;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return json({ error: 'Sheet not found' });

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const col = name => headers.indexOf(name) + 1;

  // READ — return all rows as JSON
  if (action === 'read') {
    const data = sheet.getDataRange().getValues();
    const out = [];
    for (let i = 1; i < data.length; i++) {
      const row = {};
      headers.forEach((h, j) => row[h] = data[i][j]);
      out.push(row);
    }
    return json(out);
  }

  // WRITE — append a new row
  if (action === 'write') {
    const row = headers.map(h => e.parameter[h] || '');
    sheet.appendRow(row);
    return json({ ok: true });
  }

  // UPDATE — find by Phone, update fields
  if (action === 'update') {
    const phone = e.parameter.Phone;
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      const rowPhone = String(data[i][col('Phone')] || '');
      if (normalizePhone(rowPhone) === normalizePhone(phone)) {
        if (e.parameter.Expire !== undefined) {
          sheet.getRange(i + 1, col('Expire')).setValue(e.parameter.Expire);
        }
        if (e.parameter.Joining !== undefined) {
          sheet.getRange(i + 1, col('Joining')).setValue(e.parameter.Joining);
        }
        return json({ ok: true, row: i });
      }
    }
    return json({ error: 'Phone not found' });
  }

  return json({ error: 'Unknown action' });
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function normalizePhone(v) {
  let p = String(v).replace(/[^\d]/g, '').replace(/^00/, '');
  if (p.startsWith('880') && p.length === 13) p = '0' + p.slice(3);
  if (p.length === 10 && p.startsWith('1')) p = '0' + p;
  return p;
}
```

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3000` | HTTP server port |
| `SHEET_API_URL` | **Yes** | — | Google Apps Script web app URL |
| `SHEET_NAME` | No | `Sheet1` | Sheet tab name |
| `MONITORED_GROUP_ID` | **Yes** | — | WhatsApp group JID (e.g. `123@g.us`) |
| `TIMEZONE` | No | `Asia/Dhaka` | For date formatting |
| `EXPIRY_CHECK_MS` | No | `300000` | How often to check for expired members (ms) |

---

## API Endpoints

### WhatsApp
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/wa/status` | Connection status, group ID, retry count |
| GET | `/api/wa/groups` | List all WhatsApp groups (for finding `MONITORED_GROUP_ID`) |
| GET | `/api/wa/group-members` | Current group participants |
| GET | `/api/wa/qr.png` | Current QR code PNG (if not connected) |
| POST | `/api/wa/clear-session` | Clear auth state, force re-login |

### Members & Stats
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/members` | All members from Sheets with `_state` field |
| GET | `/api/stats` | Totals, today's activity, last sync time |
| POST | `/api/expiry/check` | Manually trigger expiry check + auto-removal |
| POST | `/api/members/:phone/remove` | Manually remove a member from WhatsApp group |

### Activity
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/activity` | Last 500 events (joins, leaves, removals, errors) |
| DELETE | `/api/activity` | Clear activity log |

### Health
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | `{ status: 'UP', pid, uptime, ts }` |

---

## Key Design Decisions

### Why Baileys instead of official WhatsApp Business API?
- No Meta approval, no phone number verification, no monthly fees.
- Baileys connects as a regular WhatsApp Web client.
- Trade-off: QR scan required, session stored in `auth_info/` folder.

### Why Google Apps Script instead of Sheets API?
- No OAuth2 service account setup.
- One deploy URL, no token refresh logic.
- Trade-off: Slower on cold start (handled with retry + exponential backoff).

### How rejoins work
When a member rejoins after being removed/expired:
1. Their existing Sheet row is updated: `Joining = now`, `Expire = now + 10 days`.
2. They are NOT re-added (they already joined the group themselves).
3. Activity log records `member_rejoined`.

### Phone normalization
Bangladesh numbers are normalized so these all match:
- `01312345678` → `01312345678`
- `8801312345678` → `01312345678`
- `1312345678` (Sheet auto-stripped leading zero) → `01312345678`

### Expiry states
| `Expire` value | State | Behavior |
|----------------|-------|----------|
| `Permanent` | PERMANENT | Never removed |
| `Removed` | REMOVED | Already removed, skip |
| Valid date string | ACTIVE/EXPIRED | Checked against current time |
| Empty/invalid | NO_EXPIRY / INVALID_EXPIRY | Logged, not auto-removed |

---

## Frontend Dashboard

The dashboard (`public/`) is a single-page vanilla JS app with no build step.

Features:
- Live stats cards (total, active, expired, permanent)
- Today summary (joined, left, removed)
- Member table with search, status badges, manual remove button
- Activity log with pagination
- Auto-refresh every 15 seconds
- Toast notifications

Mobile responsive: sidebar collapses to icons, stats grid goes 2-column, tables scroll horizontally.

---

## Process Architecture

```
┌─────────────────┐     ┌──────────────────┐
│  run.sh         │────▶│  node server.js │
│  (forever loop) │     │  (Express + WA)  │
└─────────────────┘     └────────┬─────────┘
         ▲                       │
         │ crash after 5s         │
         └───────────────────────┘
```

- `run.sh` is the supervisor. If `node` crashes, it restarts after 5 seconds.
- `server.js` handles SIGTERM/SIGINT gracefully, closes the HTTP server.
- `process.on('uncaughtException')` logs and exits, triggering the restart.
- `setTimeout` (not `setInterval`) is used for expiry checks to avoid overlapping runs during blocking operations.

---

## Dependencies

```json
{
  "@whiskeysockets/baileys": "7.0.0-rc14",
  "dotenv": "^17.4.2",
  "express": "^5.1.0",
  "pino": "^9.7.0",
  "qrcode": "^1.5.4"
}
```

- `baileys`: WhatsApp Web socket client
- `express`: HTTP server + static file serving
- `qrcode`: Generate QR PNG from Baileys QR string
- `pino`: Baileys internal logging (silenced)
- `dotenv`: Load `.env`

---

## File Reference for AI Reconstruction

If you need to rebuild this project from scratch, create these files exactly:

1. **`package.json`** — See repo. Dependencies: baileys, express, dotenv, pino, qrcode. Scripts: `dev` (node --watch), `start`, `check`.
2. **`run.sh`** — Bash forever loop. Starts `node src/server.js`, waits, restarts after 5s on exit. Handles SIGTERM/SIGINT cleanup.
3. **`src/sheets.js`** — `SheetsClient` class with `readMembers`, `addMember`, `updateMember`, `updateMemberExpiry`. `retryFetch` with exponential backoff. `normalizePhone`, `formatDhakaDate`, `parseExpiry`, `memberState` utilities. Date parsing handles "Jan 1, 2025 at 12:00 PM" Bangladesh local format.
4. **`src/wa.js`** — `WhatsAppManager` class. Connects via Baileys, stores auth in `auth_info/`. Handles QR, connection events, group participant updates (add/remove), member removal with LID/phone JID resolution. Tracks `participantJids` map for LID-to-phone mapping. `listGroups`, `clearSession`, `remove` methods.
5. **`src/server.js`** — Express app. Mounts static `public/`. Defines all API routes. Integrates `WhatsAppManager` + `SheetsClient`. `handleJoin` for auto-adding/reactivating members. `expiryCheck` loop every `EXPIRY_CHECK_MS`. Activity persistence to `data/activity.json`.
6. **`public/index.html`** — Dashboard SPA markup. Sidebar, stats grid, member table, activity panel.
7. **`public/app.js`** — All frontend logic. Fetch helpers, stats/members/activity loaders, renderers, event handlers, auto-refresh interval.
8. **`public/app.css`** — Dark theme dashboard CSS. Responsive breakpoints at 900px and 560px.
9. **`public/qr.html`** — Standalone QR scan page. Polls `/api/wa/qr.png` and `/api/wa/status` every 3s.
10. **`.env.example`** — Template with all env vars.
11. **`.gitignore`** — `node_modules/`, `.env`, `auth_info/`, `*.log`, `.DS_Store`.

---

## License

MIT — use at your own risk. WhatsApp ToS may prohibit automated clients. This is a personal automation tool.
