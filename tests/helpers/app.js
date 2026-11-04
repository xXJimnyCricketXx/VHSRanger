// Starts the real app as its own process and offers small helpers to talk to it.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const PORT = 3199;
const BASE = `http://127.0.0.1:${PORT}`;
const MONGODB_URL = process.env.TEST_MONGODB_URL || 'mongodb://127.0.0.1:27017/vhsranger_test';

// The tests wipe this database, so never run them against anything else.
if (new URL(MONGODB_URL).pathname !== '/vhsranger_test') {
    throw new Error('TEST_MONGODB_URL must point to a database named vhsranger_test');
}

const BACKUP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vhsranger-test-'));

function startApp(env = {}) {
    const child = spawn(process.execPath, ['-r', path.join(__dirname, 'mock-external.js'), 'app.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            NODE_ENV: 'production',
            MONGODB_URL,
            PASSJWT: 'test-signing-secret',
            VHS_PORT: String(PORT),
            PROD: 'false',
            BASE_URL: '',
            TMDB_API_KEY: 'test-key',
            BACKUP_DIR,
            ...env
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.output = '';
    child.stdout.on('data', (chunk) => { child.output += chunk; });
    child.stderr.on('data', (chunk) => { child.output += chunk; });
    return child;
}

const stopApp = (child) => new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill();
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function request(url, { base = BASE, cookie, json, form, headers = {}, method, body } = {}) {
    const allHeaders = { 'accept-language': 'en', ...headers };
    if (cookie) allHeaders.cookie = cookie;
    if (json !== undefined) {
        allHeaders['content-type'] = 'application/json';
        body = JSON.stringify(json);
    }
    if (form) {
        allHeaders['content-type'] = 'application/x-www-form-urlencoded';
        body = new URLSearchParams(form).toString();
    }
    return fetch(base + url, { method: method || (body ? 'POST' : 'GET'), headers: allHeaders, body, redirect: 'manual' });
}

async function waitForStatus(url, status, { base = BASE, timeoutMs = 30000 } = {}) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        try {
            if ((await request(url, { base })).status === status) return true;
        } catch (err) {
            // Not listening yet
        }
        await sleep(200);
    }
    return false;
}

const jwtCookie = (response) => (response.headers.getSetCookie()
    .find((c) => c.startsWith('jwt=') && !c.startsWith('jwt=;')) || '').split(';')[0];

module.exports = { BACKUP_DIR, BASE, MONGODB_URL, ROOT, startApp, stopApp, sleep, request, waitForStatus, jwtCookie };
