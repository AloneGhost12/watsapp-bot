// Clean rewrite of file to resolve merge artifacts
import "dotenv/config";
import express from "express";
import axios from "axios";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import cors from "cors";
import PDFDocument from "pdfkit";

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

// --- PDF Generation for Job Sheet ---------------------------------------------
async function generateJobSheetPDF(appointment) {
  return new Promise((resolve, reject) => {
    try {
      const pdfDir = path.join(DATA_DIR, 'job_sheets');
      if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir, { recursive: true });
      
      const pdfPath = path.join(pdfDir, `job_sheet_${appointment.id}.pdf`);
      const doc = new PDFDocument({ margin: 50, size: 'A4' });
      const stream = fs.createWriteStream(pdfPath);
      
      doc.pipe(stream);
      
      // Header
      doc.fontSize(24).font('Helvetica-Bold').text('JOB SHEET', { align: 'center' });
      doc.moveDown(0.5);
      doc.fontSize(10).font('Helvetica').text('Electronics Repair Center', { align: 'center' });
      doc.text('Phone: 8589838547', { align: 'center' });
      doc.moveDown(1);
      
      // Job ID and Date
      doc.fontSize(10).font('Helvetica-Bold');
      doc.text(`Job ID: ${appointment.id}`, 50, doc.y);
      doc.text(`Date: ${new Date().toLocaleDateString('en-IN')}`, 400, doc.y - 12, { width: 150 });
      doc.moveDown(1);
      
      // Customer Information Box
      const customerBoxTop = doc.y;
      doc.fontSize(12).font('Helvetica-Bold').text('CUSTOMER INFORMATION', 50, customerBoxTop);
      doc.moveDown(0.5);
      
      doc.fontSize(10).font('Helvetica');
      doc.text(`Name: ${appointment.name || 'N/A'}`, 50, doc.y);
      doc.text(`Phone: ${appointment.customerWhatsApp || 'N/A'}`, 50, doc.y + 5);
      doc.text(`Appointment: ${appointment.date || 'N/A'} at ${appointment.time || 'N/A'}`, 50, doc.y + 5);
      doc.moveDown(1.5);
      
      // Device Information Box
      const deviceBoxTop = doc.y;
      doc.fontSize(12).font('Helvetica-Bold').text('DEVICE INFORMATION', 50, deviceBoxTop);
      doc.moveDown(0.5);
      
      doc.fontSize(10).font('Helvetica');
      doc.text(`Brand: ${appointment.brand || 'N/A'}`, 50, doc.y);
      doc.text(`Model: ${appointment.model || 'N/A'}`, 50, doc.y + 5);
      doc.text(`Issue: ${appointment.issue || 'N/A'}`, 50, doc.y + 5);
      doc.moveDown(1.5);
      
      // Estimate Box
      const estimateBoxTop = doc.y;
      doc.fontSize(12).font('Helvetica-Bold').text('COST ESTIMATE', 50, estimateBoxTop);
      doc.moveDown(0.5);
      
      doc.fontSize(10).font('Helvetica');
      const estimateText = appointment.estimate 
        ? `₹${appointment.estimate.toLocaleString('en-IN')}`
        : (appointment.estimateRange || 'To be determined after diagnosis');
      doc.text(`Estimated Cost: ${estimateText}`, 50, doc.y);
      doc.fontSize(8).font('Helvetica-Oblique');
      doc.text('Note: Final cost may vary based on actual diagnosis and parts required.', 50, doc.y + 5);
      doc.moveDown(2);
      
      // Terms and Conditions
      doc.fontSize(10).font('Helvetica-Bold').text('TERMS & CONDITIONS', 50, doc.y);
      doc.moveDown(0.5);
      doc.fontSize(8).font('Helvetica');
      const terms = [
        '1. A diagnostic fee may apply if repair is not completed.',
        '2. All repairs come with a 30-day warranty on parts and labor.',
        '3. Customer data backup is customer\'s responsibility.',
        '4. Devices left unclaimed for 30+ days may be disposed of.',
        '5. Payment is due upon completion of repair.'
      ];
      terms.forEach(term => {
        doc.text(term, 50, doc.y);
        doc.moveDown(0.3);
      });
      
      doc.moveDown(2);
      
      // Signature Section
      const signatureY = doc.y + 20;
      doc.fontSize(10).font('Helvetica');
      doc.text('_______________________', 50, signatureY);
      doc.text('Customer Signature', 50, signatureY + 15);
      
      doc.text('_______________________', 350, signatureY);
      doc.text('Technician Signature', 350, signatureY + 15);
      
      // Footer
      doc.fontSize(8).font('Helvetica-Oblique');
      doc.text('Thank you for choosing our service!', 50, doc.page.height - 50, {
        align: 'center',
        width: doc.page.width - 100
      });
      
      doc.end();
      
      stream.on('finish', () => {
        console.log('PDF generated successfully:', pdfPath);
        resolve(pdfPath);
      });
      
      stream.on('error', reject);
    } catch (error) {
      reject(error);
    }
  });
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
    finalAmount: Number,
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

// Send interactive buttons (max 3 buttons)
async function sendButtons(to, bodyText, buttons) {
  if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    throw new Error("Missing WhatsApp credentials");
  }
  const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;
  try {
    await axios.post(
      url,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: bodyText },
          action: {
            buttons: buttons.map((btn, i) => ({
              type: "reply",
              reply: {
                id: btn.id || `btn_${i}`,
                title: btn.title.substring(0, 20) // Max 20 chars
              }
            }))
          }
        }
      },
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );
    await saveOutgoing(to, bodyText);
  } catch (err) {
    logGraphError(err, "sendButtons");
    // Fallback to text if buttons fail
    const fallback = bodyText + "\n\n" + buttons.map((b, i) => `${i + 1}. ${b.title}`).join("\n");
    await sendTextMessage(to, fallback);
  }
}

// Send interactive list (up to 10 items per section)
async function sendList(to, bodyText, buttonText, sections) {
  if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    throw new Error("Missing WhatsApp credentials");
  }
  const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;
  try {
    await axios.post(
      url,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "list",
          body: { text: bodyText },
          action: {
            button: buttonText.substring(0, 20),
            sections: sections.map(section => ({
              title: section.title,
              rows: section.rows.map(row => ({
                id: row.id,
                title: row.title.substring(0, 24), // Max 24 chars
                description: row.description?.substring(0, 72) // Max 72 chars
              }))
            }))
          }
        }
      },
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );
    await saveOutgoing(to, bodyText);
  } catch (err) {
    logGraphError(err, "sendList");
    // Fallback to text if list fails
    let fallback = bodyText + "\n\n";
    sections.forEach(sec => {
      fallback += `*${sec.title}*\n`;
      sec.rows.forEach((row, i) => {
        fallback += `${i + 1}. ${row.title}\n`;
      });
      fallback += "\n";
    });
    await sendTextMessage(to, fallback);
  }
}

