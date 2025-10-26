// Clean rewrite of file to resolve merge artifacts
import "dotenv/config";
import express from "express";
import axios from "axios";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import cors from "cors";

// Environment variables (declare early so middleware can use them)
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const APP_SECRET = process.env.APP_SECRET;
const MONGO_URI = process.env.MONGO_URI;
const USE_MEMORY_DB = (process.env.USE_MEMORY_DB || "").toLowerCase() === "true";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const ADMIN_ORIGIN = process.env.ADMIN_ORIGIN; // optional CORS origin for admin UI
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PORT = process.env.PORT || 10000;
let memServer = null; // holds in-memory Mongo instance for dev
const DEV_FAKE_SEND = (process.env.DEV_FAKE_SEND || "").toLowerCase() === "true"; // allow saving outgoing even if WA send fails

const app = express();

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// Enable CORS for admin routes when ADMIN_ORIGIN is provided
if (ADMIN_ORIGIN) {
  const corsOptions = {
    origin: ADMIN_ORIGIN,
    methods: ["GET", "POST", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "x-admin-token"],
  };
  app.options(["/admin", "/admin/*"], cors(corsOptions));
  app.use(["/admin", "/admin/*"], cors(corsOptions));
}

// --- Simple storage helpers -------------------------------------------------
const DATA_DIR = path.resolve("./data");
const APPTS_FILE = path.join(DATA_DIR, "appointments.json");
const REPAIRS_FILE = path.join(DATA_DIR, "repairs.json");

function ensureDataFiles() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(APPTS_FILE)) fs.writeFileSync(APPTS_FILE, JSON.stringify({ appointments: [] }, null, 2));
  } catch (e) {
    console.error("Failed to prepare data directory:", e.message);
  }
}

function readJSON(file, fallback) {
  try {
    const txt = fs.readFileSync(file, "utf8");
    return JSON.parse(txt);
  } catch {
    return fallback;
  }
}

function writeJSON(file, obj) {
  try {
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, file);
  } catch (e) {
    console.error("Failed writing", file, e.message);
  }
}

ensureDataFiles();

// Load repair price catalog (hot-loaded in memory; edit data/repairs.json to customize)
let REPAIRS = readJSON(REPAIRS_FILE, {});
function reloadRepairs() {
  REPAIRS = readJSON(REPAIRS_FILE, REPAIRS || {});
}

// --- MongoDB setup ----------------------------------------------------------
let mongoReady = false;
const AppointmentSchema = new mongoose.Schema(
  {
    customerWhatsApp: String,
    name: String,
    brand: String,
    model: String,
    issue: String,
    estimate: Number,
    date: String,
    time: String,
    status: { type: String, default: "pending" },
  },
  { timestamps: true }
);
const InquirySchema = new mongoose.Schema(
  {
    // Unified chat log schema
    contact: String, // customer's WA number
    direction: { type: String, enum: ["in", "out"], required: true },
    from: String,
    to: String,
    type: String,
    text: String,
    status: String,
    raw: Object,
  },
  { timestamps: true }
);

let Appointment;
let Inquiry;
(async () => {
  try {
    if (USE_MEMORY_DB || (MONGO_URI && MONGO_URI.toLowerCase() === "memory")) {
      // Start an in-memory MongoDB for local development (no external install needed)
      const { MongoMemoryServer } = await import("mongodb-memory-server");
      memServer = await MongoMemoryServer.create();
      const memUri = memServer.getUri();
      await mongoose.connect(memUri, { dbName: process.env.MONGO_DB || "watsapp_bot" });
      console.log("Started in-memory MongoDB for dev at", memUri);
      Appointment = mongoose.models.Appointment || mongoose.model("Appointment", AppointmentSchema);
      Inquiry = mongoose.models.Inquiry || mongoose.model("Inquiry", InquirySchema);
      mongoReady = true;
      // Optional: clean up on process exit
      const cleanup = async () => { try { await mongoose.disconnect(); if(memServer){ await memServer.stop(); memServer=null; } } catch {} };
      process.on("SIGINT", cleanup);
      process.on("SIGTERM", cleanup);
      return;
    }
    if (MONGO_URI) {
      await mongoose.connect(MONGO_URI, { dbName: process.env.MONGO_DB || undefined });
      Appointment = mongoose.models.Appointment || mongoose.model("Appointment", AppointmentSchema);
      Inquiry = mongoose.models.Inquiry || mongoose.model("Inquiry", InquirySchema);
      mongoReady = true;
      console.log("Connected to MongoDB");
    } else {
      console.warn("MONGO_URI not set — using JSON file storage for appointments/inquiries.");
    }
  } catch (e) {
    console.error("MongoDB connection error:", e.message);
  }
})();

