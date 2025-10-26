// Clean rewrite of file to resolve merge artifacts
import "dotenv/config";
import express from "express";
import axios from "axios";
import crypto from "crypto";
import fs from "fs";
import path from "path";

const app = express();

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const APP_SECRET = process.env.APP_SECRET;

const PORT = process.env.PORT || 10000;

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
      // Save appointment
      const store = readJSON(APPTS_FILE, { appointments: [] });
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
      store.appointments.push(appt);
      writeJSON(APPTS_FILE, store);
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