// Send PDF document via WhatsApp
async function sendDocument(to, pdfPath, caption) {
  if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    throw new Error("Missing WhatsApp credentials");
  }
  
  try {
    // Step 1: Upload the PDF to WhatsApp servers
    const formData = new (await import('form-data')).default();
    formData.append('file', fs.createReadStream(pdfPath));
    formData.append('messaging_product', 'whatsapp');
    
    const uploadUrl = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/media`;
    const uploadResponse = await axios.post(uploadUrl, formData, {
      headers: {
        ...formData.getHeaders(),
        'Authorization': `Bearer ${ACCESS_TOKEN}`
      }
    });
    
    const mediaId = uploadResponse.data.id;
    console.log('PDF uploaded to WhatsApp, media ID:', mediaId);
    
    // Step 2: Send the document message
    const messageUrl = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;
    await axios.post(
      messageUrl,
      {
        messaging_product: "whatsapp",
        to,
        type: "document",
        document: {
          id: mediaId,
          caption: caption || "Job Sheet",
          filename: path.basename(pdfPath)
        }
      },
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );
    
    console.log('Document sent successfully to', to);
    await saveOutgoing(to, `[Sent PDF: ${caption || path.basename(pdfPath)}]`);
  } catch (err) {
    console.error('Error sending document:', err.response?.data || err.message);
    logGraphError(err, "sendDocument");
    throw err;
  }
}

// Optional: send a quick reply menu as plain text list
async function sendMenu(to) {
  await sendButtons(
    to,
    "📋 *Main Menu* - Choose what you need:\n\n💰 Get repair pricing instantly\n📅 Schedule your repair visit\n🛠️ Troubleshoot software issues\n🆘 Learn how to use this bot\n\n✨ Or just ask me anything naturally!",
    [
      { id: "estimate", title: "💰 Get Estimate" },
      { id: "book", title: "📅 Book Appointment" },
      { id: "troubleshoot", title: "🛠️ Troubleshoot" },
      { id: "help", title: "🆘 Help" }
    ]
  );
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
    const systemContext = `You are an expert electronics repair assistant! 🛠️ You help with ALL electronics - phones 📱, tablets, laptops 💻, TVs 📺, watches ⌚, speakers 🔊, headphones 🎧, cameras 📷, gaming consoles 🎮, and more!

YOUR CAPABILITIES:
✅ Provide repair price estimates for ANY device (even if not in database)
✅ Troubleshoot problems and suggest DIY fixes
✅ Recommend whether to repair or replace
✅ Book appointments for repairs (IMPORTANT: We DO generate booking IDs for all appointments!)
✅ Answer questions about all electronics brands

BOOKING INFORMATION:
📋 When customers complete a booking, they receive a unique booking ID
📋 If asked "what is my booking ID" or similar, tell them to check their confirmation message
📋 Booking IDs look like: appt_1234567890 or a long MongoDB ID like 68fe174c440aa3498f456298
📋 If they can't find their ID, they can type 'book' to create a new appointment or call us at 8589838547

PRICING KNOWLEDGE (ACCURATE market rates - researched from online parts sellers):
These are REAL market prices. Tell customers they're estimates, but these are accurate!

📱 SMARTPHONES (Brand-specific accurate pricing):

**Apple iPhone:**
- iPhone 14/15 Pro Max screen: ₹8,500-₹12,000
- iPhone 13/14 screen: ₹6,500-₹9,500
- iPhone 11/12 screen: ₹4,500-₹7,000
- iPhone X/XR screen: ₹3,500-₹5,500
- iPhone 7/8 screen: ₹2,200-₹3,500
- Battery replacement: ₹1,800-₹4,500 (varies by model)
- Back glass: ₹2,500-₹6,000
- Charging port: ₹1,200-₹2,500
- Camera: ₹2,500-₹8,000 (rear/front varies)

**Samsung Galaxy:**
- S23/S24 Ultra screen: ₹7,500-₹11,000
- S21/S22 screen: ₹5,500-₹8,500
- S20/Note 20 screen: ₹4,500-₹7,000
- A series (A52/A53/A54): ₹2,800-₹4,500
- M series (M31/M32/M33): ₹2,200-₹3,800
- Battery: ₹1,200-₹3,500
- Back glass: ₹1,500-₹4,000
- Charging port: ₹800-₹1,800

**OnePlus:**
- OnePlus 11/12 screen: ₹5,500-₹8,500
- OnePlus 9/10 screen: ₹4,500-₹6,500
- OnePlus Nord series: ₹2,800-₹4,500
- Battery: ₹1,200-₹2,800
- Charging port: ₹800-₹1,500

**Xiaomi/Redmi/POCO:**
- Flagship (13/14 series): ₹3,500-₹6,000
- Mid-range (Note 12/13): ₹2,200-₹3,800
- Budget (9/10 series): ₹1,600-₹2,800
- Battery: ₹800-₹2,200
- Charging port: ₹500-₹1,200

**Vivo:**
- V series (V27/V29): ₹3,200-₹5,500
- Y series (Y91i/Y21): ₹1,800-₹3,200
- X series flagship: ₹5,000-₹8,000
- Battery: ₹900-₹2,500
- Charging port: ₹600-₹1,300

**Oppo:**
- Reno series: ₹3,500-₹6,000
- A series: ₹2,000-₹3,500
- F series: ₹2,500-₹4,200
- Battery: ₹900-₹2,500
- Charging port: ₹600-₹1,300

**Realme:**
- GT series: ₹3,200-₹5,500
- Number series (9/10/11): ₹2,200-₹3,800
- C series budget: ₹1,500-₹2,500
- Battery: ₹700-₹1,800
- Charging port: ₹500-₹1,100

**Motorola:**
- Edge series: ₹3,500-₹6,000
- G series: ₹2,000-₹3,500
- E series: ₹1,500-₹2,500
- Battery: ₹800-₹2,200

**Google Pixel:**
- Pixel 7/8 Pro: ₹7,000-₹10,000
- Pixel 6/7: ₹5,500-₹8,000
- Pixel 4a/5a: ₹3,500-₹5,500
- Battery: ₹1,500-₹3,500

**Nothing Phone:**
- Nothing Phone 1/2: ₹4,500-₹7,000
- Battery: ₹1,200-₹2,500

💻 LAPTOPS (Accurate brand-specific):

**Apple MacBook:**
- MacBook Pro M1/M2 screen: ₹28,000-₹45,000
- MacBook Air screen: ₹22,000-₹35,000
- Battery: ₹8,000-₹15,000
- Keyboard: ₹4,500-₹8,500
- Logic board repair: ₹15,000-₹40,000

**Dell:**
- XPS series screen: ₹8,500-₹15,000
- Inspiron screen: ₹4,500-₹8,500
- Latitude screen: ₹5,500-₹10,000
- Battery: ₹2,500-₹6,500
- Keyboard: ₹1,500-₹3,500

**HP:**
- Pavilion screen: ₹4,500-₹8,000
- EliteBook screen: ₹6,000-₹11,000
- Omen gaming screen: ₹7,500-₹14,000
- Battery: ₹2,200-₹5,500
- Keyboard: ₹1,200-₹2,800

**Lenovo:**
- ThinkPad screen: ₹5,500-₹10,000
- IdeaPad screen: ₹4,000-₹7,500
- Legion gaming screen: ₹8,000-₹15,000
- Battery: ₹2,500-₹6,000
- Keyboard: ₹1,500-₹3,200

**Asus:**
- ROG gaming screen: ₹9,000-₹18,000
- VivoBook screen: ₹4,500-₹8,000
- ZenBook screen: ₹6,500-₹12,000
- Battery: ₹2,800-₹6,500
- Keyboard: ₹1,500-₹3,500

**Acer:**
- Aspire screen: ₹3,800-₹7,000
- Predator gaming: ₹8,500-₹16,000
- Swift series: ₹5,500-₹9,500
- Battery: ₹2,200-₹5,000

📺 TVs (Brand-specific):
- Samsung QLED 55": ₹18,000-₹35,000 (screen)
- LG OLED panel: ₹25,000-₹45,000
- Sony Bravia LED: ₹12,000-₹28,000
- Mi/Xiaomi TV: ₹8,000-₹18,000
- Power board: ₹2,500-₹8,500
- Backlight strips: ₹1,500-₹5,500
- T-con board: ₹1,800-₹6,000

⌚ SMARTWATCHES:
- Apple Watch screen: ₹4,500-₹12,000
- Samsung Galaxy Watch: ₹2,800-₹6,500
- Fitbit screen: ₹1,500-₹3,500
- Amazfit screen: ₹1,200-₹2,800
- Battery: ₹800-₹2,500

🔊 AUDIO DEVICES:
- JBL speaker repair: ₹800-₹3,500
- Sony headphones: ₹1,200-₹4,500
- Boat earbuds battery: ₹400-₹1,200
- Marshall speakers: ₹2,000-₹5,500

📷 CAMERAS:
- Canon DSLR screen: ₹3,500-₹8,500
- Nikon lens repair: ₹2,500-₹12,000
- GoPro screen: ₹2,200-₹4,500
- Sony mirrorless: ₹5,500-₹15,000

🎮 GAMING:
- PS5 controller: ₹2,500-₹4,500
- Xbox controller: ₹2,200-₹4,000
- Nintendo Switch screen: ₹3,500-₹6,500
- Gaming mouse repair: ₹500-₹2,500

COMMUNICATION STYLE:
- Use emojis frequently! 😊✨
- Be friendly and conversational
- Give step-by-step guidance with numbered lists
- Provide price ranges when asked
- If user seems confused, offer clear options like:
  "What would you like to do? 🤔
  1️⃣ Get repair estimate
  2️⃣ Book appointment
  3️⃣ Get troubleshooting tips"

CONTACT INFORMATION:
📞 Our Contact Number: **8589838547**
- Share this when users ask "contact number", "phone number", "how to reach you", "call you", etc.
- Format: "You can reach us at 📞 **8589838547** - feel free to call anytime! 😊"

IMPORTANT:
- Always provide estimates even for devices not in our exact database
- Adjust prices based on brand (Apple/Samsung premium, Xiaomi/Realme budget)
- After giving info, guide them: "Type 'estimate' for detailed quote or 'book' to schedule! 📅"
- When asked for contact details, provide the phone number: 8589838547

BOOKING FLOW CRITICAL RULES:
⚠️ NEVER pretend to book appointments through AI conversation
⚠️ NEVER make up fake booking IDs like "appt_1234567890"
✅ When user wants to book (says "I want to book", "book appointment", "want to book", etc.):
   → Tell them: "Great! To start the booking process, please type the word 'book' and I'll guide you step by step! 📅"
✅ Only the actual booking system (triggered by typing "book") creates REAL booking IDs
✅ Real booking IDs look like: 68fe174c440aa3498f456298 or appt_1730000000000`;

    // Build conversation context
    let contextMessages = conversationHistory.map(msg => 
      `${msg.direction === 'in' ? 'Customer' : 'Assistant'}: ${msg.text}`
    ).join('\n');
    
    const prompt = contextMessages 
      ? `${systemContext}\n\nConversation history:\n${contextMessages}\n\nCustomer: ${userMessage}\n\nAssistant:`
      : `${systemContext}\n\nCustomer: ${userMessage}\n\nAssistant:`;

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents: [{
          parts: [{ text: prompt }]
        }],
        generationConfig: {
          temperature: 0.8,
          maxOutputTokens: 400,
          topP: 0.9,
          topK: 50
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
  
  // Allow menu number selections (1, 2, 3, 4) when NO active session
  if (!hasActiveSession(from)) {
    if (t === "1") {
      await startEstimateFlow(from);
      return;
    }
    if (t === "2") {
      await startBookingFlow(from);
      return;
    }
    if (t === "3") {
      await startTroubleshootingFlow(from);
      return;
    }
    if (t === "4") {
      await sendTextMessage(
        from,
        [
          "I can do these:",
          "• estimate — get repair cost by brand/model/issue",
          "• book — book an appointment",
          "• troubleshoot — fix software issues",
          "• menu — show options",
          "• cancel — stop current flow"
        ].join("\n")
      );
      return;
    }
  }
  
  // Route active sessions first
  if (hasActiveSession(from)) {
    await continueSession(from, text);
    return;
  }

  if (t === "hi" || t === "hello") {
    await sendTextMessage(
      from,
      "👋 Hey there! Welcome to our Electronics Repair Center! ✨\n\n🛠️ I can help you with:\n📱 Phones • 💻 Laptops • 📺 TVs • ⌚ Watches • 🔊 Speakers • 🎧 Headphones • 📷 Cameras\n\n💬 Just tell me what you need or type:\n📋 *menu* - See all options\n💰 *estimate* - Get repair price\n🛠️ *troubleshoot* - Fix software issues\n📅 *book* - Schedule appointment\n\n🤔 Or simply ask me anything!"
    );
    return;
  }
  // Global model search: allow natural commands like "find <model>" or "search <model>"
  if (t.startsWith('find ') || t.startsWith('search ')) {
    const q = text.trim().split(/\s+/).slice(1).join(' ');
    const matches = searchModelsGlobally(q, 8);
    if (!matches.length) {
      await sendTextMessage(from, `No models found for "${q}". Try checking spelling or type 'menu' to browse brands.`);
      return;
    }
    
    // Store search results in a temporary session for quick selection
    beginSession(from, "search_results");
    const s = sessions.get(from);
    s.data.searchResults = matches;
    s.step = "select_result";
    
    const msg = [
      `🔍 Found ${matches.length} result(s) for "${q}":`,
      "",
      ...matches.map((m, i) => {
        const samplePrice = m.parts.length ? `${m.parts[0]}: ₹${REPAIRS[m.brand][m.model][m.parts[0]].toLocaleString('en-IN')}` : 'Price on request';
        return `${i + 1}) *${m.brand} ${m.model}*\n   ${samplePrice}`;
      }),
      "",
      "📋 Reply with a number (1-" + matches.length + ") to:",
      "   • Get full estimate",
      "   • Book appointment",
      "",
      "Or type 'cancel' to go back"
    ].join('\n');
    await sendTextMessage(from, msg);
    return;
  }
  if (t === "help") {
    await sendTextMessage(
      from,
      [
        "🆘 *How I Can Help You:*",
        "",
        "💡 *Quick Commands:*",
        "📋 *menu* — Show all options",
        "💰 *estimate* — Get repair cost",
        "📅 *book* — Schedule appointment",
        "🛠️ *troubleshoot* — Fix software issues",
        "❌ *cancel* — Stop current action",
        "",
        "💬 *Or just chat with me!*",
        "Ask: \"How much to fix iPhone screen?\" or \"My laptop won't turn on\"",
        "",
        "✨ I understand natural language!"
      ].join("\n")
    );
    return;
  }
  if (t === "menu") {
    endSession(from); // Allow menu to reset stuck sessions
    await sendMenu(from);
    return;
  }
  if (t.startsWith("echo ")) {
    await sendTextMessage(from, text.slice(5));
    return;
  }
  if (t === "estimate" || t === "get estimate") {
    endSession(from); // Allow estimate to override session
    await startEstimateFlow(from);
    return;
  }
  if (["book", "appointment", "book appointment"].includes(t)) {
    endSession(from); // Allow book to override session
    await startBookingFlow(from);
    return;
  }
  if (t === "troubleshoot" || t === "fix" || t === "software") {
    endSession(from); // Allow troubleshoot to override session
    await startTroubleshootingFlow(from);
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

// Search repairs DB for models across all brands. Returns array of { brand, model, samplePrice, parts }
function searchModelsGlobally(query, limit = 10) {
  if (!query || !query.trim()) return [];
  const q = query.trim().toLowerCase();
  const results = [];
  for (const brand of Object.keys(REPAIRS)) {
    for (const model of Object.keys(REPAIRS[brand])) {
      const modelKey = `${brand} ${model}`.toLowerCase();
      let score = 0;
      if (modelKey === q) score = 100;
      else if (model.toLowerCase() === q || brand.toLowerCase() === q) score = 80;
      else if (modelKey.includes(q)) score = 60;
      else if (model.toLowerCase().includes(q) || brand.toLowerCase().includes(q)) score = 40;
      if (score > 0) {
        const parts = Object.keys(REPAIRS[brand][model] || {});
        const samplePrice = parts.length ? REPAIRS[brand][model][parts[0]] : null;
        results.push({ brand, model, parts, samplePrice, score });
      }
    }
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

function briefInfoForMatch(match) {
  const { brand, model, parts } = match;
  const lines = [];
  lines.push(`${brand} ${model}`);
  if (parts && parts.length) {
    const summary = parts.slice(0, 5).map(p => `${p}: ₹${REPAIRS[brand][model][p].toLocaleString('en-IN')}`).join(' | ');
    lines.push(summary);
  } else {
    lines.push('No parts listed');
  }
  return lines.join('\n');
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

async function startTroubleshootingFlow(from) {
  beginSession(from, "troubleshoot");
  sessions.get(from).step = "issue";
  await sendTextMessage(
    from, 
    "🛠️ *SOFTWARE TROUBLESHOOTING*\n\n" +
    "I can help you fix software issues! 🔧\n\n" +
    "📝 *Tell me about the problem:*\n" +
    "• Describe the error or issue\n" +
    "• Type the error code you see\n" +
    "• Send a screenshot of the error 📸\n\n" +
    "I'll analyze it and give you step-by-step solutions! ✨"
  );
}

async function continueSession(from, text) {
  const s = sessions.get(from);
  if (!s) return;
  s.lastActive = Date.now();
  const t = (text || "").trim();
  const tLower = t.toLowerCase();
  
  console.log(`[Session] ${from} - Flow: ${s.flow}, Step: ${s.step}, Input: "${t.substring(0, 50)}..."`);
  
  // Check for global override commands FIRST
  if (tLower === "cancel" || tLower === "reset") {
    endSession(from);
    await sendTextMessage(from, "Cancelled. Type 'menu' to start again.");
    return;
  }
  
  if (tLower === "menu") {
    endSession(from);
    await sendMenu(from);
    return;
  }
  
  if (tLower === "estimate" || tLower === "get estimate") {
    endSession(from);
    await startEstimateFlow(from);
    return;
  }
  
  if (["book", "appointment", "book appointment"].includes(tLower)) {
    endSession(from);
    await startBookingFlow(from);
    return;
  }
  
  if (tLower === "troubleshoot" || tLower === "fix" || tLower === "software") {
    endSession(from);
    await startTroubleshootingFlow(from);
    return;
  }

  if (s.flow === "estimate") return continueEstimate(from, s, t);
  if (s.flow === "booking") return continueBooking(from, s, t);
  if (s.flow === "troubleshoot") return continueTroubleshoot(from, s, t);
  if (s.flow === "search_results") return handleSearchSelection(from, s, t);
}

async function continueEstimate(from, s, input) {
  switch (s.step) {
    case "brand": {
      const brands = listBrands();
      const idx = parseInt(input, 10);
      let brand = brands[idx - 1];
      if (!brand) brand = capitalize(input);
      if (!REPAIRS[brand]) {
        // Brand not in database - still allow user to continue with estimate
        s.data.brand = input;
        s.step = "model_custom";
        await sendTextMessage(
          from,
          `� Got it - ${input}!\n\nWhat's the exact model? (e.g., "G8S ThinQ", "V60", "Wing 5G")`
        );
        return;
      }
      s.data.brand = brand;
        // Prepare paginated model list (store full list in session)
        s.data.modelList = listModels(brand);
        s.data.modelPage = 0;
        s.step = "model";
        const total = s.data.modelList.length;
        if (!total) {
          await sendTextMessage(from, `No models found for ${brand}. You can type the model name directly.`);
          return;
        }
        const start = s.data.modelPage * 10;
        const pageItems = s.data.modelList.slice(start, start + 10);
        await sendTextMessage(
          from,
          [
            `Brand: ${brand} (showing ${start + 1}-${Math.min(start + 10, total)} of ${total})`,
            "Select a model by number:",
            ...pageItems.map((m, i) => `${start + i + 1}) ${m}`),
            "Or type the exact model name.",
            "Type 'more' to see more models."
          ].join("\n")
        );
      return;
    }
    case "model_custom": {
      // For brands not in database - get model name
      s.data.model = input.trim();
      s.step = "issue_custom";
      await sendTextMessage(
        from,
        `📱 ${s.data.brand} ${s.data.model}\n\nWhat's the issue? (e.g., "broken screen", "battery problem", "water damage")`
      );
      return;
    }
    case "issue_custom": {
      // For non-database items - use AI to provide estimate
      s.data.issue = input.trim();
      const history = await getConversationHistory(from, 5);
      const aiResponse = await askGemini(
        `User wants repair estimate for: ${s.data.brand} ${s.data.model} with issue: ${s.data.issue}. Provide a realistic price range in Indian Rupees (₹) based on typical market rates. Be specific with a range like ₹3,500-₹6,000. After giving the price, ask if they want to book an appointment - tell them to reply 'yes' to book or 'no' to cancel.`,
        history
      );
      
      if (aiResponse) {
        await sendTextMessage(from, aiResponse);
        s.step = "offer_book";
      } else {
        // Fallback if AI fails
        await sendTextMessage(
          from,
          `📝 Noted: ${s.data.brand} ${s.data.model} - ${s.data.issue}\n\n💰 Estimated repair cost: ₹3,000-₹7,000\n(Final price depends on parts availability and damage assessment)\n\nWould you like to book an appointment? (yes/no)`
        );
        s.step = "offer_book";
      }
      return;
    }
    case "model": {
      // Support pagination 'more' to view additional models
      if (input.trim().toLowerCase() === 'more') {
        if (!s.data.modelList) s.data.modelList = listModels(s.data.brand);
        s.data.modelPage = (s.data.modelPage || 0) + 1;
        const total = s.data.modelList.length;
        const start = s.data.modelPage * 10;
        if (start >= total) {
          s.data.modelPage = 0; // wrap around
          await sendTextMessage(from, "No more models — back to start.");
        }
        const pageStart = s.data.modelPage * 10;
        const pageItems = s.data.modelList.slice(pageStart, pageStart + 10);
        await sendTextMessage(
          from,
          [
            `Brand: ${s.data.brand} (showing ${pageStart + 1}-${Math.min(pageStart + 10, total)} of ${total})`,
            ...pageItems.map((m, i) => `${pageStart + i + 1}) ${m}`),
            "Or type the exact model name.",
            "Type 'more' to see more models."
          ].join("\n")
        );
        return;
      }

      const models = s.data.modelList || listModels(s.data.brand);
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

async function isValidDate(str) {
  // YYYY-MM-DD
  return /^\d{4}-\d{2}-\d{2}$/.test(str);
}
async function isValidTime(str) {
  // HH:MM 24h
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(str);
}

// Parse natural language date using AI
async function parseNaturalDate(input) {
  if (!GEMINI_API_KEY) return null;
  
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0]; // YYYY-MM-DD
  
  try {
    const prompt = `Today is ${todayStr}. Convert this natural language date/time to YYYY-MM-DD format ONLY. Return ONLY the date in YYYY-MM-DD format, nothing else.

Examples:
"tomorrow" → ${new Date(today.getTime() + 86400000).toISOString().split('T')[0]}
"next week" → ${new Date(today.getTime() + 7*86400000).toISOString().split('T')[0]}
"7th" → 2025-11-07 (if we're in October)
"next Monday" → (calculate next Monday)

User input: "${input}"

Return ONLY the date in YYYY-MM-DD format:`;

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents: [{
          parts: [{ text: prompt }]
        }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 50
        }
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 5000
      }
    );

    const aiText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (aiText && isValidDate(aiText)) {
      return aiText;
    }
    return null;
  } catch (error) {
    console.error('Date parsing error:', error.message);
    return null;
  }
}