// Track connection state reliably
function dbConnected() {
  // 1 = connected, per Mongoose docs
  return mongoose?.connection?.readyState === 1;
}
mongoose.connection.on("connected", () => { mongoReady = true; console.log("Mongo connected"); });
mongoose.connection.on("disconnected", async () => {
  mongoReady = false;
  console.warn("Mongo disconnected");
  // If using in-memory server, attempt a quick reconnect
  try {
    if (memServer) {
      const uri = memServer.getUri();
      setTimeout(() => {
        mongoose.connect(uri, { dbName: process.env.MONGO_DB || "watsapp_bot" }).catch(() => {});
      }, 500);
    }
  } catch {}
});
mongoose.connection.on("error", (err) => { mongoReady = false; console.error("Mongo error:", err?.message || err); });

async function sendTextMessage(to, body) {
  if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    console.error("Missing ACCESS_TOKEN or PHONE_NUMBER_ID in environment variables");
    throw new Error("Missing WhatsApp credentials");
  }
  const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;
  try {
    await axios.post(
      url,
      { messaging_product: "whatsapp", to, text: { body } },
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );
    // Save outgoing message
    await saveOutgoing(to, body);
  } catch (err) {
    logGraphError(err, "sendTextMessage");
    throw err;
  }
}

// Optional: send a quick reply menu as plain text list
async function sendMenu(to) {
  const lines = [
    "Menu:",
    "1) Get Estimate",
    "2) Book Appointment",
    "3) Help",
    "Tip: type 'estimate' or 'book' to start. Type 'cancel' anytime.",
  ];
  await sendTextMessage(to, lines.join("\n"));
}

app.get("/healthz", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

// Admin health endpoint to verify DB connectivity
app.get("/admin/health", (req, res) => {
  res.json({
    mongoReady,
    db: mongoose.connection?.name || process.env.MONGO_DB || null,
    node: process.version,
    uptime: process.uptime(),
    ts: new Date().toISOString(),
  });
});

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode && token) {
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("WEBHOOK_VERIFIED");
      return res.status(200).send(challenge);
    }
    console.warn("WEBHOOK_VERIFICATION_FAILED - Token Mismatch");
    return res.sendStatus(403);
  }
  console.warn("WEBHOOK_VERIFICATION_FAILED - Missing parameters");
  return res.sendStatus(400);
});

function isValidSignature(req) {
  try {
    if (!APP_SECRET) return true;
    const signature = req.get("x-hub-signature-256");
    if (!signature || !signature.startsWith("sha256=")) return false;
    const expected =
      "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(req.rawBody).digest("hex");
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch (e) {
    console.error("Signature verification error:", e.message);
    return false;
  }
}

function logGraphError(error, context) {
  const tag = context ? `[${context}] ` : "";
  const data = error?.response?.data?.error || error?.response?.data || error?.message || error;
  const code = data?.code;
  const subcode = data?.error_subcode;
  if (code === 190) {
    console.error(
      `${tag}OAuth 190 (token issue). ${subcode === 463 ? "Token expired" : "Invalid token"}. Update ACCESS_TOKEN and restart.`
    );
  }
  console.error(`${tag}Graph API error:`, JSON.stringify(data, null, 2));
}

// --- Gemini AI Integration --------------------------------------------------
async function askGemini(userMessage, conversationHistory = []) {
  if (!GEMINI_API_KEY) {
    console.warn("GEMINI_API_KEY not configured - AI responses disabled");
    return null;
  }
  
  try {
    const systemContext = `You are a helpful assistant for a phone repair shop. 
We repair phones from multiple brands. Use the listBrands() function to see available brands.
You can help customers with:
- Getting repair estimates (guide them to type 'estimate')
- Booking appointments (guide them to type 'book')
- General questions about repairs, pricing, and services
- Device troubleshooting tips

Keep responses short (2-3 sentences), friendly, and helpful.
Always suggest typing 'estimate' or 'book' when customers want specific services.`;

    // Build conversation context
    let contextMessages = conversationHistory.map(msg => 
      `${msg.direction === 'in' ? 'Customer' : 'Assistant'}: ${msg.text}`
    ).join('\n');
    
    const prompt = contextMessages 
      ? `${systemContext}\n\nConversation history:\n${contextMessages}\n\nCustomer: ${userMessage}\n\nAssistant:`
      : `${systemContext}\n\nCustomer: ${userMessage}\n\nAssistant:`;

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents: [{
          parts: [{ text: prompt }]
        }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 200,
          topP: 0.8,
          topK: 40
        }
      },
      {
        headers: { 'Content-Type': 'application/json' }
      }
    );

    const aiText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    return aiText?.trim() || null;
  } catch (error) {
    console.error('Gemini AI error:', error.response?.data || error.message);
    return null;
  }
}

