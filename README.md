# WhatsApp Bot

Small Express-based WhatsApp bot using the Meta Graph API.

## Files added
- `package.json` - project manifest with scripts
- `server.js` - the bot server (uses ESM imports)
- `.env.example` - example environment file

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
	- `menu` — simple menu
	- `echo <text>` — bot repeats your text
- Health check: `GET /healthz` returns `{"status":"ok"}`.
- Optional request verification: set `APP_SECRET` to enable `X-Hub-Signature-256` verification.
- For production, rotate tokens regularly and restrict access.
- You may want to add persistent logging and retries for failed API calls.
