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
    "📋 *Main Menu* - Choose what you need:\n\n💰 Get repair pricing instantly\n📅 Schedule your repair visit\n🆘 Learn how to use this bot\n\n✨ Or just ask me anything naturally!",
    [
      { id: "estimate", title: "💰 Get Estimate" },
      { id: "book", title: "📅 Book Appointment" },
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
  
  // Allow menu number selections (1, 2, 3) when NO active session
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
      await sendTextMessage(
        from,
        [
          "I can do these:",
          "• estimate — get repair cost by brand/model/issue",
          "• book — book an appointment",
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
      "👋 Hey there! Welcome to our Electronics Repair Center! ✨\n\n🛠️ I can help you with:\n📱 Phones • 💻 Laptops • 📺 TVs • ⌚ Watches • 🔊 Speakers • 🎧 Headphones • 📷 Cameras\n\n💬 Just tell me what you need or type:\n📋 *menu* - See all options\n💰 *estimate* - Get repair price\n📅 *book* - Schedule appointment\n\n🤔 Or simply ask me anything!"
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

  if (s.flow === "estimate") return continueEstimate(from, s, t);
  if (s.flow === "booking") return continueBooking(from, s, t);
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

function isValidDate(str) {
  // YYYY-MM-DD
  return /^\d{4}-\d{2}-\d{2}$/.test(str);
}
function isValidTime(str) {
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
      
      // If no price in database, allow booking without exact price
      if (price == null) {
        s.data.issue = input;
        s.data.price = null;
        s.step = "date";
        await sendTextMessage(
          from,
          `📝 Noted: ${s.data.brand} ${s.data.model} - ${input}\n\n⚠️ We'll provide an exact quote during your appointment.\n\nWhat date works for you? (YYYY-MM-DD, e.g., 2025-10-27)`
        );
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


