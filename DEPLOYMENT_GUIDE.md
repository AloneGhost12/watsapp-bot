# 🚀 Deployment Guide - WhatsApp Repair Bot

## Option 1: Render (Recommended - Free)

### Steps:

1. **Push your code to GitHub** (already done ✅)

2. **Go to Render**: https://render.com
   - Sign up with your GitHub account

3. **Create New Web Service**:
   - Click "New +" → "Web Service"
   - Connect your GitHub repository: `AloneGhost12/watsapp-bot`
   - Configure:
     ```
     Name: watsapp-bot
     Region: Singapore (or closest to you)
     Branch: main
     Runtime: Node
     Build Command: npm install
     Start Command: npm start
     Instance Type: Free
     ```

4. **Add Environment Variables** in Render Dashboard:
   ```
   VERIFY_TOKEN=your_verify_token_here
   ACCESS_TOKEN=your_whatsapp_access_token
   PHONE_NUMBER_ID=your_phone_number_id
   MONGO_URI=your_mongodb_atlas_uri
   MONGO_DB=test
   ADMIN_TOKEN=local-admin-12345
   USE_MEMORY_DB=false
   PORT=15000
   ```

5. **Deploy**: Click "Create Web Service"
   - Wait 2-3 minutes for deployment
   - Your URL: `https://watsapp-bot-xxxx.onrender.com`

6. **Update WhatsApp Webhook**:
   - Callback URL: `https://your-app.onrender.com/webhook`
   - Verify Token: (same as VERIFY_TOKEN above)

### Admin Panel Access:
```
https://your-app.onrender.com/admin
```

---

## Option 2: Railway (Easy & Free)

### Steps:

1. **Go to Railway**: https://railway.app
2. **New Project** → **Deploy from GitHub**
3. **Select Repository**: `AloneGhost12/watsapp-bot`
4. **Add Environment Variables** (same as above)
5. **Deploy**: Automatic!
6. **Get URL**: Settings → Domains → Generate Domain

---

## Option 3: Heroku (Popular)

### Steps:

1. **Install Heroku CLI**: https://devcenter.heroku.com/articles/heroku-cli
2. **Login**:
   ```bash
   heroku login
   ```
3. **Create App**:
   ```bash
   heroku create watsapp-repair-bot
   ```
4. **Add Environment Variables**:
   ```bash
   heroku config:set VERIFY_TOKEN=your_token
   heroku config:set ACCESS_TOKEN=your_token
   heroku config:set PHONE_NUMBER_ID=your_id
   heroku config:set MONGO_URI=your_mongodb_uri
   heroku config:set MONGO_DB=test
   heroku config:set ADMIN_TOKEN=local-admin-12345
   heroku config:set USE_MEMORY_DB=false
   ```
5. **Deploy**:
   ```bash
   git push heroku main
   ```

---

## Option 4: DigitalOcean App Platform

### Steps:

1. **Go to**: https://cloud.digitalocean.com/apps
2. **Create App** → **GitHub** → Select your repo
3. **Configure**:
   - Type: Web Service
   - Run Command: `npm start`
   - HTTP Port: 15000
4. **Add Environment Variables**
5. **Deploy**

---

## Option 5: Vercel (Serverless)

⚠️ **Note**: Requires converting to serverless functions

1. **Install Vercel CLI**:
   ```bash
   npm i -g vercel
   ```
2. **Deploy**:
   ```bash
   vercel
   ```

---

## 🔐 Important: After Deployment

### 1. Update WhatsApp Webhook:
- Go to Meta Developer Console
- Configure Webhook with your new URL
- Test webhook connection

### 2. Access Admin Panel:
```
https://your-deployed-url.com/admin
```

### 3. Test the Bot:
- Send "hi" to your WhatsApp number
- Bot should respond!

---

## 🎯 Quick Deploy Checklist

- [ ] Code pushed to GitHub
- [ ] MongoDB Atlas running
- [ ] WhatsApp Business API setup
- [ ] Environment variables configured
- [ ] Deploy to hosting platform
- [ ] Update webhook URL
- [ ] Test bot and admin panel

---

## 🆘 Troubleshooting

### "Application Error" or Crash:
- Check environment variables are set correctly
- Verify MongoDB URI is correct
- Check logs in hosting platform

### Webhook Not Working:
- Verify callback URL is correct
- Check VERIFY_TOKEN matches
- Ensure app is running (not sleeping)

### Admin Panel Not Loading:
- Check if server is running
- Verify ADMIN_TOKEN is set
- Try: `https://your-url.com/admin/health`

---

## 💡 Recommended Setup

**Best Free Option**: 
```
Render (Server) + MongoDB Atlas (Database) + Meta WhatsApp API
```

This gives you:
- ✅ Free hosting
- ✅ Always-on server
- ✅ Automatic deployments
- ✅ SSL certificate included
- ✅ Easy environment variable management

---

## 📞 Need Help?

Check your deployment logs:
- **Render**: Dashboard → Logs
- **Railway**: Dashboard → Deployments → View Logs
- **Heroku**: `heroku logs --tail`
