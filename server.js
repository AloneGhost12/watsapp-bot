// Clean rewrite of file to resolve merge artifacts
import express from "express";
import axios from "axios";
import crypto from "crypto";

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

async function sendTextMessage(to, body) {
  if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    console.error("Missing ACCESS_TOKEN or PHONE_NUMBER_ID in environment variables");
    throw new Error("Missing WhatsApp credentials");
  }
  const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;
  await axios.post(
    url,
    { messaging_product: "whatsapp", to, text: { body } },
    { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
  );
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

async function handleTextCommand(from, text) {
  const t = (text || "").trim().toLowerCase();
  if (t === "hi" || t === "hello") {
    await sendTextMessage(from, "Hey Adharsh 👋! I’m your WhatsApp bot. Type 'help' for options.");
    return;
  }
  if (t === "help") {
    await sendTextMessage(
      from,
      [
        "Here are some things you can try:",
        "• hi — get a greeting",
        "• menu — see features",
        "• echo <text> — I’ll repeat",
      ].join("\n")
    );
    return;
  }
  if (t === "menu") {
    await sendTextMessage(
      from,
      ["Menu:", "1) Info", "2) Echo", "3) Help", "Reply with: echo your-text, or type help"].join(
        "\n"
      )
    );
    return;
  }
  if (t.startsWith("echo ")) {
    await sendTextMessage(from, text.slice(5));
    return;
  }
  await sendTextMessage(from, "I didn’t catch that. Type 'help' to see options.");
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
    const errorData = error.response ? error.response.data : error.message;
    console.error("Error processing message:", JSON.stringify(errorData, null, 2));
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