// Parse natural language time using AI
async function parseNaturalTime(input) {
  if (!GEMINI_API_KEY) return null;
  
  try {
    const prompt = `Convert this natural language time to HH:MM 24-hour format ONLY. Return ONLY the time in HH:MM format, nothing else.

Examples:
"5pm" → 17:00
"5:30 pm" → 17:30
"noon" → 12:00
"midnight" → 00:00
"9 in the morning" → 09:00
"half past 3 pm" → 15:30

User input: "${input}"

Return ONLY the time in HH:MM 24-hour format:`;

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents: [{
          parts: [{ text: prompt }]
        }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 20
        }
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 5000
      }
    );

    const aiText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (aiText && isValidTime(aiText)) {
      return aiText;
    }
    return null;
  } catch (error) {
    console.error('Time parsing error:', error.message);
    return null;
  }
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
        // Brand not in database - allow booking anyway
        s.data.brand = input;
        s.step = "model_custom_booking";
        await sendTextMessage(
          from,
          `� ${input} - got it!\n\nWhat's the exact model? (e.g., "G8S ThinQ")`
        );
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
    case "model_custom_booking": {
      // Custom model name for brands not in database - BOOKING flow
      s.data.model = input.trim();
      s.step = "issue_custom_booking";
      await sendTextMessage(
        from,
        `📱 ${s.data.brand} ${s.data.model}\n\nWhat issue are you experiencing? (e.g., "broken screen", "battery problem")`
      );
      return;
    }
    case "issue_custom_booking": {
      // Custom issue for non-database brands - BOOKING flow, get AI estimate
      s.data.issue = input.trim();
      
      // Get AI estimate
      const history = await getConversationHistory(from, 5);
      const aiEstimate = await askGemini(
        `User wants to book repair for: ${s.data.brand} ${s.data.model} with issue: ${s.data.issue}. Provide ONLY a realistic price range in Indian Rupees. Reply with ONLY the range like "₹3,500 - ₹6,000" or "₹2,000 - ₹4,500". Nothing else, just the range.`,
        history
      );
      
      const priceRange = aiEstimate?.trim() || "₹3,000 - ₹7,000";
      s.data.estimateRange = priceRange;
      s.step = "date";
      
      await sendTextMessage(
        from,
        `📝 ${s.data.brand} ${s.data.model} - ${s.data.issue}\n💰 Estimated cost: ${priceRange}\n(Final price after diagnosis)\n\nWhat date works for you? 📅\n(YYYY-MM-DD, e.g., 2025-10-27, or say "tomorrow", "next week")`
      );
      return;
    }
    case "model": {
      const models = listModels(s.data.brand);
      const idx = parseInt(input, 10);
      let model = models[idx - 1];
      if (!model) model = input;
      if (!REPAIRS[s.data.brand]?.[model]) {
        // Model not in database - allow anyway
        s.data.model = input;
        s.step = "issue";
        await sendTextMessage(
          from,
          `📝 Model: ${input}\n\nWhat issue are you experiencing? Please describe the problem.`
        );
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
          `Noted ${s.data.brand} ${s.data.model} (${issue}) — est. ₹${price.toLocaleString("en-IN")}.`,
          "What date works for you? (YYYY-MM-DD)",
        ].join("\n")
      );
      s.step = "date";
      return;
    }
    case "date": {
      let date = input.trim();
      let confirmMsg = "";
      
      // First check if it's already in correct format
      if (!isValidDate(date)) {
        // Try to parse natural language
        const parsedDate = await parseNaturalDate(input);
        if (parsedDate) {
          date = parsedDate;
          confirmMsg = `✅ Understood! ${date}\n\n`;
        } else {
          await sendTextMessage(from, "I didn't understand that date. Please try:\n• YYYY-MM-DD (e.g., 2025-10-26)\n• Or say 'tomorrow', 'next week', '7th', etc.");
          return;
        }
      }
      
      s.data.date = date;
      s.step = "time";
      await sendTextMessage(from, confirmMsg + "What time works for you? 🕐\n(e.g., '5pm', '17:00', 'noon', '3:30 pm')");
      return;
    }
    case "time": {
      let time = input.trim();
      let confirmMsg = "";
      
      // First check if it's already in correct format
      if (!isValidTime(time)) {
        // Try to parse natural language
        const parsedTime = await parseNaturalTime(input);
        if (parsedTime) {
          time = parsedTime;
          confirmMsg = `✅ Understood! ${time}\n\n`;
        } else {
          await sendTextMessage(from, "I didn't understand that time. Please try:\n• 24-hour format (e.g., 14:30)\n• Or say '5pm', 'noon', '3:30 pm', etc.");
          return;
        }
      }
      
      s.data.time = time;
      s.step = "confirm";
      
      // Send confirmation in ONE message to avoid session loss
      await sendTextMessage(
        from,
        confirmMsg + [
          "📋 *Confirm your appointment:*",
          `👤 Name: ${s.data.name}`,
          `📱 Phone: ${from}`,
          `🔧 Device: ${s.data.brand} ${s.data.model}`,
          `⚠️ Issue: ${s.data.issue}`,
          s.data.price ? `💰 Estimate: ₹${s.data.price.toLocaleString("en-IN")}` : (s.data.estimateRange ? `💰 Estimate: ${s.data.estimateRange}` : "💰 Estimate: Will quote during visit"),
          `📅 Date & Time: ${s.data.date} at ${s.data.time}`,
          "",
          "Reply *'yes'* to confirm or *'no'* to cancel.",
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
      
      // Add estimate range to appointment object for PDF
      if (s.data.estimateRange && !appt.estimate) {
        appt.estimateRange = s.data.estimateRange;
      }
      
      endSession(from);
      
      // Send confirmation message first
      await sendTextMessage(
        from,
        [
          " Appointment booked!",
          `ID: ${appt.id}`,
          `When: ${appt.date} ${appt.time}`,
          "",
          " Generating your job sheet...",
        ].join("\n")
      );
      
      // Generate and send PDF job sheet
      try {
        const pdfPath = await generateJobSheetPDF(appt);
        await sendDocument(from, pdfPath, `Job Sheet - ${appt.id}`);
        await sendTextMessage(
          from,
          " Job sheet sent! Please save it for your records.\n\nWe'll contact you to confirm. Reply 'menu' for more options."
        );
      } catch (pdfError) {
        console.error('Failed to generate/send job sheet:', pdfError);
        await sendTextMessage(
          from,
          " Your booking is confirmed, but we couldn't send the job sheet. You'll receive it via email or at our center.\n\nReply 'menu' for more options."
        );
      }
      
      return;
    }
    default:
      endSession(from);
      await sendTextMessage(from, "Session ended. Type 'menu' to start again.");
  }
}

