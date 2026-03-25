/**
 * ═══════════════════════════════════════════════════
 *  RescueMesh — Database Layer (SQLite3)
 *  Handles: devices, detections, messages, alerts, sessions
 * ═══════════════════════════════════════════════════
 */

const sqlite3 = require('sqlite3').verbose();
const path    = require('path');
const crypto  = require('crypto');

class Database {
    constructor() {
        this.db    = null;
        this.ready = false;
        this._connect();
    }

    // ─── Connection ────────────────────────────────────────────────────────────
    _connect() {
        const dbPath = path.join(__dirname, 'rescuemesh.db');
        this.db = new sqlite3.Database(dbPath, (err) => {
            if (err) {
                console.error('❌ DB connection error:', err.message);
                return;
            }
            console.log('✅ SQLite connected →', dbPath);
            this._configure();
            this._createTables();
        });
    }

    _configure() {
        // Performance settings
        this.db.run('PRAGMA journal_mode = WAL');
        this.db.run('PRAGMA synchronous  = NORMAL');
        this.db.run('PRAGMA foreign_keys = ON');
        this.db.run('PRAGMA cache_size   = -20000'); // 20MB cache
    }

    // ─── Schema ────────────────────────────────────────────────────────────────
    _createTables() {
        this.db.serialize(() => {

            // ── Devices ──────────────────────────────────────────────────────
            this.db.run(`
                CREATE TABLE IF NOT EXISTS devices (
                    id            TEXT    PRIMARY KEY,
                    name          TEXT    DEFAULT 'Unknown Device',
                    conn_type     TEXT    DEFAULT 'unknown',
                    user_id       TEXT,
                    location_lat  REAL    DEFAULT 0,
                    location_lng  REAL    DEFAULT 0,
                    accuracy      REAL    DEFAULT 0,
                    battery_level INTEGER DEFAULT 100,
                    status        TEXT    DEFAULT 'active',
                    last_seen     INTEGER NOT NULL DEFAULT 0,
                    created_at    INTEGER NOT NULL DEFAULT 0
                )
            `, err => { if (err) console.error('devices table:', err.message); });

            // ── Detections ───────────────────────────────────────────────────
            this.db.run(`
                CREATE TABLE IF NOT EXISTS detections (
                    id           TEXT    PRIMARY KEY,
                    device_id    TEXT    NOT NULL,
                    type         TEXT    NOT NULL,
                    confidence   REAL    NOT NULL DEFAULT 0,
                    location_lat REAL    DEFAULT 0,
                    location_lng REAL    DEFAULT 0,
                    evidence     TEXT    DEFAULT '{}',
                    priority     TEXT    DEFAULT 'normal',
                    acknowledged INTEGER DEFAULT 0,
                    ack_by       TEXT,
                    ack_at       INTEGER,
                    created_at   INTEGER NOT NULL DEFAULT 0
                )
            `, err => { if (err) console.error('detections table:', err.message); });

            // ── Messages ─────────────────────────────────────────────────────
            this.db.run(`
                CREATE TABLE IF NOT EXISTS messages (
                    id           TEXT    PRIMARY KEY,
                    from_device  TEXT    NOT NULL,
                    to_device    TEXT,
                    content      TEXT    DEFAULT '{}',
                    type         TEXT    DEFAULT 'message',
                    priority     INTEGER DEFAULT 5,
                    delivered    INTEGER DEFAULT 0,
                    created_at   INTEGER NOT NULL DEFAULT 0,
                    delivered_at INTEGER
                )
            `, err => { if (err) console.error('messages table:', err.message); });

            // ── Alerts ───────────────────────────────────────────────────────
            this.db.run(`
                CREATE TABLE IF NOT EXISTS alerts (
                    id           TEXT    PRIMARY KEY,
                    detection_id TEXT,
                    device_id    TEXT,
                    severity     TEXT    DEFAULT 'high',
                    message      TEXT,
                    broadcast_to TEXT    DEFAULT 'all',
                    status       TEXT    DEFAULT 'active',
                    created_at   INTEGER NOT NULL DEFAULT 0,
                    resolved_at  INTEGER
                )
            `, err => { if (err) console.error('alerts table:', err.message); });

            // ── Sessions ─────────────────────────────────────────────────────
            this.db.run(`
                CREATE TABLE IF NOT EXISTS sessions (
                    id           TEXT    PRIMARY KEY,
                    socket_id    TEXT,
                    device_id    TEXT,
                    connected_at INTEGER NOT NULL DEFAULT 0,
                    disconnected_at INTEGER
                )
            `, err => { if (err) console.error('sessions table:', err.message); });

            // ── Indexes ──────────────────────────────────────────────────────
            const indexes = [
                'CREATE INDEX IF NOT EXISTS idx_det_device    ON detections(device_id)',
                'CREATE INDEX IF NOT EXISTS idx_det_created   ON detections(created_at DESC)',
                'CREATE INDEX IF NOT EXISTS idx_det_conf      ON detections(confidence DESC)',
                'CREATE INDEX IF NOT EXISTS idx_det_priority  ON detections(priority)',
                'CREATE INDEX IF NOT EXISTS idx_det_type      ON detections(type)',
                'CREATE INDEX IF NOT EXISTS idx_dev_seen      ON devices(last_seen DESC)',
                'CREATE INDEX IF NOT EXISTS idx_dev_status    ON devices(status)',
                'CREATE INDEX IF NOT EXISTS idx_msg_todev     ON messages(to_device, delivered)',
                'CREATE INDEX IF NOT EXISTS idx_alert_status  ON alerts(status)',
            ];
            indexes.forEach(sql => this.db.run(sql, err => {
                if (err && !err.message.includes('already exists'))
                    console.error('Index error:', err.message);
            }));

            this.ready = true;
            console.log('✅ DB schema ready');
        });
    }