async function getConversationHistory(contact, limit = 5) {
  try {
    if (mongoReady && Inquiry && dbConnected()) {
      const messages = await Inquiry.find({ contact })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();
      return messages.reverse(); // oldest first
    }
    return [];
  } catch (error) {
    console.error('Error fetching conversation history:', error.message);
    return [];
  }
}

async function handleTextCommand(from, text) {
  const t = (text || "").trim().toLowerCase();
  // Route active sessions first
  if (hasActiveSession(from)) {
    await continueSession(from, text);
    return;
  }

  if (t === "hi" || t === "hello") {
    await sendTextMessage(
      from,
      "Hey! I can help you with phone repair estimates and booking appointments. Type 'menu' to begin."
    );
    return;
  }
  if (t === "help") {
    await sendTextMessage(
      from,
      [
        "I can do these:",
        "• estimate — get repair cost by brand/model/issue",
        "• book — book an appointment",
        "• menu — show options",
        "• cancel — stop current flow",
      ].join("\n")
    );
    return;
  }
  if (t === "menu") {
    await sendMenu(from);
    return;
  }
  if (t.startsWith("echo ")) {
    await sendTextMessage(from, text.slice(5));
    return;
  }
  if (t === "estimate" || t === "get estimate") {
    await startEstimateFlow(from);
    return;
  }
  if (["book", "appointment", "book appointment"].includes(t)) {
    await startBookingFlow(from);
    return;
  }
  if (t === "cancel" || t === "reset") {
    endSession(from);
    await sendTextMessage(from, "Okay, I’ve cancelled the current flow. Type 'menu' to start again.");
    return;
  }
  // Quick price lookup: price <brand> <model> <issue>
  if (t.startsWith("price ")) {
    const parts = text.trim().split(/\s+/).slice(1);
    if (parts.length >= 3) {
      const brand = capitalize(parts[0]);
      const issue = capitalize(parts.pop());
      const model = parts.join(" ");
      const cost = getIssuePrice(brand, model, issue);
      if (typeof cost === "number") {
        await sendTextMessage(
          from,
          `Estimated cost for ${brand} ${model} (${issue}): ₹${cost.toLocaleString("en-IN")}`
        );
      } else {
        await sendTextMessage(
          from,
          "Sorry, I don't have that exact item. Type 'estimate' to browse supported brands and models."
        );
      }
      return;
    }
  }

  
  // AI-powered fallback for unknown queries
  try {
    const history = await getConversationHistory(from, 5);
    const aiResponse = await askGemini(text, history);
    
    if (aiResponse) {
      await sendTextMessage(from, aiResponse);
      return;
    }
  } catch (error) {
    console.error('AI fallback error:', error.message);
  }

  // Final fallback if AI fails
  await sendTextMessage(from, "I didn’t catch that. Type 'menu' to see options.");
}

// --- Session and flows ------------------------------------------------------
const sessions = new Map(); // from -> { flow, step, data }

function hasActiveSession(id) {
  const s = sessions.get(id);
  return s && s.step !== "idle";
}

function beginSession(id, flow) {
  sessions.set(id, { flow, step: "start", data: {}, lastActive: Date.now() });
}
function endSession(id) {
  sessions.delete(id);
}

function capitalize(s) {
  return (s || "").replace(/\b\w/g, (c) => c.toUpperCase());
}

function listBrands() {
  return Object.keys(REPAIRS).sort();
}
function listModels(brand) {
  return Object.keys(REPAIRS[brand] || {}).sort();
}
function listIssues(brand, model) {
  const m = REPAIRS[brand]?.[model] || {};
  return Object.keys(m).sort();
}
function getIssuePrice(brand, model, issue) {
  const price = REPAIRS[brand]?.[model]?.[issue];
  return typeof price === "number" ? price : null;
}

