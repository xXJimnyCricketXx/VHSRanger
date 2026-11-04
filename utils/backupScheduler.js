const fs = require('fs');
const path = require('path');
const Item = require('../models/Item');
const User = require('../models/User');
const LoginLog = require('../models/LoginLog');
const Settings = require('../models/Settings');
const { parseTmdbId } = require('./tmdbId');

/**
 * utils/backupScheduler.js
 *
 * Builds/restores full-database JSON backups (same shape as the manual
 * export/import) and, additionally, writes timed snapshots to disk on a
 * schedule read from Settings.backupSchedule, pruning down to the
 * configured retention count.
 *
 * A restore first checks the whole backup and writes a safety copy of the
 * current data. Safety copies do not count towards the retention.
 */

const BACKUP_DIR = path.join(__dirname, '..', 'backups');
const FILENAME_RE = /^vhsranger_(backup|before_restore)_[\d-]+T[\d-]+\.json$/;
const BACKUP_PREFIX = 'vhsranger_backup_';
const SAFETY_PREFIX = 'vhsranger_before_restore_';
const SAFETY_COPIES_KEPT = 3;

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

function restoreError(message, status) {
    return Object.assign(new Error(message), { status });
}

/**
 * @returns {Error|null} The validation error of a document, null if it is valid.
 */
function findInvalid(Model, doc) {
    try {
        return new Model(doc).validateSync() || null;
    } catch (err) {
        return err;
    }
}

function assertValid(Model, doc, label) {
    const error = findInvalid(Model, doc);
    if (error) {
        const fields = Object.keys(error.errors || {}).join(', ');
        throw restoreError(`Backup contains an invalid entry in ${label}${fields ? `: ${fields}` : ''}`, 400);
    }
}

/**
 * Items from old backups may lack `kind`, and their TMDb ID may be stored as text.
 */
function normalizeItem(item) {
    if (!item || typeof item !== 'object') return item;
    const clean = { ...item, kind: item.kind || 'VHS' };
    if (clean.tmdb_id !== undefined) {
        const id = parseTmdbId(clean.tmdb_id);
        if (id) clean.tmdb_id = id;
        else delete clean.tmdb_id;
    }
    return clean;
}

/**
 * Checks a whole backup without touching the database.
 *
 * @param {object} data Parsed backup file.
 * @returns {{users: object[], albums: object[], logs: object[], settings: object}}
 * @throws {Error} With status 400 if the backup cannot be restored completely.
 */
function prepareRestore(data) {
    if (!data || !Array.isArray(data.users)) {
        throw restoreError('Backup file missing required fields', 400);
    }
    for (const key of ['albums', 'logs']) {
        if (data[key] !== undefined && !Array.isArray(data[key])) {
            throw restoreError('Backup file missing required fields', 400);
        }
    }
    // Without an admin nobody could log in afterwards, and the items would
    // belong to an account that no longer exists.
    if (!data.users.some((user) => user && user.isAdmin === true)) {
        throw restoreError('Backup file contains no admin account', 400);
    }

    const albums = (data.albums || []).map(normalizeItem);
    const settings = data.settings || {};

    data.users.forEach((user) => assertValid(User, user, 'users'));
    albums.forEach((album) => assertValid(Item, album, 'albums'));
    assertValid(Settings, settings, 'settings');

    // A damaged log entry is no reason to refuse the collection.
    const logs = (data.logs || []).filter((log) => !findInvalid(LoginLog, log));
    const skipped = (data.logs || []).length - logs.length;
    if (skipped > 0) console.warn(`[Backup] Restore skips ${skipped} invalid log entries`);

    return { users: data.users, albums, logs, settings };
}

async function wipeData() {
    await Promise.all([
        LoginLog.deleteMany({}),
        Item.deleteMany({}),
        User.deleteMany({}),
        Settings.deleteMany({})
    ]);
}

/**
 * Puts a snapshot from buildBackupData() back unchanged. Uses the raw driver,
 * so Mongoose cannot drop or reject anything that was already in the database.
 */
async function putBack(snapshot) {
    await wipeData();
    if (snapshot.users.length > 0) await User.collection.insertMany(snapshot.users);
    if (snapshot.albums.length > 0) await Item.collection.insertMany(snapshot.albums);
    if (snapshot.logs.length > 0) await LoginLog.collection.insertMany(snapshot.logs);
    if (snapshot.settings) await Settings.collection.insertOne(snapshot.settings);
}

/**
 * Replaces all data with a backup. The current data survives any failure: it
 * is written to a safety copy first and put back if the restore fails midway.
 *
 * @param {object} data Parsed backup file.
 * @returns {Promise<string|null>} Name of the safety copy, null if there was no data to keep.
 * @throws {Error} With `status` set and a message that is safe to show.
 */
async function restoreFromData(data) {
    const prepared = prepareRestore(data);
    const previous = await buildBackupData();

    let safetyCopy = null;
    if (previous.users.length > 0 || previous.albums.length > 0) {
        try {
            safetyCopy = writeBackupFile(previous, SAFETY_PREFIX);
        } catch (err) {
            console.error('[Backup] Safety copy failed:', err);
            throw restoreError('Could not write a safety copy. Nothing was changed.', 500);
        }
    }

    try {
        await wipeData();
        await User.insertMany(prepared.users);
        if (prepared.albums.length > 0) await Item.insertMany(prepared.albums);
        if (prepared.logs.length > 0) await LoginLog.insertMany(prepared.logs);
        await Settings.create(prepared.settings);
    } catch (err) {
        console.error('[Backup] Restore failed:', err);
        try {
            await putBack(previous);
        } catch (putBackErr) {
            console.error('[Backup] Could not put the previous data back:', putBackErr);
            throw restoreError(`Restore failed and the previous data could not be put back. Your data is in the safety copy ${safetyCopy}.`, 500);
        }
        throw restoreError('Restore failed. The previous data was put back.', 500);
    }

    pruneSafetyCopies();
    return safetyCopy;
}

function writeBackupFile(data, prefix) {
    ensureDir();
    const stamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];
    const fileName = `${prefix}${stamp}.json`;
    fs.writeFileSync(path.join(BACKUP_DIR, fileName), JSON.stringify(data, null, 2));
    return fileName;
}

async function createBackup() {
    return writeBackupFile(await buildBackupData(), BACKUP_PREFIX);
}

function removeFiles(files) {
    for (const f of files) {
        try { fs.unlinkSync(path.join(BACKUP_DIR, f.name)); } catch (e) { /* already gone */ }
    }
}

function pruneSafetyCopies() {
    const copies = listBackups().filter((f) => f.name.startsWith(SAFETY_PREFIX));
    removeFiles(copies.slice(SAFETY_COPIES_KEPT));
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
    const backups = listBackups().filter((f) => f.name.startsWith(BACKUP_PREFIX));
    removeFiles(backups.slice(Math.max(1, retention)));
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