    // ─── Utility ───────────────────────────────────────────────────────────────
    _run(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.run(sql, params, function(err) {
                if (err) reject(err);
                else resolve({ lastID: this.lastID, changes: this.changes });
            });
        });
    }

    _get(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.get(sql, params, (err, row) => {
                if (err) reject(err); else resolve(row || null);
            });
        });
    }

    _all(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (err, rows) => {
                if (err) reject(err); else resolve(rows || []);
            });
        });
    }

    _uid() { return crypto.randomUUID(); }
    _now() { return Date.now(); }

    _parseEvidence(row) {
        if (!row) return row;
        try { row.evidence = JSON.parse(row.evidence); } catch(_) { row.evidence = {}; }
        row.location = { lat: row.location_lat || 0, lng: row.location_lng || 0 };
        return row;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  DEVICES
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Register or update a device
     */
    async registerDevice(deviceId, name, connType, location, batteryLevel = 100) {
        const now = this._now();
        const loc = location || { lat: 0, lng: 0, accuracy: 0 };

        await this._run(`
            INSERT INTO devices (id, name, conn_type, location_lat, location_lng, accuracy, battery_level, status, last_seen, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name          = COALESCE(excluded.name, name),
                conn_type     = COALESCE(excluded.conn_type, conn_type),
                location_lat  = excluded.location_lat,
                location_lng  = excluded.location_lng,
                accuracy      = excluded.accuracy,
                battery_level = excluded.battery_level,
                status        = 'active',
                last_seen     = excluded.last_seen
        `, [
            deviceId,
            name || 'Unknown Device',
            connType || 'unknown',
            loc.lat || 0,
            loc.lng || 0,
            loc.accuracy || 0,
            batteryLevel,
            now,
            now
        ]);

        return deviceId;
    }

    /**
     * Update device location only
     */
    async updateDeviceLocation(deviceId, location) {
        return this._run(
            `UPDATE devices SET location_lat=?, location_lng=?, accuracy=?, last_seen=? WHERE id=?`,
            [location.lat, location.lng, location.accuracy || 0, this._now(), deviceId]
        );
    }

    /**
     * Mark device as disconnected
     */
    async setDeviceOffline(deviceId) {
        return this._run(
            `UPDATE devices SET status='offline', last_seen=? WHERE id=?`,
            [this._now(), deviceId]
        );
    }

    /**
     * Get all devices active within the last N milliseconds (default 10 min)
     */
    async getActiveDevices(maxAgeMs = 10 * 60 * 1000) {
        const since = this._now() - maxAgeMs;
        return this._all(
            `SELECT * FROM devices WHERE last_seen > ? ORDER BY last_seen DESC`,
            [since]
        );
    }

    /**
     * Get a single device by ID
     */
    async getDevice(deviceId) {
        return this._get(`SELECT * FROM devices WHERE id = ?`, [deviceId]);
    }

    /**
     * Get all devices (no time limit)
     */
    async getAllDevices() {
        return this._all(`SELECT * FROM devices ORDER BY last_seen DESC`);
    }

    /**
     * Delete a device and all its detections
     */
    async deleteDevice(deviceId) {
        await this._run(`DELETE FROM detections WHERE device_id = ?`, [deviceId]);
        return this._run(`DELETE FROM devices WHERE id = ?`, [deviceId]);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  DETECTIONS
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Save a detection to the database
     */
    async saveDetection(det) {
        const id  = this._uid();
        const now = this._now();
        const priority = det.confidence >= 0.9 ? 'critical' :
                         det.confidence >= 0.7 ? 'high' :
                         det.confidence >= 0.5 ? 'medium' : 'low';

        await this._run(`
            INSERT INTO detections
              (id, device_id, type, confidence, location_lat, location_lng, evidence, priority, acknowledged, created_at)
            VALUES (?,?,?,?,?,?,?,?,0,?)
        `, [
            id,
            det.deviceId || det.device_id || 'unknown',
            (det.type || 'unknown').toUpperCase(),
            Math.min(1, Math.max(0, det.confidence || 0)),
            det.location?.lat || 0,
            det.location?.lng || 0,
            JSON.stringify(det.evidence || {}),
            priority,
            det.timestamp || now
        ]);

        // Also update device last_seen
        if (det.deviceId || det.device_id) {
            await this._run(
                `UPDATE devices SET last_seen=? WHERE id=?`,
                [now, det.deviceId || det.device_id]
            );
        }

        return id;
    }

    /**
     * Get recent detections (newest first)
     * @param {number} limit
     * @param {number} offset
     * @param {number} minConfidence  0–1
     * @param {string} type           optional filter
     * @param {string} deviceId       optional filter
     */
    async getDetections({ limit = 100, offset = 0, minConfidence = 0, type = null, deviceId = null } = {}) {
        const conditions = ['confidence >= ?'];
        const params     = [minConfidence];

        if (type)     { conditions.push('type = ?');      params.push(type.toUpperCase()); }
        if (deviceId) { conditions.push('device_id = ?'); params.push(deviceId); }

        params.push(limit, offset);

        const rows = await this._all(`
            SELECT * FROM detections
            WHERE ${conditions.join(' AND ')}
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
        `, params);

        return rows.map(r => this._parseEvidence(r));
    }

    /**
     * Shorthand: get recent N detections
     */
    async getRecentDetections(limit = 100) {
        return this.getDetections({ limit });
    }

    /**
     * Get all detections for a specific device
     */
    async getDetectionsForDevice(deviceId, limit = 50) {
        return this.getDetections({ deviceId, limit });
    }

    /**
     * Get only critical / high-confidence detections
     */
    async getCriticalDetections(limit = 50) {
        return this.getDetections({ limit, minConfidence: 0.9 });
    }

    /**
     * Acknowledge a detection (mark as seen by a team member)
     */
    async acknowledgeDetection(detectionId, acknowledgedBy) {
        return this._run(
            `UPDATE detections SET acknowledged=1, ack_by=?, ack_at=? WHERE id=?`,
            [acknowledgedBy || 'unknown', this._now(), detectionId]
        );
    }

    /**
     * Delete detections older than N days
     */
    async pruneOldDetections(days = 7) {
        const cutoff = this._now() - days * 24 * 3600 * 1000;
        const result = await this._run(
            `DELETE FROM detections WHERE created_at < ?`,
            [cutoff]
        );
        console.log(`🗑  Pruned ${result.changes} detections older than ${days} days`);
        return result.changes;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  ALERTS
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Create an alert (usually triggered by high-confidence detection)
     */
    async createAlert({ detectionId, deviceId, severity, message }) {
        const id = this._uid();
        await this._run(`
            INSERT INTO alerts (id, detection_id, device_id, severity, message, status, created_at)
            VALUES (?,?,?,?,?,'active',?)
        `, [id, detectionId || null, deviceId || null, severity || 'high', message || '', this._now()]);
        return id;
    }

    /**
     * Get active (unresolved) alerts
     */
    async getActiveAlerts() {
        return this._all(
            `SELECT * FROM alerts WHERE status='active' ORDER BY created_at DESC`
        );
    }

    /**
     * Resolve an alert
     */
    async resolveAlert(alertId) {
        return this._run(
            `UPDATE alerts SET status='resolved', resolved_at=? WHERE id=?`,
            [this._now(), alertId]
        );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  MESSAGES
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Queue a message for store-and-forward delivery
     */
    async queueMessage({ fromDevice, toDevice, content, type, priority = 5 }) {
        const id = this._uid();
        await this._run(`
            INSERT INTO messages (id, from_device, to_device, content, type, priority, delivered, created_at)
            VALUES (?,?,?,?,?,?,0,?)
        `, [id, fromDevice, toDevice || null, JSON.stringify(content || {}), type || 'message', priority, this._now()]);
        return id;
    }

    /**
     * Get undelivered messages for a device
     */
    async getPendingMessages(deviceId, limit = 50) {
        const rows = await this._all(`
            SELECT * FROM messages
            WHERE (to_device = ? OR to_device IS NULL)
              AND delivered = 0
            ORDER BY priority DESC, created_at ASC
            LIMIT ?
        `, [deviceId, limit]);

        return rows.map(r => {
            try { r.content = JSON.parse(r.content); } catch(_) { r.content = {}; }
            return r;
        });
    }

    /**
     * Mark a message as delivered
     */
    async markDelivered(messageId) {
        return this._run(
            `UPDATE messages SET delivered=1, delivered_at=? WHERE id=?`,
            [this._now(), messageId]
        );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  SESSIONS
    // ═══════════════════════════════════════════════════════════════════════════

    async createSession(socketId, deviceId) {
        const id = this._uid();
        await this._run(`
            INSERT INTO sessions (id, socket_id, device_id, connected_at)
            VALUES (?,?,?,?)
        `, [id, socketId, deviceId || null, this._now()]);
        return id;
    }

    async closeSession(socketId) {
        return this._run(
            `UPDATE sessions SET disconnected_at=? WHERE socket_id=? AND disconnected_at IS NULL`,
            [this._now(), socketId]
        );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  STATISTICS
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Full dashboard statistics snapshot
     */
    async getStatistics() {
        const now         = this._now();
        const oneHourAgo  = now - 3_600_000;
        const fiveMinsAgo = now - 300_000;
        const oneDayAgo   = now - 86_400_000;

        const row = await this._get(`
            SELECT
                (SELECT COUNT(*) FROM devices    WHERE last_seen > ?)                             AS active_devices,
                (SELECT COUNT(*) FROM devices)                                                    AS total_devices,
                (SELECT COUNT(*) FROM detections WHERE created_at > ?)                           AS detections_last_hour,
                (SELECT COUNT(*) FROM detections WHERE created_at > ?)                           AS detections_last_day,
                (SELECT COUNT(*) FROM detections)                                                 AS total_detections,
                (SELECT COUNT(*) FROM detections WHERE priority='critical' AND created_at > ?)   AS critical_last_hour,
                (SELECT COUNT(*) FROM detections WHERE priority='critical')                       AS total_critical,
                (SELECT COALESCE(AVG(confidence),0) FROM detections WHERE created_at > ?)        AS avg_confidence,
                (SELECT COUNT(*) FROM messages   WHERE delivered=0)                              AS pending_messages,
                (SELECT COUNT(*) FROM alerts     WHERE status='active')                          AS active_alerts,
                (SELECT COUNT(*) FROM sessions   WHERE disconnected_at IS NULL)                  AS live_sessions
        `, [fiveMinsAgo, oneHourAgo, oneDayAgo, oneHourAgo, oneHourAgo]);

        return row || {};
    }

    /**
     * Breakdown of detections by type (last 24h)
     */
    async getDetectionsByType() {
        return this._all(`
            SELECT type, COUNT(*) as count, ROUND(AVG(confidence),3) as avg_conf
            FROM detections
            WHERE created_at > ?
            GROUP BY type
            ORDER BY count DESC
        `, [this._now() - 86_400_000]);
    }

    /**
     * Top N most active devices (by detection count, last 24h)
     */
    async getMostActiveDevices(limit = 10) {
        return this._all(`
            SELECT d.id, d.name, d.conn_type, COUNT(det.id) as detection_count,
                   MAX(det.created_at) as last_detection
            FROM devices d
            LEFT JOIN detections det ON det.device_id = d.id AND det.created_at > ?
            GROUP BY d.id
            ORDER BY detection_count DESC
            LIMIT ?
        `, [this._now() - 86_400_000, limit]);
    }

    /**
     * Detection heatmap data (lat/lng/confidence for last N detections)
     */
    async getHeatmapData(limit = 200) {
        return this._all(`
            SELECT location_lat as lat, location_lng as lng, confidence
            FROM detections
            WHERE location_lat != 0 AND location_lng != 0
            ORDER BY created_at DESC
            LIMIT ?
        `, [limit]);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  MAINTENANCE
    // ═══════════════════════════════════════════════════════════════════════════

    async vacuum() {
        return this._run('VACUUM');
    }

    async getDbSize() {
        const row = await this._get('SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()');
        return row?.size || 0;
    }

    close() {
        if (this.db) {
            this.db.close(err => {
                if (err) console.error('DB close error:', err.message);
                else console.log('✅ Database closed cleanly');
            });
        }
    }
}

// Export singleton
module.exports = new Database();