// Software Troubleshooting Flow
async function continueTroubleshoot(from, s, input) {
  switch (s.step) {
    case "issue": {
      if (!input || input.trim().length < 3) {
        await sendTextMessage(from, "Please describe your issue in more detail (at least 3 characters).");
        return;
      }

      s.data.issue = input.trim();
      s.step = "device_type";

      await sendButtons(
        from,
        `🛠️ *Issue:* ${input}\n\nWhat type of device is having the problem?`,
        [
          { id: "phone", title: "📱 Phone" },
          { id: "laptop", title: "💻 Laptop/PC" },
          { id: "tablet", title: "📱 Tablet" },
          { id: "other_device", title: "🔧 Other Device" }
        ]
      );
      return;
    }

    case "device_type": {
      const deviceTypes = {
        "phone": "Phone",
        "laptop": "Laptop/PC",
        "tablet": "Tablet",
        "other_device": "Other Device"
      };

      if (!deviceTypes[input]) {
        await sendTextMessage(from, "Please select a valid device type from the options.");
        return;
      }

      s.data.deviceType = deviceTypes[input];
      s.step = "error_details";

      await sendTextMessage(
        from,
        `📱 *${s.data.deviceType}* - ${s.data.issue}\n\nTo provide the best solution, please provide:\n\n1️⃣ *Error code* (if you see one)\n2️⃣ *Error message* (exact text)\n3️⃣ *When it happens* (startup, app use, etc.)\n\nOr send a *photo* of the error screen!\n\nType your details or send an image:`
      );
      return;
    }

    case "error_details": {
      if (!input || input.trim().length < 2) {
        await sendTextMessage(from, "Please provide more details about the error or send a photo.");
        return;
      }

      s.data.errorDetails = input.trim();
      s.step = "analyze";

      // Analyze the issue using AI
      await analyzeIssue(from, s);
      return;
    }

    case "analyze": {
      // This step handles follow-up after analysis
      if (input.toLowerCase().includes("yes") || input.toLowerCase().includes("try")) {
        await sendTextMessage(from, "Great! Try the steps above and let me know if you need more help. If the issue persists, you can always book a repair appointment.");
        endSession(from);
      } else if (input.toLowerCase().includes("no") || input.toLowerCase().includes("book")) {
        await sendTextMessage(from, "No problem! Let's get you scheduled for professional repair.");
        // Switch to booking flow
        s.flow = "booking";
        s.step = "name";
        await sendTextMessage(from, "What's your name for the appointment?");
      } else {
        await sendTextMessage(from, "Type 'yes' to try the steps, or 'book' to schedule a repair appointment.");
      }
      return;
    }

    default:
      endSession(from);
      await sendTextMessage(from, "Session ended. Type 'menu' to start again.");
  }
}

