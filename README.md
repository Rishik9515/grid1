# RescueMesh 🚨

> A decentralized mesh network that turns smartphones into survivor detection devices during disasters.

---

## 📁 Project Structure

```
rescuemesh/
├── backend/
│   ├── server.js          ← Express + Socket.IO server (ALL routes here)
│   ├── database.js        ← SQLite3 database layer (ALL db logic here)
│   ├── package.json       ← Node.js dependencies
│   └── rescuemesh.db      ← Auto-created on first run (don't commit this)
│
├── frontend/
│   ├── index.html         ← Marketing website (landing page)
│   ├── real-dashboard.html ← Live command dashboard (map + devices + feed)
│   └── sw.js              ← Service worker (offline + background sync)
│
├── .gitignore
└── README.md
```

---

## ✅ Requirements

| Tool    | Version  | Download |
|---------|----------|----------|
| Node.js | ≥ 16.0.0 | https://nodejs.org |
| npm     | ≥ 7.0.0  | (included with Node) |
| Chrome  | any      | (for Bluetooth + mic) |

---

## 🚀 Quick Start (Local)

```bash
# 1. Navigate into backend
cd rescuemesh/backend

# 2. Install dependencies (~30 seconds)
npm install

# 3. Start the server
node server.js

# 4. Open in Chrome
open http://localhost:3000          # Marketing website
open http://localhost:3000/dashboard # Live dashboard
```

That's it. The SQLite database is created automatically on first run.

---

## 📱 Enable on Phones (requires HTTPS)

Bluetooth, GPS, and microphone only work on HTTPS in mobile browsers.

### Option A — ngrok (instant, free)
```bash
# Terminal 1: start server
node server.js

# Terminal 2: expose via HTTPS
npx ngrok http 3000
# → https://abc123.ngrok.io  ← open this on your phone
```

### Option B — Local SSL with mkcert
```bash
brew install mkcert   # macOS (or see mkcert.dev for other OS)
mkcert -install
mkcert localhost
# Adds localhost.pem + localhost-key.pem — update server.js to use https.createServer
```

---

## ☁️ Deploy to Render.com (Free Cloud)

1. Push to GitHub:
   ```bash
   git init && git add . && git commit -m "initial"
   git remote add origin https://github.com/YOU/rescuemesh.git
   git push -u origin main
   ```

2. Go to https://render.com → New → Web Service

3. Configure:
   | Field           | Value              |
   |-----------------|--------------------|
   | Root Directory  | `backend`          |
   | Build Command   | `npm install`      |
   | Start Command   | `node server.js`   |
   | Environment     | Node               |

4. Deploy → get URL like `https://rescuemesh.onrender.com`

---

## 🌐 URL Reference

| URL | Description |
|-----|-------------|
| `http://localhost:3000` | Marketing website (index.html) |
| `http://localhost:3000/dashboard` | Live command dashboard |
| `http://localhost:3000/health` | Server health + uptime |
| `http://localhost:3000/api/stats` | Full statistics |
| `http://localhost:3000/api/devices` | All active devices |
| `http://localhost:3000/api/detections` | Recent detections |
| `http://localhost:3000/api/detections/critical` | 90%+ confidence only |
| `http://localhost:3000/api/detections/heatmap` | GPS data for heatmap |
| `http://localhost:3000/api/alerts` | Active alerts |
| `http://localhost:3000/api/messages` | Message queue |
| `http://localhost:3000/api/sos` | POST to trigger SOS |
| `http://localhost:3000/api/admin/prune` | POST to clear old data |
| `http://localhost:3000/api/admin/db-info` | Database size/stats |

---

## 📡 REST API

### POST /api/detections
```json
{
  "deviceId": "phone-abc123",
  "type": "SOS",
  "confidence": 0.99,
  "location": { "lat": 12.9716, "lng": 77.5946 },
  "evidence": { "source": "microphone", "pattern": "SOS" }
}
```
**Response:** `{ "success": true, "id": "uuid" }`