async function startEstimateFlow(from) {
  reloadRepairs();
  const brands = listBrands();
  if (!brands.length) {
    await sendTextMessage(from, "No repair data found yet. Please add items to data/repairs.json.");
    return;
  }
  beginSession(from, "estimate");
  const msg = [
    "Let’s get your estimate.",
    "Pick a brand by number:",
    ...brands.map((b, i) => `${i + 1}) ${b}`),
    "Or type the brand name.",
  ].join("\n");
  sessions.get(from).step = "brand";
  await sendTextMessage(from, msg);
}

async function startBookingFlow(from) {
  beginSession(from, "booking");
  sessions.get(from).step = "name";
  await sendTextMessage(from, "Let’s book an appointment. What’s your name?");
}

async function continueSession(from, text) {
  const s = sessions.get(from);
  if (!s) return;
  s.lastActive = Date.now();
  const t = (text || "").trim();
  if (t.toLowerCase() === "cancel" || t.toLowerCase() === "reset") {
    endSession(from);
    await sendTextMessage(from, "Cancelled. Type 'menu' to start again.");
    return;
  }

  if (s.flow === "estimate") return continueEstimate(from, s, t);
  if (s.flow === "booking") return continueBooking(from, s, t);
}

async function continueEstimate(from, s, input) {
  switch (s.step) {
    case "brand": {
      const brands = listBrands();
      const idx = parseInt(input, 10);
      let brand = brands[idx - 1];
      if (!brand) brand = capitalize(input);
      if (!REPAIRS[brand]) {
        await sendTextMessage(from, "Please choose a valid brand number or name from the list.");
        return;
      }
      s.data.brand = brand;
      s.step = "model";
      const models = listModels(brand);
      await sendTextMessage(
        from,
        [
          `Brand: ${brand}`,
          "Select a model by number:",
          ...models.map((m, i) => `${i + 1}) ${m}`),
          "Or type the exact model name.",
        ].join("\n")
      );
      return;
    }
    case "model": {
      const models = listModels(s.data.brand);
      const idx = parseInt(input, 10);
      let model = models[idx - 1];
      if (!model) model = input;
      if (!REPAIRS[s.data.brand]?.[model]) {
        await sendTextMessage(from, "Please choose a valid model from the list.");
        return;
      }
      s.data.model = model;
      s.step = "issue";
      const issues = listIssues(s.data.brand, model);
      await sendTextMessage(
        from,
        [
          `Model: ${model}`,
          "What needs repair?",
          ...issues.map((m, i) => `${i + 1}) ${m}`),
          "Reply with the number or issue name.",
        ].join("\n")
      );
      return;
    }
    case "issue": {
      const issues = listIssues(s.data.brand, s.data.model);
      const idx = parseInt(input, 10);
      let issue = issues[idx - 1];
      if (!issue) issue = capitalize(input);
      const price = getIssuePrice(s.data.brand, s.data.model, issue);
      if (price == null) {
        await sendTextMessage(from, "Please choose a valid issue from the list.");
        return;
      }
      s.data.issue = issue;
      s.data.price = price;
      await sendTextMessage(
        from,
        [
          `Estimate for ${s.data.brand} ${s.data.model} (${issue})`,
          `Parts & labor: ₹${price.toLocaleString("en-IN")}`,
          "This is an estimate; final price may vary after diagnosis.",
          "Would you like to book an appointment? (yes/no)",
        ].join("\n")
      );
      s.step = "offer_book";
      return;
    }
    case "offer_book": {
      if (/^y(es)?$/i.test(input)) {
        // jump to booking, pre-fill details
        s.flow = "booking";
        s.step = "name";
        await sendTextMessage(from, "Great! What’s your name?");
        return;
      }
      endSession(from);
      await sendTextMessage(from, "No problem. Type 'menu' if you need anything else.");
      return;
    }
    default:
      endSession(from);
      await sendTextMessage(from, "Session ended. Type 'menu' to start again.");
  }
}

function isValidDate(str) {
  // YYYY-MM-DD
  return /^\d{4}-\d{2}-\d{2}$/.test(str);
}
function isValidTime(str) {
  // HH:MM 24h
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(str);
}

