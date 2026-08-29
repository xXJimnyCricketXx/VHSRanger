const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Settings = require('../models/Settings');
const { requireAuth, requireAdmin } = require('../middleware/authMiddleware');
const {
    buildBackupData,
    restoreFromData,
    createBackup,
    listBackups,
    readBackup,
    deleteBackup,
    pruneOldBackups
} = require('../utils/backupScheduler');

/**
 * routes/backupRoutes.js
 *
 * Backup and restore endpoints for the application data.
 *
 * - GET /export:               Streams a full JSON backup for manual download.
 * - POST /import:               Restores the database from an uploaded JSON backup.
 * - POST /schedule:             Saves the automated backup schedule settings.
 * - POST /backups/:file/restore: Restores from a scheduled backup stored on disk.
 * - DELETE /backups/:file:      Deletes a scheduled backup stored on disk.
 */

router.get('/export', requireAuth, requireAdmin, async (req, res) => {
    try {
        const data = await buildBackupData();
        const fileName = `vhsranger_backup_${new Date().toISOString().split('T')[0]}.json`;
        res.setHeader('Content-disposition', 'attachment; filename=' + fileName);
        res.setHeader('Content-type', 'application/json');
        res.send(JSON.stringify(data, null, 2));
    } catch (err) {
        console.error(err);
        res.status(500).send("Export failed");
    }
});

router.post('/import', async (req, res) => {
    try {
        const userCount = await User.countDocuments();

        if (userCount > 0) {
            const currentUser = res.locals.user;
            if (!currentUser || !currentUser.isAdmin) {
                console.warn(`[SECURITY] import unauthorized : ${req.ip}`);
                return res.status(403).json({ error: "Import unauthorized." });
            }
        }

        let data = req.body;
        if (data.backupData) {
            try {
                data = typeof data.backupData === 'string' ? JSON.parse(data.backupData) : data.backupData;
            } catch (e) {
                return res.status(400).json({ error: "Invalid JSON format" });
            }
        }

        await restoreFromData(data);
        res.cookie('jwt', '', { maxAge: 1 });
        res.status(200).json({ success: true, message: "Import successful" });
    } catch (err) {
        console.error("[ERR] Import :", err);
        res.status(err.message === 'Backup file missing required fields' ? 400 : 500).json({ error: err.message });
    }
});

// Save the automated backup schedule (time, interval, retention).
router.post('/schedule', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { enabled, time, intervalDays, retention } = req.body;
        await Settings.findOneAndUpdate({}, {
            $set: {
                'backupSchedule.enabled': enabled === 'on' || enabled === true,
                'backupSchedule.time': /^\d{2}:\d{2}$/.test(time) ? time : '03:00',
                'backupSchedule.intervalDays': Math.max(1, parseInt(intervalDays) || 1),
                'backupSchedule.retention': Math.max(1, Math.min(30, parseInt(retention) || 3))
            }
        }, { upsert: true });
        res.redirect('/admin?msg=backup_schedule_saved');
    } catch (err) {
        console.error('[ERR] backup schedule save', err);
        res.redirect('/admin?msg=error');
    }
});

// Trigger an on-demand scheduled-style backup (written to disk, subject to retention).
router.post('/backups/create', requireAuth, requireAdmin, async (req, res) => {
    try {
        const settings = await Settings.findOne().lean();
        await createBackup();
        await pruneOldBackups((settings && settings.backupSchedule && settings.backupSchedule.retention) || 3);
        res.json({ success: true, backups: listBackups() });
    } catch (err) {
        console.error('[ERR] manual scheduled backup', err);
        res.status(500).json({ error: err.message });
    }
});

router.post('/backups/:filename/restore', requireAuth, requireAdmin, async (req, res) => {
    try {
        const data = readBackup(req.params.filename);
        await restoreFromData(data);
        res.cookie('jwt', '', { maxAge: 1 });
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

router.delete('/backups/:filename', requireAuth, requireAdmin, async (req, res) => {
    try {
        deleteBackup(req.params.filename);
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

module.exports = router;