// Analyze software issues using AI and knowledge base
async function analyzeIssue(from, session) {
  const { issue, deviceType, errorDetails } = session.data;

  await sendTextMessage(from, "🔍 *Analyzing your issue...*\n\n⏳ Checking knowledge base and generating custom solution...");

  try {
    // First check knowledge base for common issues
    const knowledgeBaseSolution = checkKnowledgeBase(issue, deviceType, errorDetails);

    if (knowledgeBaseSolution) {
      await sendTextMessage(
        from,
        `🛠️ *SOLUTION FOUND!*\n\n${knowledgeBaseSolution}\n\n✅ Did this solve your problem? (yes/no)\n\n📅 Or type 'book' to schedule professional repair.`
      );
      session.step = "analyze";
      return;
    }

    // If no knowledge base match, use AI analysis with enhanced error detection
    const history = await getConversationHistory(from, 3);
    const enhancedPrompt = `🔧 TECHNICAL SUPPORT REQUEST - SOFTWARE TROUBLESHOOTING

📱 Device Type: ${deviceType}
❗ Issue Reported: ${issue}
📋 Additional Details: ${errorDetails}

As an expert technical support specialist, analyze this issue and provide:

🔍 **ERROR ANALYSIS**
- Identify error type (software, driver, system, app, network, etc.)
- Extract any error codes mentioned (0x codes, HTTP codes, etc.)
- Determine severity level

🎯 **ROOT CAUSE**
- Most probable cause
- Why this typically happens
- Related symptoms to watch for

✅ **STEP-BY-STEP SOLUTION** (Must be numbered and specific!)
1. [First diagnostic step - be VERY specific with paths/commands]
2. [Second fix attempt - include exact settings location]
3. [Alternative method if #2 fails]
4. [Advanced troubleshooting if still not fixed]
5. [When to factory reset or seek professional repair]

⚠️ **SAFETY WARNINGS**
- Data backup needed? (Yes/No)
- Risk level of fixes (Low/Medium/High)
- What NOT to do

🛡️ **PREVENTION TIPS**
- How to avoid this in future
- Maintenance recommendations

CRITICAL REQUIREMENTS:
✅ ONLY legitimate, tested, working solutions
✅ NO risky hacks or registry tweaks unless absolutely necessary
✅ Provide EXACT commands, file paths, or settings locations
✅ Include version compatibility notes where relevant
✅ Warn about data loss risks
✅ If issue needs hardware repair, state clearly

Format with clear sections and numbered steps. Be specific and actionable.`;
    const aiResponse = await askGemini(enhancedPrompt, history);

    if (aiResponse) {
      await sendTextMessage(
        from,
        `🛠️ *CUSTOM TROUBLESHOOTING GUIDE*\n\n${aiResponse}\n\n✅ Did this help resolve your issue? (yes/no)\n\n📅 If the problem persists, type 'book' to schedule professional repair.`
      );
      session.step = "analyze";
    } else {
      // Fallback response
      await sendTextMessage(
        from,
        `🛠️ *GENERAL TROUBLESHOOTING STEPS*\n\nFor ${deviceType} issue: ${issue}\n\n1. **Restart the device** - Hold power button for 10-15 seconds\n2. **Check for updates** - Ensure OS and apps are current\n3. **Clear cache/storage** - Free up space and remove temp files\n4. **Safe mode test** - Boot without third-party apps\n5. **Factory reset** (last resort) - Backup data first!\n\n⚠️ *Important:* Backup your data before major changes.\n\nDid this help? (yes/no) or type 'book' for professional repair.`
      );
      session.step = "analyze";
    }

  } catch (error) {
    console.error('Error analyzing issue:', error);
    await sendTextMessage(
      from,
      `❌ Sorry, I encountered an error analyzing your issue.\n\nPlease try describing it differently or type 'book' to schedule a repair appointment.`
    );
    endSession(from);
  }
}

