# 🧪 Testing the Admin Dashboard

## Quick Test Data Setup

To see the admin dashboard in action with sample data, run these commands:

### 1. Seed Sample Conversations

```powershell
# Create test conversation 1
curl.exe -X POST -H "x-admin-token: local-admin-12345" -H "Content-Type: application/json" -d "{\"contact\":\"919876543210\",\"text\":\"Hi, I need screen repair for iPhone 11\"}" http://localhost:15000/admin/seed

# Create test conversation 2
curl.exe -X POST -H "x-admin-token: local-admin-12345" -H "Content-Type: application/json" -d "{\"contact\":\"919876543211\",\"text\":\"My Samsung Galaxy screen is broken\"}" http://localhost:15000/admin/seed

# Create test conversation 3
curl.exe -X POST -H "x-admin-token: local-admin-12345" -H "Content-Type: application/json" -d "{\"contact\":\"919876543212\",\"text\":\"How much for battery replacement?\"}" http://localhost:15000/admin/seed
```

### 2. Test Direct Reply

After seeding data:
1. Open admin dashboard: `http://localhost:15000/admin`
2. Enter admin token: `local-admin-12345`
3. Click on any conversation in the left panel
4. Type a message in the composer
5. Press Enter or click Send
6. See your message appear in the chat!

### 3. Test Quick Message

1. Go to the "Quick Message" panel on the right
2. Enter phone number: `919876543213`
3. Type a message
4. Click "Send Message"
5. See success notification!

### 4. Test Appointment Management

To manually add an appointment to the database, you can use the bot's booking flow or directly add to `data/appointments.json`:

```json
{
  "appointments": [
    {
      "id": "appt_1730000000000",
      "createdAt": "2025-10-26T10:00:00.000Z",
      "customerWhatsApp": "919876543210",
      "name": "John Doe",
      "brand": "Apple",
      "model": "iPhone 11",
      "issue": "Screen",
      "estimate": 9000,
      "date": "2025-10-28",
      "time": "14:00",
      "status": "pending"
    },
    {
      "id": "appt_1730000000001",
      "createdAt": "2025-10-26T11:00:00.000Z",
      "customerWhatsApp": "919876543211",
      "name": "Jane Smith",
      "brand": "Samsung",
      "model": "Galaxy S20",
      "issue": "Battery",
      "estimate": 3800,
      "date": "2025-10-29",
      "time": "11:00",
      "status": "confirmed"
    },
    {
      "id": "appt_1730000000002",
      "createdAt": "2025-10-26T12:00:00.000Z",
      "customerWhatsApp": "919876543212",
      "name": "Bob Johnson",
      "brand": "Xiaomi",
      "model": "Redmi Note 10",
      "issue": "Charging Port",
      "estimate": 1500,
      "date": "2025-10-27",
      "time": "16:30",
      "status": "completed"
    }
  ]
}
```

After adding this data, click "Refresh" in the admin dashboard to see all appointments!

## Testing the Full Flow

### Scenario 1: Customer Inquiry
1. Seed a conversation (see above)
2. Open admin dashboard
3. See the conversation appear in the left panel
4. Click to open the chat
5. View the message history
6. Type a reply: "Sure! Which iPhone model do you have?"
7. Press Enter to send
8. See your message appear in blue (outgoing)

### Scenario 2: Appointment Update
1. Make sure you have appointments (see above)
2. Open admin dashboard
3. Scroll to the "Appointments" section on the right
4. See the list of appointments
5. Click "✓ Confirm" on a pending appointment
6. See the status change to "confirmed" with blue badge
7. Click "✓ Complete" to mark as done
8. See the status change to "completed" with green badge

### Scenario 3: Quick Message
1. Open admin dashboard
2. Go to "Quick Message" section
3. Enter: `919999999999`
4. Message: `Hello! Your device is ready for pickup.`
5. Click "Send Message"
6. See toast notification: "Message sent successfully"
7. See status update below the form

## Features to Try

### ✨ Animations
- Watch the header slide down on page load
- Hover over chat items to see background change
- Hover over buttons to see lift effect
- Hover over stat cards to see scale effect
- Watch messages slide in when loading a chat
- See toast notifications slide from the right

### 🎨 UI Elements
- Notice the gradient backgrounds
- See custom scrollbars in chat list
- Look at the pulsing "Live" badge
- Check out color-coded status badges
- View empty states when no data

### 📊 Dashboard Stats
- Watch numbers update after refresh
- See total conversations count
- Check total appointments
- Monitor pending count
- Track completed count

### 🔍 Search & Filter
- Type in the search box to filter conversations
- Use status dropdown to filter appointments
- Click "Filter" to apply appointment filters

### 🔄 Auto-Refresh
- Wait 30 seconds
- Watch data automatically refresh
- No need to click refresh manually

## Troubleshooting Test Data

### If conversations don't appear:
```powershell
# Check if data was saved
curl.exe -H "x-admin-token: local-admin-12345" http://localhost:15000/admin/chats
```

### If messages don't send:
- Verify server is running on port 15000
- Check admin token is correct
- Look for errors in terminal
- Ensure MongoDB connection is active

### If appointments don't load:
- Check `data/appointments.json` exists
- Verify JSON format is valid
- Click "Refresh" button in admin panel
- Check browser console for errors

## Expected Results

After successful setup, you should see:

**Left Panel:**
- 3 conversations with different phone numbers
- Avatar bubbles with last 2 digits
- Last message preview
- Time stamps

**Center Panel:**
- Selected conversation messages
- Incoming messages (gray bubbles)
- Outgoing messages (purple-blue gradient bubbles)
- Composer at bottom ready to type

**Right Panel:**
- Stats showing: 3 chats, X appointments
- Quick message form ready to use
- Appointment table with sample data
- Action buttons for each appointment

## 🎉 Success Checklist

- [ ] Server running on port 15000
- [ ] Admin dashboard loads in browser
- [ ] Login with admin token works
- [ ] Conversations appear in left panel
- [ ] Can click and view chat history
- [ ] Can type and send messages
- [ ] Messages appear in chat bubble format
- [ ] Quick message form works
- [ ] Appointments load in table
- [ ] Can update appointment status
- [ ] Stats show correct numbers
- [ ] Refresh button updates data
- [ ] Toast notifications appear
- [ ] Animations are smooth
- [ ] UI looks modern and professional

All checkmarks? **You're ready to go! 🚀**
