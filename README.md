# 💬 WhatsApp Repair Bot - Admin Dashboard# WhatsApp Bot



Modern WhatsApp bot with a beautiful, feature-rich admin dashboard for managing phone repair inquiries, appointments, and customer conversations.Small Express-based WhatsApp bot using the Meta Graph API.



## ✨ Features## Files added

- `package.json` - project manifest with scripts

### 🤖 Bot Capabilities- `server.js` - the bot server (uses ESM imports)

- **Intelligent Conversation Flow**: Guided estimate and booking flows- `.env.example` - example environment file

- **Real-time Responses**: Instant replies to customer inquiries- `data/repairs.json` - editable price list for brands/models/issues

- **Price Lookup**: Quick repair cost estimates by brand/model/issue- `data/appointments.json` - saved appointments (auto-created at runtime)

- **Appointment Booking**: Complete booking system with date/time scheduling

- **Session Management**: Maintains conversation context## Requirements

- Node.js 18+ recommended

### 🎨 Admin Dashboard

- **Modern UI/UX**: Beautiful gradient design with smooth animations## Setup (Windows PowerShell)

- **Real-time Chat Interface**: View and reply to customer messages directly

- **Live Conversations**: See all active chats with message history1. Copy environment example and fill values:

- **Appointment Management**: Track, confirm, complete, or cancel appointments

- **Statistics Dashboard**: Real-time metrics for chats, appointments, and status```powershell

- **Quick Actions**: Send messages to any WhatsApp number instantlycp .env.example .env

- **Auto-refresh**: Automatic data updates every 30 seconds# then open .env and paste your real tokens

- **Responsive Design**: Works on desktop, tablet, and mobile devices```

- **Toast Notifications**: User-friendly feedback for all actions

2. Install dependencies:

## 📁 Project Structure

```powershell

```npm install

watsapp bot/```

├── server.js              # Express server with WhatsApp integration

├── package.json           # Dependencies and scripts3. Run locally:

├── .env.example           # Environment variables template

├── README.md             # This file```powershell

├── data/npm start

│   ├── repairs.json      # Repair pricing catalog# or for development with auto-reload (if you install dev deps):

│   ├── appointments.json # Saved appointmentsnpm run dev

│   └── inquiries.log     # Message logs (if not using MongoDB)```

└── public/

    └── admin.html        # Modern admin dashboard UI## Environment variables

```Set these environment variables locally (PowerShell example):



## 🚀 Quick Start```powershell

$env:VERIFY_TOKEN = "your_verify_token"

### Prerequisites$env:ACCESS_TOKEN = "your_access_token"

- Node.js 18+ recommended$env:PHONE_NUMBER_ID = "your_phone_number_id"

- MongoDB (optional - can use in-memory database for development)$env:PORT = 10000

- WhatsApp Business API credentials from Metanode server.js

```

### Installation

When deploying to Render, set `VERIFY_TOKEN`, `ACCESS_TOKEN`, and `PHONE_NUMBER_ID` in the service's Environment settings.

1. **Install dependencies**:

```powershell## Webhook verification

npm installWhen you set up the webhook in Meta, use the `VERIFY_TOKEN` you configured. Meta will call `GET /webhook` once for verification.

```

## Notes & next steps

2. **Configure environment** (create `.env` file from example)- Built-in commands now:

  - `hi` or `hello` — greeting

3. **Start the server**:  - `help` — list options

```powershell  - `menu` — menu with features

npm start  - `estimate` — guided flow to pick brand/model/issue and get a price

```  - `price <brand> <model> <issue>` — quick lookup (e.g., `price Apple iPhone 11 Screen`)

  - `book` — book an appointment (name, device, issue, date/time)

4. **Access Admin Dashboard**:  - `cancel` — cancel the current flow

   - Open browser: `http://localhost:15000/admin`  - `echo <text>` — debug: bot repeats your text

   - Enter your `ADMIN_TOKEN` from `.env`- Health check: `GET /healthz` returns `{"status":"ok"}`.

- Optional request verification: set `APP_SECRET` to enable `X-Hub-Signature-256` verification.

## 🔧 Configuration- For production, rotate tokens regularly and restrict access.

- You may want to add persistent logging and retries for failed API calls.

### Environment Variables

## Editing prices

Create a `.env` file with these settings:Update `data/repairs.json` with your own pricing. Structure:



```env```json

# WhatsApp Business API Credentials{