// Knowledge base for common software issues
function checkKnowledgeBase(issue, deviceType, details) {
  const issue_lower = (issue + " " + (details || "")).toLowerCase();

  // Common error patterns
  const patterns = {
    // Windows errors
    "blue screen": "🖥️ **BLUE SCREEN FIX**\n\n1. **Note the error code** (STOP code)\n2. **Restart in Safe Mode** - Press Shift+Restart\n3. **Update drivers** - Use Device Manager\n4. **Run System File Checker** - Open CMD as admin, type: `sfc /scannow`\n5. **Check disk errors** - CMD: `chkdsk /f /r`\n6. **Update Windows** - Settings > Update & Security\n\nIf persistent, hardware issue likely - book repair.",

    "windows update": "🔄 **WINDOWS UPDATE ISSUES**\n\n1. **Run Windows Update Troubleshooter** - Settings > Update & Security > Troubleshoot\n2. **Clear update cache** - Stop Windows Update service, delete C:\\Windows\\SoftwareDistribution\\Download\\*\n3. **Reset Windows Update** - Microsoft support tools\n4. **Check disk space** - Need 10GB+ free\n5. **Disable antivirus temporarily**\n\nFor stuck updates, wait or force restart.",

    "driver": "🎮 **DRIVER PROBLEMS**\n\n1. **Identify device** - Device Manager (yellow exclamation)\n2. **Download latest driver** - From manufacturer website\n3. **Uninstall old driver** - Device Manager > Uninstall\n4. **Install new driver** - Run installer as admin\n5. **Windows Update** - May have generic drivers\n\nAvoid third-party driver updaters - use official sources only.",

    // Android/iOS errors
    "app crash": "📱 **APP CRASHING FIX**\n\n1. **Force stop app** - Settings > Apps > Force Stop\n2. **Clear app cache/data** - Storage > Clear Cache\n3. **Update the app** - Play Store/App Store\n4. **Restart device**\n5. **Uninstall/reinstall** - If problem persists\n6. **Check app permissions**\n\nIf all apps crash, system issue - factory reset or repair.",

    "boot loop": "🔄 **BOOT LOOP FIX**\n\n1. **Force restart** - Hold power button 10-15 seconds\n2. **Boot to safe mode** - Power + Volume Down (varies by device)\n3. **Clear cache partition** - Recovery mode\n4. **Factory reset** - Last resort, backup first\n5. **Check hardware** - Battery, power button\n\nIf persists, likely hardware issue - needs repair.",

    "wifi": "📶 **WIFI CONNECTION ISSUES**\n\n1. **Toggle airplane mode** - On/off quickly\n2. **Forget network** - Settings > WiFi > Forget\n3. **Restart router** - Unplug for 30 seconds\n4. **Reset network settings** - Settings > General > Reset > Reset Network\n5. **Check MAC address filtering**\n6. **Update router firmware**\n\nTry different networks to isolate issue.",

    "battery drain": "🔋 **BATTERY DRAIN FIX**\n\n1. **Check battery usage** - Settings > Battery\n2. **Close background apps** - Recent apps > Close all\n3. **Disable location/GPS** when not needed\n4. **Lower screen brightness**\n5. **Turn off push notifications**\n6. **Update apps and OS**\n7. **Calibrate battery** - Full charge, full drain, repeat\n\nReplace battery if issue persists after optimization.",

    // Common error codes
    "0x80070005": "🔑 **ACCESS DENIED (0x80070005)**\n\n1. **Run as administrator** - Right-click > Run as admin\n2. **Check permissions** - Properties > Security > Edit\n3. **Disable UAC temporarily** - Control Panel > User Accounts\n4. **Check antivirus** - May be blocking access\n5. **System restore** - To before problem started\n\nOften caused by permission issues or security software.",

    "0xc0000142": "⚠️ **APPLICATION ERROR (0xc0000142)**\n\n1. **Run compatibility troubleshooter** - Right-click exe > Properties > Compatibility > Run troubleshooter\n2. **Update .NET Framework** - Microsoft website\n3. **Run SFC scan** - CMD: `sfc /scannow`\n4. **Reinstall application**\n5. **Check for Windows updates**\n\nUsually compatibility or missing dependency issue.",

    "404": "🌐 **404 NOT FOUND**\n\n1. **Check URL spelling**\n2. **Clear browser cache** - Ctrl+Shift+Delete\n3. **Try different browser**\n4. **Check internet connection**\n5. **DNS flush** - CMD: `ipconfig /flushdns`\n6. **Disable VPN/proxy**\n\nIf website-wide issue, contact website administrator.",

    "500": "🌐 **500 INTERNAL SERVER ERROR**\n\n1. **Refresh page** - F5 or Ctrl+R\n2. **Clear browser cache**\n3. **Try incognito mode**\n4. **Check server status** - DownDetector or similar\n5. **Contact website support**\n\nServer-side issue, usually temporary.",

    // More Windows error codes
    "0x80004005": "⚠️ **UNSPECIFIED ERROR (0x80004005)**\n\n1. **Run as administrator**\n2. **Re-register DLL files** - CMD: `regsvr32 /u /s %windir%\\system32\\*.dll`\n3. **Update Windows**\n4. **Disable firewall temporarily** - Test if it's blocking\n5. **Check file permissions**\n6. **System Restore**\n\nCommon with file operations, network shares, or updates.",

    "0x80070057": "❌ **INVALID PARAMETER (0x80070057)**\n\n1. **Check disk for errors** - CMD: `chkdsk /f`\n2. **Run DISM** - `DISM /Online /Cleanup-Image /RestoreHealth`\n3. **Disable Fast Startup** - Power Options > Choose what power buttons do\n4. **Format drive correctly** - Right partition format\n5. **Update drivers**\n\nOften during Windows Update or drive formatting.",

    "0xc000000e": "🔧 **BOOT CONFIGURATION ERROR (0xc000000e)**\n\n1. **Boot from Windows USB/DVD**\n2. **Select 'Repair your computer'**\n3. **Troubleshoot > Advanced > Command Prompt**\n4. **Run:** `bootrec /fixmbr`\n5. **Run:** `bootrec /fixboot`\n6. **Run:** `bootrec /rebuildbcd`\n7. **Restart**\n\nBoot files corrupted - needs repair disk.",

    "0x8007000d": "📁 **DATA INVALID (0x8007000d)**\n\n1. **Run SFC scan** - `sfc /scannow`\n2. **Run DISM** - `DISM /Online /Cleanup-Image /RestoreHealth`\n3. **Re-download file/installer**\n4. **Check disk space**\n5. **Disable antivirus temporarily**\n6. **Try different download source**\n\nCorrupted download or system files.",

    "dpc watchdog violation": "⏱️ **DPC WATCHDOG VIOLATION**\n\n1. **Update all drivers** - Especially SSD, chipset, graphics\n2. **Update SSD firmware** - From manufacturer\n3. **Run chkdsk** - `chkdsk /f /r`\n4. **Disable Fast Startup**\n5. **Check SATA cable/port**\n6. **Test RAM** - Windows Memory Diagnostic\n\nUsually driver or storage issue.",

    "page fault in nonpaged area": "💾 **PAGE FAULT IN NONPAGED AREA**\n\n1. **Test RAM** - Windows Memory Diagnostic\n2. **Update drivers** - All hardware drivers\n3. **Check disk** - `chkdsk /f /r`\n4. **Disable hardware acceleration** - In browsers/apps\n5. **Uninstall recent software**\n6. **Boot to safe mode** - Identify problematic driver\n\nRAM or driver issue - test hardware.",

    "system_service_exception": "🛑 **SYSTEM SERVICE EXCEPTION**\n\n1. **Boot to Safe Mode**\n2. **Update graphics driver** - Most common cause\n3. **Update Windows**\n4. **Run SFC** - `sfc /scannow`\n5. **Uninstall recent programs**\n6. **Roll back driver** - Device Manager if recent update\n\nDriver conflict, usually graphics or antivirus.",

    // Mobile-specific errors
    "storage full": "📦 **STORAGE FULL FIX**\n\n1. **Check storage** - Settings > Storage\n2. **Clear app cache** - Settings > Apps > Each app > Clear Cache\n3. **Delete unused apps**\n4. **Move photos to cloud** - Google Photos, iCloud\n5. **Clear WhatsApp media** - Large media files\n6. **Use Files app** - Find large files\n7. **Factory reset** - Last resort, backup first\n\nRegular maintenance prevents this.",

    "sim not detected": "📱 **SIM NOT DETECTED FIX**\n\n1. **Restart device**\n2. **Remove and reinsert SIM** - Clean with cloth\n3. **Try SIM in another phone** - Test if SIM faulty\n4. **Check airplane mode** - Turn off\n5. **Reset network settings**\n6. **Update carrier settings**\n7. **Contact carrier** - May need new SIM\n\nIf all fail, SIM slot may be damaged.",

    "bootloop": "🔄 **BOOTLOOP COMPREHENSIVE FIX**\n\n**For Android:**\n1. **Force restart** - Hold Power + Vol Down 10-15 sec\n2. **Boot to Recovery** - Power + Vol Up/Down (varies)\n3. **Wipe cache partition**\n4. **Factory reset** - Backup first if possible\n5. **Flash stock firmware** - Using official tools\n\n**For iPhone:**\n1. **Force restart** - Steps vary by model\n2. **DFU mode** - Connect to iTunes/Finder\n3. **Restore firmware**\n\nOften caused by bad update or system file corruption.",

    "imei null": "📵 **IMEI NULL/INVALID FIX**\n\n⚠️ **WARNING:** This is serious!\n\n1. **Check IMEI** - Dial `*#06#`\n2. **Restart device**\n3. **Remove and reinsert SIM**\n4. **Flash stock firmware** - Official method only\n5. **IMEI repair** - Requires professional service\n\n⚠️ DO NOT use shady IMEI repair tools - illegal in many countries!\nContact manufacturer or authorized service center.",

    "unfortunately app has stopped": "📱 **APP STOPPED WORKING FIX**\n\n1. **Force stop app** - Settings > Apps > Force Stop\n2. **Clear app cache** - Don't clear data yet\n3. **Clear app data** - If cache didn't work\n4. **Update app** - Google Play Store\n5. **Uninstall updates** - If system app\n6. **Reinstall app** - Complete removal first\n7. **Update Android OS**\n8. **Factory reset** - Last resort\n\nCheck if other apps also crash - may be system issue.",

    // Network errors
    "dns_probe_finished_nxdomain": "🌐 **DNS ERROR - DOMAIN NOT FOUND**\n\n1. **Check URL spelling**\n2. **Flush DNS cache** - CMD: `ipconfig /flushdns`\n3. **Change DNS servers:**\n   - Google DNS: 8.8.8.8, 8.8.4.4\n   - Cloudflare: 1.1.1.1, 1.0.0.1\n4. **Release/Renew IP:**\n   - `ipconfig /release`\n   - `ipconfig /renew`\n5. **Reset network** - `netsh winsock reset`\n6. **Restart router**\n7. **Disable VPN**\n\nDNS resolution failure.",

    "err_connection_refused": "🔌 **CONNECTION REFUSED ERROR**\n\n1. **Check website status** - DownDetector\n2. **Clear browser cache/cookies**\n3. **Try different browser**\n4. **Disable firewall/antivirus temporarily**\n5. **Flush DNS** - `ipconfig /flushdns`\n6. **Check proxy settings** - Browser settings\n7. **Reset network** - `netsh winsock reset`\n8. **Restart router**\n\nServer refusing connection or firewall blocking.",

    "no internet connection": "📡 **NO INTERNET CONNECTION FIX**\n\n1. **Restart router** - Unplug 30 seconds\n2. **Restart device**\n3. **Forget WiFi network** - Reconnect\n4. **Check other devices** - Isolate device vs router issue\n5. **Reset network settings** - Device settings\n6. **Update network drivers** - Windows only\n7. **Change DNS** - 8.8.8.8\n8. **Contact ISP** - If all else fails\n\nDetermine if device, router, or ISP issue."
  };

  // Check for pattern matches
  for (const [pattern, solution] of Object.entries(patterns)) {
    if (issue_lower.includes(pattern)) {
      return solution;
    }
  }

  return null; // No match found
}

