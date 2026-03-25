/**
 * ═══════════════════════════════════════════════════
 *  RescueMesh — Backend Server
 *  Express + Socket.IO + SQLite
 *  Serves: REST API + WebSocket + Static Frontend
 * ═══════════════════════════════════════════════════
 */

const express     = require('express');
const http        = require('http');
const socketIo    = require('socket.io');
const cors        = require('cors');
const helmet      = require('helmet');
const compression = require('compression');
const path        = require('path');
const db          = require('./database');

// ── App Setup ─────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = socketIo(server, {
    cors: { origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE'] },
    pingTimeout:  60000,
    pingInterval: 25000
});

// In-memory map of socketId → deviceId (for fast disconnect handling)
const socketDeviceMap = new Map();

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(helmet({
    contentSecurityPolicy: false,   // Allow CDN scripts (Leaflet, Socket.IO)
    crossOriginEmbedderPolicy: false
}));
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logger (simple)
app.use((req, _res, next) => {
    if (!req.path.startsWith('/socket.io')) {
        console.log(`${new Date().toISOString().slice(11,19)} ${req.method} ${req.path}`);
    }
    next();
});

// ── Static Files ───────────────────────────────────────────────────────────────
const frontendPath = path.join(__dirname, '../frontend');
app.use(express.static(frontendPath));
console.log('📁 Serving frontend from:', frontendPath);

// ── Page Routes ────────────────────────────────────────────────────────────────
app.get('/',                     (_req, res) => res.sendFile(path.join(frontendPath, 'index.html')));
app.get('/dashboard',            (_req, res) => res.sendFile(path.join(frontendPath, 'real-dashboard.html')));
app.get('/real-dashboard',       (_req, res) => res.sendFile(path.join(frontendPath, 'real-dashboard.html')));
app.get('/real-dashboard.html',  (_req, res) => res.sendFile(path.join(frontendPath, 'real-dashboard.html')));
app.get('/index.html',           (_req, res) => res.sendFile(path.join(frontendPath, 'index.html')));

// ══════════════════════════════════════════════════════════════════════════════
//  REST API
// ══════════════════════════════════════════════════════════════════════════════

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
    const dbSize = await db.getDbSize().catch(() => 0);
    res.json({
        status:   'healthy',
        uptime:   Math.round(process.uptime()),
        memory:   process.memoryUsage().heapUsed,
        db_size:  dbSize,
        sockets:  io.engine.clientsCount,
        time:     new Date().toISOString()
    });
});