### POST /api/devices
```json
{
  "deviceId":   "phone-abc123",
  "name":       "Field Unit Alpha",
  "connType":   "bluetooth",
  "location":   { "lat": 12.9716, "lng": 77.5946 },
  "batteryLevel": 84
}
```

### POST /api/sos
```json
{
  "deviceId":  "phone-abc123",
  "location":  { "lat": 12.9716, "lng": 77.5946 },
  "message":   "Trapped under rubble — Block C"
}
```

### GET /api/detections?limit=50&min_confidence=0.7&type=SOS&device=phone-abc123
Query params: `limit`, `offset`, `min_confidence`, `type`, `device`

---

## ⚡ Socket.IO Events

### Client → Server
| Event | Payload | Description |
|-------|---------|-------------|
| `register-device` | `{ deviceId, name, connType, location }` | Register this device |
| `detection` | `{ type, confidence, location, evidence }` | Send a detection |
| `broadcast-sos` | `{ location }` | Trigger SOS broadcast |
| `location-update` | `{ location: { lat, lng } }` | Update device GPS |
| `send-message` | `{ to, content, type }` | Send a message |
| `signaling` | `{ targetId, offer/answer/candidate }` | WebRTC signaling |
| `ping-device` | — | Keepalive ping |

### Server → Client
| Event | Payload | Description |
|-------|---------|-------------|
| `initial-data` | `{ detections, devices, alerts, stats }` | On connect |
| `detection` | detection object | New detection |
| `device-registered` | device object | New device joined |
| `device-update` | device array | Device list changed |
| `device-location-update` | `{ deviceId, location }` | GPS update |
| `device-offline` | `{ deviceId }` | Device disconnected |
| `alert` | alert object | Critical alert |
| `sos-alert` | `{ deviceId, location, message }` | SOS received |
| `stats-update` | stats object | Live stats (every 30s) |
| `pending-messages` | message array | Queued messages on connect |

---

## 🗄 Database Schema

### devices
| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | Device identifier |
| name | TEXT | Display name |
| conn_type | TEXT | bluetooth / wifi / own / unknown |
| location_lat | REAL | GPS latitude |
| location_lng | REAL | GPS longitude |
| battery_level | INTEGER | 0–100 |
| status | TEXT | active / offline |
| last_seen | INTEGER | Unix ms timestamp |

### detections
| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | UUID |
| device_id | TEXT | Source device |
| type | TEXT | TAP / VOICE / SOS / MOVEMENT / LOUD_SOUND |
| confidence | REAL | 0.0 – 1.0 |
| location_lat | REAL | GPS latitude |
| location_lng | REAL | GPS longitude |
| evidence | TEXT | JSON blob |
| priority | TEXT | critical / high / medium / low |
| acknowledged | INTEGER | 0 or 1 |
| created_at | INTEGER | Unix ms timestamp |

---

## 🔧 Troubleshooting

| Problem | Fix |
|---------|-----|
| `Cannot find module 'sqlite3'` | `cd backend && npm install` |
| `EADDRINUSE: port 3000` | `lsof -ti:3000 \| xargs kill` or change PORT |
| Bluetooth grayed out | Must be Chrome/Edge; must be on HTTPS (use ngrok) |
| GPS not working | Allow location in browser; may need HTTPS |
| Map tiles not loading | Need internet access for OpenStreetMap tiles |
| Phone can't connect | Same WiFi network; use `http://YOUR_PC_IP:3000` |
| Microphone not working | Allow mic permissions when prompted |
| Database errors | Delete `rescuemesh.db` and restart — it recreates automatically |

---

## 🌍 Environment Variables

Create a `.env` file in `backend/` (optional):
```
PORT=3000
HOST=0.0.0.0
NODE_ENV=production
```

The server reads `process.env.PORT` and `process.env.HOST` automatically.

---

## 📄 License

MIT — Free to use, modify, and deploy.