async function continueBooking(from, s, input) {
  switch (s.step) {
    case "name": {
      const name = input.trim();
      if (!name) {
        await sendTextMessage(from, "Please enter your name.");
        return;
      }
      s.data.name = name;
      if (!s.data.brand) {
        // ask brand if coming fresh to booking
        const brands = listBrands();
        reloadRepairs();
        s.step = "brand";
        await sendTextMessage(
          from,
          [
            "Which brand is your phone?",
            ...brands.map((b, i) => `${i + 1}) ${b}`),
            "Reply with number or brand name.",
          ].join("\n")
        );
        return;
      }
      s.step = "date";
      await sendTextMessage(from, "What date would you prefer? (YYYY-MM-DD)");
      return;
    }
    case "brand": {
      const brands = listBrands();
      const idx = parseInt(input, 10);
      let brand = brands[idx - 1];
      if (!brand) brand = capitalize(input);
      if (!REPAIRS[brand]) {
        await sendTextMessage(from, "Please choose a valid brand from the list.");
        return;
      }
      s.data.brand = brand;
      s.step = "model";
      const models = listModels(brand);
      await sendTextMessage(
        from,
        [
          `Brand: ${brand}`,
          "Select model:",
          ...models.map((m, i) => `${i + 1}) ${m}`),
        ].join("\n")
      );
      return;
    }
    case "model": {
      const models = listModels(s.data.brand);
      const idx = parseInt(input, 10);
      let model = models[idx - 1];
      if (!model) model = input;
      if (!REPAIRS[s.data.brand]?.[model]) {
        await sendTextMessage(from, "Please choose a valid model.");
        return;
      }
      s.data.model = model;
      s.step = "issue";
      const issues = listIssues(s.data.brand, model);
      await sendTextMessage(
        from,
        [
          `Model: ${model}`,
          "What’s the issue?",
          ...issues.map((m, i) => `${i + 1}) ${m}`),
        ].join("\n")
      );
      return;
    }
    case "issue": {
      const issues = listIssues(s.data.brand, s.data.model);
      const idx = parseInt(input, 10);
      let issue = issues[idx - 1];
      if (!issue) issue = capitalize(input);
      const price = getIssuePrice(s.data.brand, s.data.model, issue);
      if (price == null) {
        await sendTextMessage(from, "Please choose a valid issue.");
        return;
      }
      s.data.issue = issue;
      s.data.price = price;
      s.step = "date";
      await sendTextMessage(
        from,
        [
          `Noted ${s.data.brand} ${s.data.model} (${issue}) — est. ₹${price.toLocaleString("en-IN")}.`,
          "What date works for you? (YYYY-MM-DD)",
        ].join("\n")
      );
      return;
    }
    case "date": {
      const date = input.trim();
      if (!isValidDate(date)) {
        await sendTextMessage(from, "Please use format YYYY-MM-DD (e.g., 2025-10-26).");
        return;
      }
      s.data.date = date;
      s.step = "time";
      await sendTextMessage(from, "What time? (HH:MM, 24-hour, e.g., 15:30)");
      return;
    }
    case "time": {
      const time = input.trim();
      if (!isValidTime(time)) {
        await sendTextMessage(from, "Please use 24-hour time like 11:00 or 16:30.");
        return;
      }
      s.data.time = time;
      s.step = "confirm";
      await sendTextMessage(
        from,
        [
          "Confirm your appointment:",
          `Name: ${s.data.name}`,
          `Phone (WhatsApp): ${from}`,
          `Device: ${s.data.brand} ${s.data.model}`,
          `Issue: ${s.data.issue}`,
          s.data.price ? `Estimate: ₹${s.data.price.toLocaleString("en-IN")}` : undefined,
          `Preferred: ${s.data.date} ${s.data.time}`,
          "Reply 'yes' to confirm or 'no' to cancel.",
        ].filter(Boolean).join("\n")
      );
      return;
    }
    case "confirm": {
      if (!/^y(es)?$/i.test(input)) {
        endSession(from);
        await sendTextMessage(from, "Okay, I’ve cancelled the booking.");
        return;
      }
      // Save appointment (Mongo if available, else JSON)
      const appt = {
        id: "appt_" + Date.now(),
        createdAt: new Date().toISOString(),
        customerWhatsApp: from,
        name: s.data.name,
        brand: s.data.brand,
        model: s.data.model,
        issue: s.data.issue,
        estimate: s.data.price ?? null,
        date: s.data.date,
        time: s.data.time,
        status: "pending",
      };
      if (mongoReady && Appointment) {
        const saved = await Appointment.create({
          customerWhatsApp: appt.customerWhatsApp,
          name: appt.name,
          brand: appt.brand,
          model: appt.model,
          issue: appt.issue,
          estimate: appt.estimate,
          date: appt.date,
          time: appt.time,
          status: appt.status,
        });
        appt.id = String(saved._id);
      } else {
        const store = readJSON(APPTS_FILE, { appointments: [] });
        store.appointments.push(appt);
        writeJSON(APPTS_FILE, store);
      }
      endSession(from);
      await sendTextMessage(
        from,
        [
          "✅ Appointment booked!",
          `ID: ${appt.id}`,
          `When: ${appt.date} ${appt.time}`,
          "We’ll contact you to confirm. Reply 'menu' for more options.",
        ].join("\n")
      );
      return;
    }
    default:
      endSession(from);
      await sendTextMessage(from, "Session ended. Type 'menu' to start again.");
  }
}