// ── Stats ─────────────────────────────────────────────────────────────────────
app.get('/api/stats', async (_req, res) => {
    try {
        const [stats, byType, topDevices] = await Promise.all([
            db.getStatistics(),
            db.getDetectionsByType(),
            db.getMostActiveDevices(5)
        ]);
        res.json({ ...stats, by_type: byType, top_devices: topDevices, timestamp: Date.now() });
    } catch(err) {
        console.error('GET /api/stats:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Devices ───────────────────────────────────────────────────────────────────
app.get('/api/devices', async (req, res) => {
    try {
        const all      = req.query.all === 'true';
        const devices  = all ? await db.getAllDevices() : await db.getActiveDevices();
        res.json(devices);
    } catch(err) {
        console.error('GET /api/devices:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/devices/:id', async (req, res) => {
    try {
        const device = await db.getDevice(req.params.id);
        if (!device) return res.status(404).json({ error: 'Device not found' });
        res.json(device);
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/devices', async (req, res) => {
    try {
        const { deviceId, name, connType, connectionType, location, batteryLevel } = req.body;
        if (!deviceId) return res.status(400).json({ error: 'deviceId is required' });

        await db.registerDevice(
            deviceId,
            name || req.body.deviceName,
            connType || connectionType,
            location,
            batteryLevel
        );

        const device = await db.getDevice(deviceId);
        io.emit('device-registered', device);
        console.log(`📱 Device registered: ${name || deviceId}`);
        res.json({ success: true, device });
    } catch(err) {
        console.error('POST /api/devices:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Alias for old route
app.post('/api/register-device', async (req, res) => {
    req.body.deviceId = req.body.deviceId || req.body.id;
    req.body.name     = req.body.name || req.body.deviceName;
    return app._router.handle({ ...req, url: '/api/devices', path: '/api/devices', method: 'POST' }, res, () => {});
});

app.put('/api/devices/:id/location', async (req, res) => {
    try {
        const { lat, lng, accuracy } = req.body;
        await db.updateDeviceLocation(req.params.id, { lat, lng, accuracy });
        io.emit('device-location-update', { deviceId: req.params.id, location: { lat, lng, accuracy } });
        res.json({ success: true });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/devices/:id', async (req, res) => {
    try {
        await db.deleteDevice(req.params.id);
        io.emit('device-removed', { deviceId: req.params.id });
        res.json({ success: true });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Detections ────────────────────────────────────────────────────────────────
app.get('/api/detections', async (req, res) => {
    try {
        const dets = await db.getDetections({
            limit:         Math.min(parseInt(req.query.limit)  || 100, 500),
            offset:        parseInt(req.query.offset)          || 0,
            minConfidence: parseFloat(req.query.min_confidence)|| 0,
            type:          req.query.type   || null,
            deviceId:      req.query.device || null
        });
        res.json(dets);
    } catch(err) {
        console.error('GET /api/detections:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/detections/critical', async (_req, res) => {
    try {
        res.json(await db.getCriticalDetections(50));
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/detections/heatmap', async (_req, res) => {
    try {
        res.json(await db.getHeatmapData(300));
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/detections/:deviceId', async (req, res) => {
    try {
        res.json(await db.getDetectionsForDevice(req.params.deviceId, 100));
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/detections', async (req, res) => {
    try {
        const det = {
            deviceId:   req.body.deviceId   || req.body.device_id || 'unknown',
            type:       req.body.type        || 'UNKNOWN',
            confidence: parseFloat(req.body.confidence) || 0,
            location:   req.body.location   || { lat: 0, lng: 0 },
            evidence:   req.body.evidence   || {},
            timestamp:  req.body.timestamp  || Date.now()
        };

        const id   = await db.saveDetection(det);
        const full = { id, ...det };

        // Broadcast to all connected dashboard clients
        io.emit('detection', full);

        // Auto-create alert for critical detections
        if (det.confidence >= 0.9) {
            const alertId = await db.createAlert({
                detectionId: id,
                deviceId:    det.deviceId,
                severity:    'critical',
                message:     `${det.type} detected with ${(det.confidence*100).toFixed(0)}% confidence`
            });
            io.emit('alert', { alertId, detection: full });
        }

        console.log(`🔍 Detection [${det.type}] conf=${(det.confidence*100).toFixed(0)}% dev=${det.deviceId}`);
        res.json({ success: true, id });
    } catch(err) {
        console.error('POST /api/detections:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/detections/:id/acknowledge', async (req, res) => {
    try {
        await db.acknowledgeDetection(req.params.id, req.body.by || 'dashboard');
        io.emit('detection-acknowledged', { detectionId: req.params.id });
        res.json({ success: true });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Alerts ────────────────────────────────────────────────────────────────────
app.get('/api/alerts', async (_req, res) => {
    try {
        res.json(await db.getActiveAlerts());
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/alerts', async (req, res) => {
    try {
        const id = await db.createAlert(req.body);
        io.emit('alert', { alertId: id, ...req.body });
        res.json({ success: true, id });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/alerts/:id/resolve', async (req, res) => {
    try {
        await db.resolveAlert(req.params.id);
        io.emit('alert-resolved', { alertId: req.params.id });
        res.json({ success: true });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Messages ──────────────────────────────────────────────────────────────────
app.get('/api/messages/:deviceId', async (req, res) => {
    try {
        res.json(await db.getPendingMessages(req.params.deviceId));
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/messages', async (req, res) => {
    try {
        const id = await db.queueMessage(req.body);
        // If target is connected, deliver now via Socket.IO
        if (req.body.toDevice) {
            io.to(`device:${req.body.toDevice}`).emit('message', { id, ...req.body });
        } else {
            io.emit('broadcast-message', { id, ...req.body });
        }
        res.json({ success: true, id });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/messages/:id/delivered', async (req, res) => {
    try {
        await db.markDelivered(req.params.id);
        res.json({ success: true });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// ── SOS Broadcast ─────────────────────────────────────────────────────────────
app.post('/api/sos', async (req, res) => {
    try {
        const { deviceId, location, message } = req.body;

        // Save as a detection
        const detId = await db.saveDetection({
            deviceId: deviceId || 'sos',
            type: 'SOS',
            confidence: 0.99,
            location: location || { lat: 0, lng: 0 },
            evidence: { emergency: true, message }
        });

        // Create critical alert
        const alertId = await db.createAlert({
            detectionId: detId,
            deviceId,
            severity: 'critical',
            message:  message || '🚨 EMERGENCY SOS — Immediate assistance required!'
        });

        // Broadcast to ALL clients
        io.emit('sos-alert', {
            alertId, detectionId: detId, deviceId, location, message,
            timestamp: Date.now()
        });

        console.log(`🚨 SOS broadcast from ${deviceId}`);
        res.json({ success: true, detectionId: detId, alertId });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// ── WebRTC Signaling ──────────────────────────────────────────────────────────
app.post('/api/signaling', (req, res) => {
    const { targetId, action, offer, answer, candidate } = req.body;
    if (targetId) {
        io.to(`device:${targetId}`).emit('signaling', { action, offer, answer, candidate, from: req.body.fromId });
    }
    res.json({ success: true });
});

// ── Admin ─────────────────────────────────────────────────────────────────────
app.post('/api/admin/prune', async (req, res) => {
    try {
        const days    = parseInt(req.body.days) || 7;
        const deleted = await db.pruneOldDetections(days);
        await db.vacuum();
        res.json({ success: true, deleted, message: `Pruned ${deleted} detections older than ${days} days` });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/db-info', async (_req, res) => {
    try {
        const size  = await db.getDbSize();
        const stats = await db.getStatistics();
        res.json({ db_size_bytes: size, db_size_mb: (size/1048576).toFixed(2), ...stats });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// ── 404 Handler ───────────────────────────────────────────────────────────────
app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
        return res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
    }
    // For non-API routes, serve the dashboard (SPA fallback)
    res.sendFile(path.join(frontendPath, 'index.html'));
});

// ── Error Handler ─────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// ══════════════════════════════════════════════════════════════════════════════
//  SOCKET.IO EVENTS
// ══════════════════════════════════════════════════════════════════════════════
io.on('connection', async (socket) => {
    console.log(`🔌 Socket connected: ${socket.id}`);

    // Create session record
    await db.createSession(socket.id, null).catch(() => {});

    // ── Send initial data snapshot ───────────────────────────────────────────
    try {
        const [detections, devices, alerts, stats] = await Promise.all([
            db.getRecentDetections(50),
            db.getActiveDevices(),
            db.getActiveAlerts(),
            db.getStatistics()
        ]);
        socket.emit('initial-data', { detections, devices, alerts, stats });
    } catch(err) {
        console.error('Initial data error:', err.message);
    }

    // ── Device Registration ──────────────────────────────────────────────────
    socket.on('register-device', async (data) => {
        try {
            const devId = data.deviceId || data.id || socket.id;
            await db.registerDevice(
                devId,
                data.deviceName || data.name,
                data.connectionType || data.connType || data.type,
                data.location,
                data.batteryLevel
            );

            // Join a device-specific room for targeted messages
            socket.join(`device:${devId}`);
            socketDeviceMap.set(socket.id, devId);

            // Update session
            await db.closeSession(socket.id).catch(() => {});
            await db.createSession(socket.id, devId).catch(() => {});

            const device  = await db.getDevice(devId);
            const devices = await db.getActiveDevices();
            io.emit('device-registered', device);
            io.emit('device-update', devices);

            // Deliver any pending messages
            const pending = await db.getPendingMessages(devId);
            if (pending.length > 0) {
                socket.emit('pending-messages', pending);
            }
        } catch(err) {
            console.error('register-device error:', err.message);
        }
    });

    // ── Detection from client ────────────────────────────────────────────────
    socket.on('detection', async (data) => {
        try {
            const det = {
                ...data,
                timestamp: data.timestamp || Date.now()
            };
            const id = await db.saveDetection(det).catch(() => null);
            const full = { ...det, id };
            io.emit('detection', full);

            // Auto-alert on critical
            if (det.confidence >= 0.9) {
                const alertId = await db.createAlert({
                    detectionId: id,
                    deviceId:    det.deviceId,
                    severity:    'critical',
                    message:     `${det.type} — ${(det.confidence*100).toFixed(0)}% confidence`
                }).catch(() => null);
                if (alertId) io.emit('alert', { alertId, detection: full });
            }
        } catch(err) {
            console.error('detection socket error:', err.message);
        }
    });

    // ── SOS from client ──────────────────────────────────────────────────────
    socket.on('broadcast-sos', async (data) => {
        try {
            const devId = socketDeviceMap.get(socket.id) || socket.id;
            const detId = await db.saveDetection({
                deviceId:   devId,
                type:       'SOS',
                confidence: 0.99,
                location:   data.location || { lat: 0, lng: 0 },
                evidence:   { emergency: true, source: 'socket' }
            }).catch(() => null);

            io.emit('sos-alert', {
                from:        socket.id,
                deviceId:    devId,
                detectionId: detId,
                location:    data.location,
                timestamp:   Date.now()
            });
            console.log(`🚨 SOS from socket ${socket.id}`);
        } catch(err) {
            console.error('broadcast-sos error:', err.message);
        }
    });

    // ── Location update from field device ────────────────────────────────────
    socket.on('location-update', async (data) => {
        try {
            const devId = socketDeviceMap.get(socket.id) || data.deviceId;
            if (devId && data.location) {
                await db.updateDeviceLocation(devId, data.location);
                io.emit('device-location-update', { deviceId: devId, location: data.location });
            }
        } catch(err) {
            console.error('location-update error:', err.message);
        }
    });

    // ── Message relay ────────────────────────────────────────────────────────
    socket.on('send-message', async (data) => {
        try {
            const id = await db.queueMessage({
                fromDevice: socketDeviceMap.get(socket.id) || socket.id,
                toDevice:   data.to || null,
                content:    data.content,
                type:       data.type || 'message',
                priority:   data.priority || 5
            });

            if (data.to) {
                io.to(`device:${data.to}`).emit('message', { id, ...data });
            } else {
                socket.broadcast.emit('broadcast-message', { id, ...data });
            }
        } catch(err) {
            console.error('send-message error:', err.message);
        }
    });

    // ── WebRTC signaling relay ────────────────────────────────────────────────
    socket.on('signaling', (data) => {
        if (data.targetId) {
            io.to(`device:${data.targetId}`).emit('signaling', {
                ...data,
                from: socketDeviceMap.get(socket.id) || socket.id
            });
        }
    });

    // ── Ping / keepalive ─────────────────────────────────────────────────────
    socket.on('ping-device', () => {
        const devId = socketDeviceMap.get(socket.id);
        if (devId) db.registerDevice(devId, null, null, null, 100).catch(() => {});
        socket.emit('pong-device', { timestamp: Date.now() });
    });

    // ── Disconnect ────────────────────────────────────────────────────────────
    socket.on('disconnect', async (reason) => {
        console.log(`🔌 Socket disconnected: ${socket.id} (${reason})`);
        await db.closeSession(socket.id).catch(() => {});

        const devId = socketDeviceMap.get(socket.id);
        if (devId) {
            socketDeviceMap.delete(socket.id);
            // Mark offline after 30s grace period (they might reconnect)
            setTimeout(async () => {
                const isStillConnected = [...socketDeviceMap.values()].includes(devId);
                if (!isStillConnected) {
                    await db.setDeviceOffline(devId).catch(() => {});
                    io.emit('device-offline', { deviceId: devId });
                }
            }, 30_000);
        }
    });
});

// ══════════════════════════════════════════════════════════════════════════════
//  BACKGROUND TASKS
// ══════════════════════════════════════════════════════════════════════════════

// Broadcast live stats to all clients every 30 seconds
setInterval(async () => {
    try {
        const stats = await db.getStatistics();
        io.emit('stats-update', { ...stats, timestamp: Date.now() });
    } catch(err) { /* silent */ }
}, 30_000);

// Auto-prune detections older than 7 days (runs once at startup + daily)
async function scheduledPrune() {
    try {
        await db.pruneOldDetections(7);
    } catch(err) { console.error('Prune error:', err.message); }
}
scheduledPrune(); // Run on startup
setInterval(scheduledPrune, 24 * 60 * 60 * 1000); // Then daily

// ── Graceful Shutdown ──────────────────────────────────────────────────────────
function gracefulShutdown(signal) {
    console.log(`\n📴 ${signal} received — shutting down gracefully...`);
    server.close(() => {
        console.log('✅ HTTP server closed');
        db.close();
        process.exit(0);
    });
    setTimeout(() => {
        console.error('⚠  Forced shutdown after timeout');
        process.exit(1);
    }, 10_000);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('uncaughtException',  err => console.error('Uncaught exception:', err));
process.on('unhandledRejection', err => console.error('Unhandled rejection:', err));

// ── Start ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
    console.log('\n🚨 ══════════════════════════════════════════');
    console.log('🚨  RescueMesh Server  v2.0  STARTED');
    console.log('🚨 ══════════════════════════════════════════');
    console.log(`🌐  Website     → http://localhost:${PORT}`);
    console.log(`📊  Dashboard   → http://localhost:${PORT}/dashboard`);
    console.log(`❤️   Health     → http://localhost:${PORT}/health`);
    console.log(`📡  API Base    → http://localhost:${PORT}/api`);
    console.log('══════════════════════════════════════════\n');
    console.log('📋  API Endpoints:');
    console.log('    GET    /api/stats');
    console.log('    GET    /api/devices');
    console.log('    POST   /api/devices');
    console.log('    GET    /api/detections');
    console.log('    POST   /api/detections');
    console.log('    GET    /api/detections/critical');
    console.log('    GET    /api/detections/heatmap');
    console.log('    POST   /api/sos');
    console.log('    GET    /api/alerts');
    console.log('    POST   /api/messages');
    console.log('    POST   /api/admin/prune');
    console.log('══════════════════════════════════════════\n');
});