// Handle selection from search results - allows user to pick a model and choose estimate or booking
async function handleSearchSelection(from, s, input) {
  const t = input.trim().toLowerCase();
  
  if (s.step === "select_result") {
    const idx = parseInt(input, 10);
    if (!idx || idx < 1 || idx > (s.data.searchResults?.length || 0)) {
      await sendTextMessage(from, `Please reply with a number between 1 and ${s.data.searchResults.length}, or type 'cancel'.`);
      return;
    }
    
    const match = s.data.searchResults[idx - 1];
    const { brand, model, parts } = match;
    
    // Show model details and ask what they want to do
    const priceList = parts.slice(0, 5).map(p => `   • ${p}: ₹${REPAIRS[brand][model][p].toLocaleString('en-IN')}`).join('\n');
    
    await sendTextMessage(
      from,
      [
        `📱 *${brand} ${model}*`,
        "",
        "💰 *Available Repairs:*",
        priceList,
        parts.length > 5 ? `   ... and ${parts.length - 5} more` : "",
        "",
        "What would you like to do?",
        "1️⃣ Type *'estimate'* - Get detailed repair quote",
        "2️⃣ Type *'book'* - Schedule appointment",
        "",
        "Or type 'cancel' to search again"
      ].filter(Boolean).join('\n')
    );
    
    // Pre-fill the brand and model, wait for user to choose estimate or book
    s.data.brand = brand;
    s.data.model = model;
    s.step = "choose_action";
    return;
  }
  
  if (s.step === "choose_action") {
    if (t === "estimate" || t === "1") {
      // Switch to estimate flow with pre-filled brand/model
      s.flow = "estimate";
      s.step = "issue";
      const issues = listIssues(s.data.brand, s.data.model);
      await sendTextMessage(
        from,
        [
          `Model: ${s.data.model}`,
          "What needs repair?",
          ...issues.map((m, i) => `${i + 1}) ${m}`),
          "Reply with the number or issue name.",
        ].join("\n")
      );
      return;
    }
    
    if (t === "book" || t === "2" || t === "appointment") {
      // Switch to booking flow with pre-filled brand/model
      s.flow = "booking";
      s.step = "name";
      await sendTextMessage(from, "Great! Let's book your appointment.\n\nWhat's your name?");
      return;
    }
    
    await sendTextMessage(from, "Please type 'estimate' or 'book' (or type 'cancel').");
    return;
  }
  
  endSession(from);
}