// --- Save incoming inquiries/messages --------------------------------------
async function saveInquiry(message) {
  try {
    if (!message) return;
    const from = message.from; // customer's number
    const type = message.type;
    const text = type === "text" ? message.text?.body : undefined;
    if (mongoReady && Inquiry) {
      await Inquiry.create({
        contact: from,
        direction: "in",
        from,
        to: PHONE_NUMBER_ID,
        type,
        text,
        status: undefined,
        raw: message,
      });
    } else {
      // optionally append to a local log file
      const logFile = path.join(DATA_DIR, "inquiries.log");
      fs.appendFileSync(
        logFile,
        JSON.stringify({ ts: new Date().toISOString(), contact: from, direction: "in", from, to: PHONE_NUMBER_ID, type, text }) +
          "\n"
      );
    }
  } catch (e) {
    console.error("Failed to save inquiry:", e.message);
  }
}

async function saveOutgoing(to, body) {
  try {
    if (mongoReady && Inquiry) {
      await Inquiry.create({
        contact: to,
        direction: "out",
        from: PHONE_NUMBER_ID,
        to,
        type: "text",
        text: body,
      });
    } else {
      const logFile = path.join(DATA_DIR, "inquiries.log");
      fs.appendFileSync(
        logFile,
        JSON.stringify({ ts: new Date().toISOString(), contact: to, direction: "out", from: PHONE_NUMBER_ID, to, type: "text", text: body }) +
          "\n"
      );
    }
  } catch (e) {
    console.error("Failed to save outgoing:", e.message);
  }
}

// Dev helper: save an inbound text message (simulates a user message)
async function saveInboundText(from, body) {
  try {
    if (mongoReady && Inquiry && dbConnected()) {
      await Inquiry.create({
        contact: from,
        direction: "in",
        from,
        to: PHONE_NUMBER_ID,
        type: "text",
        text: body,
      });
    } else {
      const logFile = path.join(DATA_DIR, "inquiries.log");
      fs.appendFileSync(
        logFile,
        JSON.stringify({ ts: new Date().toISOString(), contact: from, direction: "in", from, to: PHONE_NUMBER_ID, type: "text", text: body }) +
          "\n"
      );
    }
  } catch (e) {
    console.error("Failed to save inbound (dev):", e.message);
  }
}

app.post("/webhook", async (req, res) => {
  if (!isValidSignature(req)) {
    console.warn("Invalid signature on webhook request");
    return res.sendStatus(401);
  }
  try {
    const value = req.body.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];
    const statuses = value?.statuses?.[0];
    if (message) {
      const from = message.from;
      const type = message.type;
      console.log("Incoming message", { from, type });
      // Save inquiry
      await saveInquiry(message);
      if (type === "text") {
        const text = message.text?.body || "";
        await handleTextCommand(from, text);
      } else if (type === "interactive") {
        const payload =
          message.interactive?.button_reply?.id || message.interactive?.list_reply?.id;
        await handleTextCommand(from, payload || "");
      } else {
        await sendTextMessage(from, "Thanks for your message! Send 'help' for options.");
      }
    }
    if (statuses) {
      console.log("Status update", {
        id: statuses.id,
        status: statuses.status,
        timestamp: statuses.timestamp,
      });
    }
  } catch (error) {
    logGraphError(error, "webhook");
  }
  return res.sendStatus(200);
});