VERIFY_TOKEN=your_verify_token_here  "Brand": {

ACCESS_TOKEN=your_whatsapp_access_token_here    "Model": {

PHONE_NUMBER_ID=your_phone_number_id_here      "Issue/Part": 1234

APP_SECRET=your_app_secret_here    }

  }

# MongoDB Configuration}

MONGO_URI=mongodb://localhost:27017/watsapp_bot```

# OR use in-memory MongoDB for development:

USE_MEMORY_DB=trueExamples are provided for Apple, Samsung, Xiaomi, OnePlus. The bot reloads this file on demand when estimate flow starts.

MONGO_DB=watsapp_bot

## Appointments

# Admin Panel ConfigurationConfirmed bookings are appended to `data/appointments.json` with an auto-generated ID and the user’s WhatsApp number. You can read this file to manage your schedule.

ADMIN_TOKEN=local-admin-12345
ADMIN_ORIGIN=http://localhost:15000

# Server Configuration
PORT=15000

# Development Settings
DEV_FAKE_SEND=false
```

## 💻 Admin Dashboard Usage

### 1. **Login**
- Enter your `ADMIN_TOKEN` in the header
- Optionally set backend URL if different from current domain

### 2. **View Conversations**
- Left panel shows all customer conversations
- Click any conversation to view message history
- Real-time updates every 30 seconds

### 3. **Reply to Customers**
- Select a conversation
- Type your message in the composer
- Press Enter or click Send
- Messages appear instantly in the chat

### 4. **Quick Message**
- Use the right panel to send messages to any number
- Enter phone number (format: 91xxxxxxxxxx)
- Type message and click Send

### 5. **Manage Appointments**
- View all appointments in the right panel
- Filter by status (pending/confirmed/completed/cancelled)
- Click action buttons to update status
- See customer details, device info, and estimates

### 6. **Monitor Stats**
- Dashboard shows real-time statistics:
  - Total conversations
  - Total appointments
  - Pending appointments
  - Completed appointments

## 🤖 Bot Commands

Customers can interact with the bot using these commands:

| Command | Description |
|---------|-------------|
| `hi` or `hello` | Greeting and welcome message |
| `help` | Show available options |
| `menu` | Display main menu |
| `estimate` | Get repair cost estimate (guided flow) |
| `book` | Book an appointment (guided flow) |
| `price <brand> <model> <issue>` | Quick price lookup |
| `cancel` | Cancel current flow |

## 📝 Customizing Repair Prices

Edit `data/repairs.json`:

```json
{
  "Apple": {
    "iPhone 13": {
      "Screen": 15000,
      "Battery": 4500,
      "Charging Port": 3000
    }
  }
}
```

## 🗄️ Database

### MongoDB (Production)
Set `MONGO_URI` to your MongoDB connection string

### In-Memory Database (Development)
Set `USE_MEMORY_DB=true` for local development

### File Storage (Fallback)
Data stored in `data/` folder if MongoDB unavailable

## 🚀 Deployment

Works on any Node.js hosting platform:
- Render
- Heroku
- Railway
- DigitalOcean
- AWS
- Google Cloud

## 📱 API Endpoints

### Public Endpoints
- `GET /healthz` - Health check
- `GET /webhook` - Webhook verification
- `POST /webhook` - Receive WhatsApp messages

### Admin Endpoints (Requires `x-admin-token` header)
- `GET /admin` - Admin dashboard UI
- `GET /admin/health` - Server and DB health status
- `GET /admin/chats` - List all conversations
- `GET /admin/messages?contact=<number>` - Get conversation history
- `POST /admin/reply` - Send message to customer
- `GET /admin/appointments?status=<status>` - List appointments
- `PATCH /admin/appointments/:id` - Update appointment status

## 🎨 UI Features

- **Gradient Backgrounds**: Beautiful purple/blue gradient theme
- **Smooth Animations**: Slide, fade, and bounce effects
- **Status Badges**: Color-coded appointment statuses
- **Toast Notifications**: Non-intrusive success/error messages
- **Loading States**: Clear feedback during operations
- **Empty States**: Helpful messages when no data
- **Responsive Design**: Works on all devices
- **Custom Scrollbars**: Styled for modern appearance

## 🛠️ Development

```powershell
# Development mode with auto-restart
npm run dev

# Test webhook locally with ngrok
ngrok http 15000
```

## 📄 License

ISC

---

**Need Help?** Check the server logs for detailed error messages and debugging information.
