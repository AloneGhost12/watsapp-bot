# 🤖 Gemini AI Integration Guide

## ✅ Step 1: API Key Added
Your Gemini API key has been added to `.env`:
```
GEMINI_API_KEY=AIzaSyBzh8RQ-e2tFgLvSYTV8XaBjtL2XgsSYAw
```

## 📝 Step 2: Add AI Functions to server.js

Open `server.js` and find line 260 (after the `logGraphError` function). Add these TWO NEW FUNCTIONS:

```javascript
// --- Gemini AI Integration --------------------------------------------------
async function askGemini(userMessage, conversationHistory = []) {
  if (!GEMINI_API_KEY) {
    console.warn("GEMINI_API_KEY not set - AI fallback disabled");
    return null;
  }

  try {
    // Build context about your repair business
    const systemContext = `You are a helpful assistant for a phone repair shop WhatsApp bot. 

Our Services:
- Phone screen repairs
- Battery replacements
- Water damage repairs
- Camera repairs
- Charging port repairs
- Software issues

Business Info:
- We repair: ${listBrands().join(", ")} phones
- Customers can type 'estimate' to get repair prices
- Customers can type 'book' to schedule an appointment
- Customers can type 'menu' to see all options

Your Role:
- Answer general questions about phone repairs, troubleshooting, and our services
- Be friendly, concise, and helpful
- If customer wants pricing or booking, guide them to use 'estimate' or 'book' commands
- Keep responses under 150 words
- Use simple language and emojis when appropriate

Current conversation:`;

    // Build conversation history for context
    const historyText = conversationHistory.length > 0
      ? conversationHistory.map(msg => `${msg.role}: ${msg.text}`).join('\n')
      : '';

    const prompt = `${systemContext}\n${historyText}\n\nCustomer: ${userMessage}\n\nAssistant:`;

    // Call Gemini API
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
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
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000
      }
    );

    const aiText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (aiText) {
      console.log(`[Gemini AI] Generated response (${aiText.length} chars)`);
      return aiText.trim();
    }
    return null;
  } catch (error) {
    console.error('[Gemini AI] Error:', error.response?.data || error.message);
    return null;
  }
}

// Get recent conversation history for context
async function getConversationHistory(contact, limit = 5) {
  try {
    if (mongoReady && Inquiry && dbConnected()) {
      const msgs = await Inquiry.find({ contact })
        .sort({ createdAt: -1 })
        .limit(limit * 2); // Get more to filter
      
      return msgs.reverse().slice(-limit).map(m => ({
        role: m.direction === 'in' ? 'customer' : 'assistant',
        text: m.text || ''
      }));
    }
  } catch (e) {
    console.error('Failed to get conversation history:', e.message);
  }
  return [];
}
```

## 🔧 Step 3: Update handleTextCommand Function

Find the `handleTextCommand` function (around line 350). At the **END** of this function, BEFORE the final line:
```javascript
await sendTextMessage(from, "I didn't catch that. Type 'menu' to see options.");
```

Add this AI FALLBACK CODE:

```javascript
  // AI Fallback - Use Gemini for unknown queries
  if (GEMINI_API_KEY) {
    const history = await getConversationHistory(from, 5);
    const aiResponse = await askGemini(text, history);
    if (aiResponse) {
      await sendTextMessage(from, aiResponse);
      return;
    }
  }
```

## 🎯 What This Does:

1. **Keeps your existing flows** - estimate and booking still work perfectly
2. **Adds AI intelligence** - When users ask something you haven't programmed, Gemini answers
3. **Context-aware** - Remembers last 5 messages for better responses
4. **Smart fallback** - Only uses AI when needed, saves API calls

## 💬 Example Conversations:

**Customer:** "How long does a screen repair take?"
**AI:** "Most screen repairs take 30-60 minutes ⏰ We can usually fix it while you wait! For an accurate estimate and to book an appointment, type 'estimate' or 'book'. 📱"

**Customer:** "My phone got wet, what should I do?"
**AI:** "If your phone got wet, act quickly! 💧 Turn it off immediately, don't charge it, and bring it to us ASAP. We specialize in water damage repairs. Type 'book' to schedule an urgent appointment! 🆘"

**Customer:** "Do you fix cameras?"
**AI:** "Yes, we do camera repairs! 📸 We can fix front cameras, back cameras, and lens issues. Type 'estimate' to get a price quote for your specific phone model."

## 🚀 To Test:

1. Save `server.js` with the changes above
2. Restart your server: `npm start`
3. Send a WhatsApp message like: "How long does a battery replacement take?"
4. Watch the AI respond intelligently! 🤖

## 📊 Monitoring:

Check the console logs for:
```
[Gemini AI] Generated response (125 chars)
```

This shows the AI is working!

## ⚙️ For Render Deployment:

Add this environment variable in Render dashboard:
```
GEMINI_API_KEY=AIzaSyBzh8RQ-e2tFgLvSYTV8XaBjtL2XgsSYAw
```

---

**Questions?** The AI will make your bot WAY smarter while keeping all your existing booking/estimate flows working perfectly! 🎉