// --- Simple admin API and UI -----------------------------------------------
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return res.status(403).json({ error: "ADMIN_TOKEN not configured" });
  const token = req.get("x-admin-token") || req.query.admin_token;
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// Send WhatsApp notification when appointment status changes
async function sendStatusNotification(customerWhatsApp, appointment, newStatus) {
  try {
    let message = "";
    const device = `${appointment.brand || ''} ${appointment.model || ''}`.trim();
    const issue = appointment.issue || '';
    const dateTime = `${appointment.date || ''} at ${appointment.time || ''}`.trim();
    const estimate = appointment.estimate ? `₹${appointment.estimate.toLocaleString('en-IN')}` : '';
    
    switch (newStatus) {
      case 'confirmed':
        message = [
          `✅ *Appointment Confirmed!*`,
          ``,
          `Hello ${appointment.name || 'Customer'}!`,
          ``,
          `Your repair appointment has been confirmed:`,
          `📱 Device: ${device}`,
          `🔧 Issue: ${issue}`,
          estimate ? `💰 Estimate: ${estimate}` : '',
          `📅 Date & Time: ${dateTime}`,
          ``,
          `We look forward to seeing you! Please arrive 5 minutes early.`,
          ``,
          `Reply with any questions or type 'help' for options.`
        ].filter(Boolean).join('\n');
        break;
        
      case 'completed':
        message = [
          `✅ *Service Completed!*`,
          ``,
          `Hello ${appointment.name || 'Customer'}!`,
          ``,
          `Your ${device} repair has been completed successfully! 🎉`,
          ``,
          `Issue fixed: ${issue}`,
          estimate ? `Amount: ${estimate}` : '',
          ``,
          `Thank you for choosing our service!`,
          `Please rate your experience by replying 1-5 stars.`,
          ``,
          `We hope to serve you again soon!`
        ].filter(Boolean).join('\n');
        break;
        
      case 'cancelled':
        message = [
          `❌ *Appointment Cancelled*`,
          ``,
          `Hello ${appointment.name || 'Customer'}!`,
          ``,
          `Your appointment for ${device} repair has been cancelled.`,
          ``,
          `📅 Was scheduled for: ${dateTime}`,
          ``,
          `If you'd like to reschedule, please type 'book' to create a new appointment.`,
          ``,
          `We're here to help if you have any questions!`
        ].filter(Boolean).join('\n');
        break;
        
      default:
        // Don't send notification for pending or other statuses
        return;
    }
    
    if (message) {
      await sendTextMessage(customerWhatsApp, message);
      console.log(`Sent ${newStatus} notification to ${customerWhatsApp}`);
    }
  } catch (error) {
    console.error('Failed to send status notification:', error.message);
    // Don't throw - we don't want to fail the status update if notification fails
  }
}

