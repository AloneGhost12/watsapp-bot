 import express from "express";
import bodyParser from "body-parser";
import axios from "axios";

const app = express();
app.use(bodyParser.json());

// --- Get your tokens from Render's Environment Variables ---
// This is safer than hardcoding them!
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// --- Set the Port (Render will provide this) ---
const PORT = process.env.PORT || 10000;

// 🧩 Verify webhook (Meta calls this once)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  // Check if a token and mode is in the query string
  if (mode && token) {
    // Check the mode and token sent are correct
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      // Respond with the challenge token from the request
      console.log("WEBHOOK_VERIFIED");
      res.status(200).send(challenge);
    } else {
      // Respond with '403 Forbidden' if verify tokens do not match
      console.log("WEBHOOK_VERIFICATION_FAILED - Token Mismatch");
      res.sendStatus(403);
    }
  } else {
    // Respond with '400 Bad Request' if 'hub.mode' or 'hub.verify_token' is missing
    console.log("WEBHOOK_VERIFICATION_FAILED - Missing parameters");
    res.sendStatus(400);
  }
});

// 💬 Handle messages
app.post("/webhook", async (req, res) => {
  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (message && message.text?.body?.toLowerCase() === "hi") {
      const from = message.from;
      console.log(`Received "hi" from ${from}`);

      // Make sure all environment variables are loaded
      if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) {
        console.error("Missing ACCESS_TOKEN or PHONE_NUMBER_ID in environment variables");
        return res.sendStatus(500); // Internal server error
      }

      await axios.post(
        `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
        {
          messaging_product: "whatsapp",
          to: from,
          text: { body: "Hey Adharsh 👋! This is your WhatsApp bot replying!" },
        },
        {
          headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
        }
      );

      console.log(`Reply sent to ${from}`);
    }
  } catch (error) {
    // Log detailed error
    const errorData = error.response ? error.response.data : error.message;
    console.error("Error processing message:", JSON.stringify(errorData, null, 2));
  }

  // Always send 200 OK to Facebook, otherwise they will retry
  res.sendStatus(200);
});

// 🟢 Start server
app.listen(PORT, () => {
  console.log(`Bot is running on port ${PORT}`);
  if (!VERIFY_TOKEN || !ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    console.warn("--- WARNING: Missing environment variables! Bot may not work correctly. ---");
    console.warn("Please set VERIFY_TOKEN, ACCESS_TOKEN, and PHONE_NUMBER_ID in Render.");
  }
});
