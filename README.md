# WhatsApp Bot

Small Express-based WhatsApp bot using the Meta Graph API.

## Files added
- `package.json` - project manifest with scripts
- `server.js` - the bot server (uses ESM imports)
- `.env.example` - example environment file
- `data/repairs.json` - editable price list for brands/models/issues
- `data/appointments.json` - saved appointments (auto-created at runtime)

## Requirements
- Node.js 18+ recommended

## Setup (Windows PowerShell)

1. Copy environment example and fill values:

```powershell
cp .env.example .env
# then open .env and paste your real tokens
```

2. Install dependencies:

```powershell
npm install
```

3. Run locally:

```powershell
npm start
# or for development with auto-reload (if you install dev deps):
npm run dev
```

## Environment variables
Set these environment variables locally (PowerShell example):

```powershell
$env:VERIFY_TOKEN = "your_verify_token"
$env:ACCESS_TOKEN = "your_access_token"
$env:PHONE_NUMBER_ID = "your_phone_number_id"
$env:PORT = 10000
node server.js
```

When deploying to Render, set `VERIFY_TOKEN`, `ACCESS_TOKEN`, and `PHONE_NUMBER_ID` in the service's Environment settings.

## Webhook verification
When you set up the webhook in Meta, use the `VERIFY_TOKEN` you configured. Meta will call `GET /webhook` once for verification.

## Notes & next steps
- Built-in commands now:
  - `hi` or `hello` — greeting
  - `help` — list options
  - `menu` — menu with features
  - `estimate` — guided flow to pick brand/model/issue and get a price
  - `price <brand> <model> <issue>` — quick lookup (e.g., `price Apple iPhone 11 Screen`)
  - `book` — book an appointment (name, device, issue, date/time)
  - `cancel` — cancel the current flow
  - `echo <text>` — debug: bot repeats your text
- Health check: `GET /healthz` returns `{"status":"ok"}`.
- Optional request verification: set `APP_SECRET` to enable `X-Hub-Signature-256` verification.
- For production, rotate tokens regularly and restrict access.
- You may want to add persistent logging and retries for failed API calls.

## Editing prices
Update `data/repairs.json` with your own pricing. Structure:

```json
{
  "Brand": {
    "Model": {
      "Issue/Part": 1234
    }
  }
}
```

Examples are provided for Apple, Samsung, Xiaomi, OnePlus. The bot reloads this file on demand when estimate flow starts.

## Appointments
Confirmed bookings are appended to `data/appointments.json` with an auto-generated ID and the user’s WhatsApp number. You can read this file to manage your schedule.