app.get("/admin/appointments", requireAdmin, async (req, res) => {
  const status = req.query.status;
  try {
    if (mongoReady && Appointment && dbConnected()) {
      const q = status ? { status } : {};
      const rows = await Appointment.find(q).sort({ createdAt: -1 }).limit(200);
      return res.json(rows);
    }
    const store = readJSON(APPTS_FILE, { appointments: [] });
    const rows = status ? store.appointments.filter((a) => a.status === status) : store.appointments;
    return res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch("/admin/appointments/:id", requireAdmin, async (req, res) => {
  const id = req.params.id;
  const { status, date, time } = req.body || {};
  try {
    let appointment = null;
    let oldStatus = null;
    
    if (mongoReady && Appointment && dbConnected()) {
      // Get old status first
      const oldDoc = await Appointment.findById(id);
      if (oldDoc) oldStatus = oldDoc.status;
      
      const doc = await Appointment.findByIdAndUpdate(id, { $set: { status, date, time } }, { new: true });
      appointment = doc;
      
      // Send notification if status changed
      if (status && status !== oldStatus && doc.customerWhatsApp) {
        await sendStatusNotification(doc.customerWhatsApp, doc, status);
      }
      
      return res.json(doc);
    }
    
    // JSON file storage
    const store = readJSON(APPTS_FILE, { appointments: [] });
    const idx = store.appointments.findIndex((a) => String(a.id) === String(id));
    if (idx === -1) return res.status(404).json({ error: "Not found" });
    
    oldStatus = store.appointments[idx].status;
    store.appointments[idx] = { 
      ...store.appointments[idx], 
      status: status ?? store.appointments[idx].status, 
      date: date ?? store.appointments[idx].date, 
      time: time ?? store.appointments[idx].time 
    };
    appointment = store.appointments[idx];
    writeJSON(APPTS_FILE, store);
    
    // Send notification if status changed
    if (status && status !== oldStatus && appointment.customerWhatsApp) {
      await sendStatusNotification(appointment.customerWhatsApp, appointment, status);
    }
    
    return res.json(appointment);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/admin/inquiries", requireAdmin, async (_req, res) => {
  try {
    if (mongoReady && Inquiry && dbConnected()) {
      const rows = await Inquiry.find().sort({ createdAt: -1 }).limit(200);
      return res.json(rows);
    }
    // if no DB, read recent from log file
    const logFile = path.join(DATA_DIR, "inquiries.log");
    if (!fs.existsSync(logFile)) return res.json([]);
    const lines = fs.readFileSync(logFile, "utf8").trim().split(/\r?\n/).slice(-200);
    const rows = lines.map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
    return res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/admin/reply", requireAdmin, async (req, res) => {
  try {
    const { to, body } = req.body || {};
    if (!to || !body) return res.status(400).json({ error: "to and body are required" });
    try {
      await sendTextMessage(to, body);
      return res.json({ ok: true });
    } catch (e) {
      if (DEV_FAKE_SEND) {
        // For local/dev usage: save message even if WhatsApp send failed
        await saveOutgoing(to, body);
        return res.json({ ok: true, devFake: true });
      }
      throw e;
    }
  } catch (e) {
    logGraphError(e, "admin.reply");
    res.status(500).json({ error: e.message });
  }
});

// Dev-only: seed a sample conversation
app.post("/admin/seed", requireAdmin, async (req, res) => {
  const { contact = "919999999999", text = "Hi, I need a screen repair" } = req.body || {};
  try {
    await saveInboundText(contact, text);
    await saveOutgoing(contact, "Sure, I can help with that!");
    res.json({ ok: true, contact });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Chat list and message history
app.get("/admin/chats", requireAdmin, async (_req, res) => {
  try {
    if (mongoReady && Inquiry && dbConnected()) {
      const rows = await Inquiry.aggregate([
        { $sort: { createdAt: -1 } },
        {
          $group: {
            _id: "$contact",
            last: { $first: "$$ROOT" },
            count: { $sum: 1 },
          },
        },
        {
          $project: {
            _id: 0,
            contact: "$_id",
            lastText: "$last.text",
            lastAt: "$last.createdAt",
            lastDir: "$last.direction",
            lastType: "$last.type",
            count: 1,
          },
        },
        { $sort: { lastAt: -1 } },
        { $limit: 200 },
      ]);
      return res.json(rows);
    }
    // Fallback: parse from log file
    const logFile = path.join(DATA_DIR, "inquiries.log");
    if (!fs.existsSync(logFile)) return res.json([]);
    const lines = fs.readFileSync(logFile, "utf8").trim().split(/\r?\n/).slice(-1000);
    const items = lines
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const map = new Map();
    for (const it of items) {
      const c = it.contact || it.from;
      if (!map.has(c)) map.set(c, { contact: c, lastText: it.text, lastAt: it.ts || new Date().toISOString(), lastDir: it.direction || "in", count: 0 });
      const rec = map.get(c);
      rec.count += 1;
      // Keep most recent as last
      rec.lastText = it.text || rec.lastText;
    }
    const arr = Array.from(map.values()).sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt)).slice(0, 200);
    return res.json(arr);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/admin/messages", requireAdmin, async (req, res) => {
  try {
    const contact = req.query.contact;
    if (!contact) return res.status(400).json({ error: "contact is required" });
    if (mongoReady && Inquiry && dbConnected()) {
      const msgs = await Inquiry.find({ contact }).sort({ createdAt: 1 }).limit(500);
      return res.json(msgs);
    }
    // Fallback
    const logFile = path.join(DATA_DIR, "inquiries.log");
    if (!fs.existsSync(logFile)) return res.json([]);
    const lines = fs.readFileSync(logFile, "utf8").trim().split(/\r?\n/);
    const msgs = lines
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter((x) => x && (x.contact === contact || x.from === contact))
      .sort((a, b) => new Date(a.ts || a.createdAt) - new Date(b.ts || b.createdAt))
      .slice(-500);
    return res.json(msgs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Serve minimal admin UI
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use("/admin/static", express.static(path.join(__dirname, "public")));
app.get("/admin", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.listen(PORT, () => {
  console.log(`Bot is running on port ${PORT}`);
  if (!VERIFY_TOKEN || !ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    console.warn("--- WARNING: Missing environment variables! Bot may not work correctly. ---");
    console.warn(
      "Please set VERIFY_TOKEN, ACCESS_TOKEN, and PHONE_NUMBER_ID in Render or your environment."
    );
  }
  if (!APP_SECRET) {
    console.warn("(Optional) APP_SECRET not set — request signature verification is disabled.");
  }
});