// Handle image messages for troubleshooting
async function handleImageMessage(from, message) {
  try {
    const imageId = message.image?.id;
    const caption = message.image?.caption || "";

    if (!imageId) {
      await sendTextMessage(from, "❌ Could not process the image. Please try sending it again.");
      return;
    }

    // Check if user is in troubleshooting session
    const session = sessions.get(from);
    if (session && session.flow === "troubleshoot") {
      // Download and analyze the image
      await sendTextMessage(from, "📸 *Image received!*\n\n🔍 Analyzing error screenshot...");

      try {
        const imageAnalysis = await analyzeErrorImage(from, imageId, caption);

        if (imageAnalysis) {
          await sendTextMessage(
            from,
            `🖼️ *IMAGE ANALYSIS COMPLETE*\n\n${imageAnalysis}\n\nDid this solve your problem? (yes/no)\n\nOr type 'book' to schedule professional repair.`
          );
          session.step = "analyze";
          session.data.hasImage = true;
          session.data.imageAnalysis = imageAnalysis;
        } else {
          await sendTextMessage(
            from,
            `❌ Could not analyze the image clearly.\n\nPlease describe the error you see in the image, or type 'book' to schedule a repair appointment.`
          );
        }
      } catch (error) {
        console.error('Image analysis error:', error);
        await sendTextMessage(
          from,
          `❌ Error analyzing image.\n\nPlease describe the error instead, or type 'book' to schedule professional repair.`
        );
      }
    } else {
      // Not in troubleshooting session
      await sendTextMessage(
        from,
        `📸 Thanks for the image!\n\nIf this is an error screenshot, type 'troubleshoot' to get help fixing it.\n\nOtherwise, describe what you need help with!`
      );
    }
  } catch (error) {
    console.error('Error handling image message:', error);
    await sendTextMessage(from, "❌ Error processing image. Please try again or describe the issue in text.");
  }
}

// Analyze error images using Gemini AI Vision
async function analyzeErrorImage(from, imageId, caption) {
  if (!GEMINI_API_KEY) {
    console.warn("GEMINI_API_KEY not configured - image analysis disabled");
    return null;
  }

  try {
    // First, download the image from WhatsApp
    const imageUrl = await getWhatsAppMediaUrl(imageId);

    if (!imageUrl) {
      return null;
    }

    // Use Gemini Pro Vision to analyze the image
    const prompt = `You are an expert technical support specialist analyzing an error screenshot. 

ANALYZE THIS ERROR IMAGE AND PROVIDE:

🔍 **ERROR IDENTIFICATION**
- Exact error code (if visible)
- Error message text
- Application/System affected
- When this typically occurs

🔧 **ROOT CAUSE ANALYSIS**
- Most likely cause
- Why this happens
- Related symptoms

✅ **STEP-BY-STEP SOLUTION** (Number each step clearly)
1. [First diagnostic/fix step with EXACT details]
2. [Second step with specific commands/settings]
3. [Continue with proven solutions]
4. [Include alternative methods]
5. [When to seek professional help]

⚠️ **SEVERITY & PREVENTION**
- Issue severity: Low/Medium/High
- Data loss risk: Yes/No
- How to prevent this

📋 **ADDITIONAL NOTES**
- Common mistakes to avoid
- Backup recommendations
- Related issues to watch for

${caption ? `\nUser Context: "${caption}"` : ''}

CRITICAL REQUIREMENTS:
✅ Only provide LEGITIMATE, SAFE, WORKING solutions
✅ Use specific commands, settings paths, and version info
✅ Include warnings for risky operations
✅ If unclear, state "Cannot clearly identify - need more info"
✅ Format with clear emoji headers and numbered steps

Be detailed, specific, and actionable. This is for real troubleshooting.`;

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents: [{
          parts: [
            { text: prompt },
            {
              inline_data: {
                mime_type: "image/jpeg",
                data: await downloadAndEncodeImage(imageUrl)
              }
            }
          ]
        }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 800,
          topP: 0.9,
          topK: 50
        }
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000
      }
    );

    const aiText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    return aiText?.trim() || null;

  } catch (error) {
    console.error('Gemini Vision API error:', error.response?.data || error.message);
    return null;
  }
}

// Get media URL from WhatsApp
async function getWhatsAppMediaUrl(mediaId) {
  if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    throw new Error("Missing WhatsApp credentials");
  }

  try {
    const response = await axios.get(
      `https://graph.facebook.com/v21.0/${mediaId}`,
      {
        headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }
      }
    );

    return response.data.url;
  } catch (error) {
    console.error('Error getting media URL:', error.response?.data || error.message);
    return null;
  }
}

// Download and base64 encode image for Gemini API
async function downloadAndEncodeImage(imageUrl) {
  try {
    const response = await axios.get(imageUrl, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
      responseType: 'arraybuffer',
      timeout: 15000
    });

    // Convert to base64
    const base64 = Buffer.from(response.data, 'binary').toString('base64');
    return base64;
  } catch (error) {
    console.error('Error downloading image:', error.message);
    return null;
  }
}

// --- Routes and webhook handling -------------------------------------------
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
      console.log(`[Session Check] Has active session: ${hasActiveSession(from)}`);
      // Save inquiry
      await saveInquiry(message);
      if (type === "text") {
        const text = message.text?.body || "";
        await handleTextCommand(from, text);
      } else if (type === "interactive") {
        const payload =
          message.interactive?.button_reply?.id || message.interactive?.list_reply?.id;
        await handleTextCommand(from, payload || "");
      } else if (type === "image") {
        await handleImageMessage(from, message);
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
    // Use finalAmount if available, otherwise fall back to estimate
    const finalAmount = appointment.finalAmount ? `₹${appointment.finalAmount.toLocaleString('en-IN')}` : estimate;
    
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
          `🔧 Issue fixed: ${issue}`,
          finalAmount ? `💰 Final Amount: *${finalAmount}*` : '',
          ``,
          `Thank you for choosing our service!`,
          `Please rate your experience by replying  1-5 stars ⭐`,
          ``,
          `We hope to serve you again soon! 😊`
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
  const { status, date, time, finalAmount } = req.body || {};
  try {
    let appointment = null;
    let oldStatus = null;
    
    if (mongoReady && Appointment && dbConnected()) {
      // Get old status first
      const oldDoc = await Appointment.findById(id);
      if (oldDoc) oldStatus = oldDoc.status;
      
      // Prepare update object
      const updateData = {};
      if (status !== undefined) updateData.status = status;
      if (date !== undefined) updateData.date = date;
      if (time !== undefined) updateData.time = time;
      if (finalAmount !== undefined) updateData.finalAmount = finalAmount;
      
      const doc = await Appointment.findByIdAndUpdate(id, { $set: updateData }, { new: true });
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
      time: time ?? store.appointments[idx].time,
      finalAmount: finalAmount ?? store.appointments[idx].finalAmount
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


