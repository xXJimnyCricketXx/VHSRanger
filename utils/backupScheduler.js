const fs = require('fs');
const path = require('path');
const Item = require('../models/Item');
const User = require('../models/User');
const LoginLog = require('../models/LoginLog');
const Settings = require('../models/Settings');

/**
 * utils/backupScheduler.js
 *
 * Builds/restores full-database JSON backups (same shape as the manual
 * export/import) and, additionally, writes timed snapshots to disk on a
 * schedule read from Settings.backupSchedule, pruning down to the
 * configured retention count.
 */

const BACKUP_DIR = path.join(__dirname, '..', 'backups');
const FILENAME_RE = /^vhsranger_backup_[\d-]+T[\d-]+\.json$/;

function ensureDir() {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function isSafeFilename(name) {
    return typeof name === 'string' && FILENAME_RE.test(name);
}

async function buildBackupData() {
    return {
        users: await User.find({}).lean(),
        albums: await Item.find({}).lean(),
        logs: await LoginLog.find({}).lean(),
        settings: await Settings.findOne().lean(),
        metadata: { version: '2.0.0', date: new Date() }
    };
}

async function restoreFromData(data) {
    if (!data || (!data.users && !data.albums)) {
        throw new Error('Backup file missing required fields');
    }

    await Promise.all([
        LoginLog.deleteMany({}),
        Item.deleteMany({}),
        User.deleteMany({}),
        Settings.deleteMany({})
    ]);

    if (data.users && data.users.length > 0) await User.insertMany(data.users);

    if (data.albums && data.albums.length > 0) {
        const cleanAlbums = data.albums.map(a => a.kind ? a : { ...a, kind: 'Music' });
        await Item.insertMany(cleanAlbums);
    }

    if (data.logs && data.logs.length > 0) await LoginLog.insertMany(data.logs);

    if (data.settings) await Settings.create(data.settings);
    else await Settings.create({});
}

async function createBackup() {
    ensureDir();
    const data = await buildBackupData();
    const stamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];
    const fileName = `vhsranger_backup_${stamp}.json`;
    fs.writeFileSync(path.join(BACKUP_DIR, fileName), JSON.stringify(data, null, 2));
    return fileName;
}

function listBackups() {
    ensureDir();
    return fs.readdirSync(BACKUP_DIR)
        .filter(isSafeFilename)
        .map(name => {
            const stat = fs.statSync(path.join(BACKUP_DIR, name));
            return { name, size: stat.size, createdAt: stat.mtime };
        })
        .sort((a, b) => b.createdAt - a.createdAt);
}

function readBackup(fileName) {
    if (!isSafeFilename(fileName)) throw new Error('Invalid filename');
    const filePath = path.join(BACKUP_DIR, fileName);
    if (!fs.existsSync(filePath)) throw new Error('Backup not found');
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function deleteBackup(fileName) {
    if (!isSafeFilename(fileName)) throw new Error('Invalid filename');
    const filePath = path.join(BACKUP_DIR, fileName);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

async function pruneOldBackups(retention) {
    const excess = listBackups().slice(Math.max(1, retention));
    for (const f of excess) {
        try { fs.unlinkSync(path.join(BACKUP_DIR, f.name)); } catch (e) { /* already gone */ }
    }
}

// Checked once a minute. Fires when the clock hits the configured time-of-day
// and at least `intervalDays` have passed since the last run (tracked in
// Settings so it survives restarts). No external cron dependency needed for
// a once-a-day-at-most schedule.
let schedulerInterval = null;
function startScheduler() {
    if (schedulerInterval) return;
    schedulerInterval = setInterval(async () => {
        try {
            const settings = await Settings.findOne().lean();
            const schedule = settings && settings.backupSchedule;
            if (!schedule || !schedule.enabled) return;

            const now = new Date();
            const [h, m] = (schedule.time || '03:00').split(':').map(Number);
            if (now.getHours() !== h || now.getMinutes() !== m) return;

            const intervalDays = schedule.intervalDays || 1;
            const lastRun = schedule.lastRunAt ? new Date(schedule.lastRunAt) : null;
            const daysSince = lastRun ? (now - lastRun) / (1000 * 60 * 60 * 24) : Infinity;
            if (daysSince < intervalDays) return;

            await createBackup();
            await pruneOldBackups(schedule.retention || 3);
            await Settings.updateOne({}, { $set: { 'backupSchedule.lastRunAt': now } });
            console.log('[Backup] Scheduled backup created');
        } catch (err) {
            console.error('[Backup] Scheduler error:', err.message);
        }
    }, 60 * 1000);
}

module.exports = {
    BACKUP_DIR,
    buildBackupData,
    restoreFromData,
    createBackup,
    listBackups,
    readBackup,
    deleteBackup,
    pruneOldBackups,
    startScheduler
};
