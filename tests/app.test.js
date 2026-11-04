// End-to-end tests against the running app and a real MongoDB. The tests build on
// each other and run in file order; login throttling comes last on purpose.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const mongoose = require('mongoose');
const { io } = require('socket.io-client');
const {
    BACKUP_DIR, BASE, MONGODB_URL, ROOT,
    startApp, stopApp, sleep, request, waitForStatus, jwtCookie
} = require('./helpers/app');
const { isBackupDue } = require('../utils/backupScheduler');
const { parseTmdbId } = require('../utils/tmdbId');

const { MongoClient } = mongoose.mongo;

const OWNER = { email: 'owner@example.test', password: 'ownerpass1' };
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const LOCALES = ['en', 'de', 'fr', 'es', 'it'];

let app, client, albums, users;
let admin, reader, readerPassword;

const decode = (s) => s.replace(/&#39;/g, "'").replace(/&#34;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const login = async (email, password) => jwtCookie(await request('/login', { json: { email, password } }));
const save = (fields) => request('/save-vhs', { cookie: admin, form: { cast_json: '[]', ...fields } });
const byTitle = (title) => albums.find({ title }).toArray();
const safetyCopies = () => fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('vhsranger_before_restore_'));
const exportData = async () => (await request('/backup/export', { cookie: admin })).json();
const restart = async (env) => {
    await stopApp(app);
    app = startApp(env);
    assert.ok(await waitForStatus('/login', 200), app.output);
};

function inlineScriptErrors(html) {
    const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    const errors = [];
    for (const block of blocks) {
        try {
            new vm.Script(block);
        } catch (err) {
            errors.push(err.message);
        }
    }
    return errors;
}

before(async () => {
    client = await MongoClient.connect(MONGODB_URL);
    await client.db().dropDatabase();
    albums = client.db().collection('albums');
    users = client.db().collection('users');
    app = startApp();
    assert.ok(await waitForStatus('/login', 302) || await waitForStatus('/setup', 200), app.output);
});

after(async () => {
    await stopApp(app);
    await client.db().dropDatabase();
    await client.close();
    fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
});

// ---------- Start conditions

test('refuses to start without a login secret or with an example secret', async () => {
    for (const PASSJWT of ['', 'SomeComplexPassword', 'ChangeThisToAComplexPassword']) {
        const child = startApp({ PASSJWT, VHS_PORT: '3198' });
        const code = await new Promise((resolve) => child.once('exit', resolve));
        assert.equal(code, 1, `PASSJWT="${PASSJWT}"`);
        assert.match(child.output, /PASSJWT/);
    }
});

test('answers with a clear message while the database is unavailable', async () => {
    const child = startApp({ MONGODB_URL: 'mongodb://127.0.0.1:1/vhsranger_test', VHS_PORT: '3198' });
    try {
        const base = 'http://127.0.0.1:3198';
        assert.ok(await waitForStatus('/login', 503, { base }), child.output);
        const response = await request('/login', { base });
        assert.match(await response.text(), /database is currently unavailable/);
    } finally {
        await stopApp(child);
    }
});

// ---------- Setup and accounts

test('setup works with a regional browser language and logs in right away', async () => {
    const response = await request('/setup', {
        headers: { 'accept-language': 'de-DE,de;q=0.9' },
        form: { username: 'owner', ...OWNER }
    });
    assert.equal(response.status, 302);
    assert.equal((await users.findOne()).language, 'de');
    admin = jwtCookie(response);
    assert.equal((await request('/', { cookie: admin })).status, 200);
    await users.updateOne({}, { $set: { language: 'en', currency: 'EUR' } });
});

test('an unsupported browser language falls back to English', async () => {
    const response = await request('/login', { headers: { 'accept-language': 'ja' } });
    assert.match(await response.text(), /<html lang="en"/);
});

test('setup is locked once an admin exists', async () => {
    const response = await request('/setup', { form: { username: 'x', email: 'x@example.test', password: 'password1' } });
    assert.equal(await users.countDocuments(), 1);
    assert.equal(response.headers.get('location'), '/login');
});

test('new users get a read-only account in the language of the admin', async () => {
    const response = await request('/admin/add-user', { cookie: admin, form: { username: 'Ann <b>', email: 'ann@example.test' } });
    const html = await response.text();
    assert.ok(html.includes('Ann &lt;b&gt;') && !html.includes('&amp;lt;'), 'name is escaped exactly once');
    readerPassword = decode(html.match(/select-all break-all">([^<]+)<\/code>/)[1]);
    const stored = await users.findOne({ email: 'ann@example.test' });
    assert.match(stored.password, /^\$2[aby]\$/);
    assert.equal(stored.language, 'en');
    assert.equal(stored.isAdmin, false);
    reader = await login('ann@example.test', readerPassword);
    assert.ok(reader);
});

test('a duplicate user is reported as an error', async () => {
    const response = await request('/admin/add-user', { cookie: admin, form: { username: 'Ann <b>', email: 'ann2@example.test' } });
    assert.equal(response.headers.get('location'), '/admin?msg=user_create_error');
    const html = await (await request('/admin?msg=user_create_error', { cookie: admin })).text();
    assert.match(html, /role="status" class="bg-red-500/);
});

test('admin messages are whitelisted and translated', async () => {
    const page = async (msg) => (await request(`/admin?msg=${msg}`, { cookie: admin })).text();
    assert.match(await page('saved'), /Saved\./);
    assert.match(await page('error'), /Something went wrong\./);
    assert.match(await page('batch_barcode_success&count=4'), /4 /);
    for (const msg of ['nonsense', '__proto__', 'constructor']) {
        assert.ok(!(await page(msg)).includes('role="status"'), msg);
    }
});

test('readers cannot reach admin pages or change data', async () => {
    const routes = [
        ['GET', '/admin'], ['GET', '/backup/export'], ['GET', '/add-vhs'], ['GET', '/add-vhs/manual'],
        ['POST', '/save-vhs'], ['POST', '/admin/danger/wipe-collection'], ['POST', '/backup/backups/create']
    ];
    for (const [method, url] of routes) {
        const response = await request(url, { method, cookie: reader });
        assert.equal(response.status, 302, url);
        assert.equal(response.headers.get('location'), '/', url);
    }
});

test('pages require a login', async () => {
    for (const url of ['/', '/collection', '/wishlist', '/stats', '/print/collection', '/settings']) {
        assert.equal((await request(url)).headers.get('location'), '/login', url);
    }
});

test('a password change ends older sessions', async () => {
    const before = await login('ann@example.test', readerPassword);
    await sleep(1100);
    await users.updateOne({ email: 'ann@example.test' }, { $set: { lastChange: new Date() } });
    assert.equal((await request('/', { cookie: before })).headers.get('location'), '/login');
    reader = await login('ann@example.test', readerPassword);
});

test('avatars must be real images', async () => {
    const upload = (name, type, content) => {
        const form = new FormData();
        form.append('avatar', new Blob([content], { type }), name);
        return fetch(`${BASE}/settings/upload-avatar`, { method: 'POST', headers: { cookie: reader }, body: form, redirect: 'manual' });
    };
    assert.equal((await upload('evil.svg', 'image/png', '<svg onload="alert(1)"/>')).status, 400);
    let stored = await users.findOne({ email: 'ann@example.test' });
    assert.ok(!stored.img || !stored.img.includes('avatar-'), 'fake image is rejected');

    assert.equal((await upload('me.png', 'image/png', PNG)).status, 200);
    stored = await users.findOne({ email: 'ann@example.test' });
    assert.match(stored.img, /\.png$/);
    assert.equal((await request(stored.img)).status, 200);
    fs.rmSync(path.join(ROOT, 'public', stored.img), { force: true });
});

// ---------- Live updates

test('only admins can connect to live updates', async () => {
    const connect = (cookie) => new Promise((resolve) => {
        const socket = io(BASE, { reconnection: false, extraHeaders: cookie ? { cookie } : {} });
        socket.once('connect', () => { socket.close(); resolve(true); });
        socket.once('connect_error', () => { socket.close(); resolve(false); });
    });
    assert.equal(await connect(admin), true);
    assert.equal(await connect(reader), false);
    assert.equal(await connect(null), false);
});

// ---------- Tapes

const CAST = [{ name: "Peter O'Toole", character: 'T. E. "Lawrence"', photo: '' }, { name: 'Omar </script><b>Sharif', character: 'Ali', photo: '' }];
let lawrenceId;

test('editing a tape keeps a cast with special characters', async () => {
    await save({ title: 'Lawrence', tmdb_id: '947', cassette_number: '2', director: 'David Lean', cast_json: JSON.stringify(CAST) });
    const [tape] = await byTitle('Lawrence');
    lawrenceId = String(tape._id);
    assert.equal(tape.cast.length, 2);
    assert.equal(tape.tmdb_id, 947);

    const html = await (await request(`/vhs/edit/${lawrenceId}`, { cookie: admin })).text();
    const field = html.match(/<input type="hidden" name="cast_json" value="([^"]*)">/);
    assert.ok(field);
    assert.ok(!html.includes('<b>Sharif'));

    await save({ mongo_id: lawrenceId, title: 'Lawrence', tmdb_id: '947', cassette_number: '2', director: 'David Lean', cast_json: decode(field[1]) });
    const [edited] = await byTitle('Lawrence');
    assert.equal(edited.cast[0].name, "Peter O'Toole");
    assert.equal(edited.cast[0].character, 'T. E. "Lawrence"');
    assert.equal(edited.tmdb_id, 947, 'stays a number');
});

test('the confirmation page keeps a cast with special characters', async () => {
    const html = await (await request('/confirm-vhs/947', { cookie: admin })).text();
    const field = html.match(/<input type="hidden" name="cast_json" value="([^"]*)">/);
    assert.ok(field, html.slice(0, 200));
    assert.equal(JSON.parse(decode(field[1]))[0].name, "Peter O'Toole");
    assert.deepEqual(inlineScriptErrors(html), []);
});

test('an unreadable or missing cast does not delete the stored one', async () => {
    await save({ mongo_id: lawrenceId, title: 'Lawrence', tmdb_id: '947', cassette_number: '2', director: 'David Lean', cast_json: "[{'broken" });
    assert.equal((await byTitle('Lawrence'))[0].cast.length, 2);
    await request('/save-vhs', { cookie: admin, form: { mongo_id: lawrenceId, title: 'Lawrence', tmdb_id: '947', cassette_number: '2', director: 'David Lean' } });
    assert.equal((await byTitle('Lawrence'))[0].cast.length, 2);
});

test('a second copy never overwrites the first', async () => {
    await save({ title: 'Lawrence', tmdb_id: '947', cassette_number: '77' });
    const copies = await byTitle('Lawrence');
    assert.equal(copies.length, 2);
    assert.equal(copies.find((c) => c.cassette_number === '2').cast.length, 2);
});

test('an invalid TMDb ID does not stop saving', async () => {
    const response = await save({ title: 'NoId', tmdb_id: 'abc' });
    assert.equal(response.status, 302);
    assert.equal((await byTitle('NoId'))[0].tmdb_id, undefined);
    assert.equal(parseTmdbId(' 947 '), 947);
    assert.equal(parseTmdbId('0'), undefined);
    assert.equal(parseTmdbId('12a'), undefined);
});

test('the barcode batch reaches edited tapes', async () => {
    await save({ title: 'Bar', tmdb_id: '321' });
    const [bar] = await byTitle('Bar');
    await save({ mongo_id: String(bar._id), title: 'Bar', tmdb_id: '321' });
    await request('/admin/batch-update-barcodes', { cookie: admin, form: { barcodeList: '321:4000000000001' } });
    assert.equal((await byTitle('Bar'))[0].barcode, '4000000000001');
});

test('the migration repairs TMDb IDs stored as text', async () => {
    const owner = (await users.findOne({ isAdmin: true }))._id;
    await albums.insertMany([
        { title: 'OldText', kind: 'VHS', owner, tmdb_id: '555', added_at: new Date() },
        { title: 'OldJunk', kind: 'VHS', owner, tmdb_id: 'abc', added_at: new Date() }
    ]);
    await restart();
    assert.equal((await byTitle('OldText'))[0].tmdb_id, 555);
    assert.equal((await byTitle('OldJunk'))[0].tmdb_id, undefined);
    await albums.deleteMany({ title: { $in: ['OldText', 'OldJunk'] } });
});

test('the duplicate check finds matches', async () => {
    const check = async (query) => (await request(`/api/check-duplicate?${new URLSearchParams(query)}`, { cookie: admin })).json();
    assert.equal((await check({ title: 'Lawrence', cassette_number: '2' })).duplicate, true);
    assert.equal((await check({ title: 'Lawrence', director: 'David Lean', cassette_number: '2' })).duplicate, true);
    assert.equal((await check({ title: 'Lawrence', director: 'Someone Else', cassette_number: '2' })).duplicate, false);
    assert.equal((await check({ title: 'Missing' })).duplicate, false);
    const number = await (await request('/api/check-cassette-number?cassette_number=77', { cookie: admin })).json();
    assert.equal(number.taken, true);
});

test('delete last items removes the newest entries, wishlist included', async () => {
    await save({ title: 'Keep' });
    await sleep(20);
    await save({ title: 'DelCollection' });
    await sleep(20);
    await save({ title: 'DelWish', in_wishlist: 'true' });
    const response = await request('/admin/delete-last-items', { cookie: admin, json: { count: 2, kind: 'VHS' } });
    assert.equal((await response.json()).deleted, 2);
    assert.equal((await byTitle('DelCollection')).length, 0);
    assert.equal((await byTitle('DelWish')).length, 0);
    assert.equal((await byTitle('Keep')).length, 1);
});

// ---------- Lists

test('titles and cassette numbers sort naturally', async () => {
    await save({ title: 'alpha', cassette_number: '100' });
    await save({ title: 'Beta', cassette_number: '9' });
    await save({ title: 'Zulu', cassette_number: '10' });
    const order = async (url) => {
        const html = await (await request(url, { cookie: admin })).text();
        return [...html.matchAll(/\b(alpha|Beta|Zulu)\b/g)].map((m) => m[1]).filter((x, i, a) => a.indexOf(x) === i).join();
    };
    assert.equal(await order('/collection?sort=title_asc&limit=200'), 'alpha,Beta,Zulu');
    assert.equal(await order('/collection?sort=cassette_asc&limit=200'), 'Beta,Zulu,alpha');
    assert.equal(await order('/collection?sort=cassette_desc&limit=200'), 'alpha,Zulu,Beta');
    assert.equal(await order('/print/collection'), 'alpha,Beta,Zulu');
});

test('unusual links do not cause server errors', async () => {
    const urls = ['/collection?page=-1', '/collection?page=abc', '/collection?limit=-1', '/collection?limit=999999',
        '/collection?search=a&search=b', '/collection?format=a&format=b', '/collection?location=a&location=b',
        '/collection?genre=a&genre=b', '/collection?original=a&original=b', '/collection?sort=a&sort=b',
        '/collection?filterMode=a&filterMode=b', '/collection?search[x]=1', '/wishlist?search=a&search=b',
        '/wishlist?sort=a&sort=b', '/add-vhs?search=a&search=b', '/api/check-duplicate?title=a&title=b',
        '/api/check-cassette-number?cassette_number=1&cassette_number=2', '/admin/api/search-collection?q=a&q=b',
        '/vhs/abc', '/vhs/edit/abc'];
    for (const url of urls) {
        const { status } = await request(url, { cookie: admin });
        assert.ok(status < 500, `${url} -> ${status}`);
    }
    assert.equal((await request('/collection', { cookie: `${admin}; sortPref=__proto__` })).status, 200);
});

test('the inverted filter only hides matches', async () => {
    const all = await (await request('/collection?filterMode=hide&limit=200', { cookie: admin })).text();
    assert.ok(all.includes('Zulu') && all.includes('Beta'));
    const hidden = await (await request('/collection?filterMode=hide&search=Beta&limit=200', { cookie: admin })).text();
    assert.ok(hidden.includes('Zulu'));
    assert.ok(!hidden.includes('>Beta<') && !/>\s*Beta\s*</.test(hidden));
});

test('hidden tapes stay hidden for readers on every page', async () => {
    await save({ title: 'SecretFilm', genres: 'SecretGenre', location: 'SecretShelf' });
    const [secret] = await byTitle('SecretFilm');
    await client.db().collection('settings').updateOne({}, { $set: { 'visibility.hiddenItems': [secret._id] } }, { upsert: true });
    for (const url of ['/', '/collection?limit=200', '/stats', '/print/collection']) {
        const html = await (await request(url, { cookie: reader })).text();
        assert.ok(!/SecretFilm|SecretGenre|SecretShelf/.test(html), url);
    }
    assert.notEqual((await request(`/vhs/${secret._id}`, { cookie: reader })).status, 200);
    assert.ok((await (await request('/collection?limit=200', { cookie: admin })).text()).includes('SecretFilm'));
    await client.db().collection('settings').updateOne({}, { $set: { 'visibility.hiddenItems': [] } });
    await albums.deleteOne({ _id: secret._id });
});

test('totals convert between currencies', async () => {
    await save({ title: 'ValueEUR', estimated_value: '10', estimated_currency: 'EUR', is_original: 'true' });
    await save({ title: 'ValueUSD', estimated_value: '10', estimated_currency: 'USD', is_original: 'true' });
    const html = await (await request('/stats', { cookie: admin })).text();
    assert.match(html, /15\.00/, 'EUR 10 + USD 10 at the mocked rate of 0.5');
    assert.match(html, /\$10\.00/, 'the top list shows each amount in its own currency');
    assert.match(html, /€10\.00/);
});

test('a currency without an exchange rate is left out of the total', async () => {
    await save({ title: 'ValueGBP', estimated_value: '10', estimated_currency: 'GBP', is_original: 'true' });
    const html = await (await request('/stats', { cookie: admin })).text();
    assert.match(html, /15\.00/);
    await albums.deleteOne({ title: 'ValueGBP' });
});

// ---------- Pages and languages

const PAGES = ['/', '/collection', '/wishlist', '/stats', '/print/collection', '/print/wishlist', '/add-vhs', '/add-vhs/manual', '/settings', '/admin', '/admin/personnalisation'];

test('no page leaks fixed German or French texts, and inline scripts are valid', async () => {
    const [tape] = await byTitle('ValueEUR');
    const pages = [...PAGES, `/vhs/${tape._id}`, `/vhs/edit/${tape._id}`];
    const foreign = ['Drucken', 'Einträge', 'Kassettennummer', 'Bereits vorhanden', 'Abbrechen', 'Preis schätzen', 'z.B.', 'Komödie', 'Regisseur', 'Tab schließen', 'Inconnu', 'Utilisateur', 'Ne correspond', 'Erreur :', 'email@domaine'];
    for (const language of ['en', 'es', 'it']) {
        await users.updateOne({ email: OWNER.email }, { $set: { language } });
        for (const url of pages) {
            const response = await request(url, { cookie: admin });
            assert.equal(response.status, 200, url);
            const html = await response.text();
            for (const word of foreign) assert.ok(!html.includes(word), `${language} ${url}: ${word}`);
            assert.ok(!/\bui\.[a-z_]+\b/.test(html), `${language} ${url}: raw translation key`);
            assert.deepEqual(inlineScriptErrors(html), [], `${language} ${url}`);
        }
    }
    await users.updateOne({ email: OWNER.email }, { $set: { language: 'en' } });
});

test('dates and numbers follow the language', async () => {
    const [tape] = await byTitle('ValueEUR');
    await albums.updateOne({ _id: tape._id }, { $set: { added_at: new Date('2026-03-25T12:00:00Z') } });
    await users.updateOne({ email: OWNER.email }, { $set: { language: 'fr' } });
    assert.ok((await (await request(`/vhs/${tape._id}`, { cookie: admin })).text()).includes('25/03/2026'));
    await users.updateOne({ email: OWNER.email }, { $set: { language: 'de' } });
    assert.ok((await (await request(`/vhs/${tape._id}`, { cookie: admin })).text()).includes('25.3.2026'));
    await users.updateOne({ email: OWNER.email }, { $set: { language: 'en' } });
});

test('all languages have the same translation keys', () => {
    const flatten = (object, prefix = '') => Object.entries(object).flatMap(([key, value]) =>
        (typeof value === 'object' ? flatten(value, `${prefix}${key}.`) : [`${prefix}${key}`]));
    const keys = (language) => flatten(JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', `${language}.json`), 'utf8'))).sort();
    for (const language of LOCALES) assert.deepEqual(keys(language), keys('en'), language);
});

test('the print view uses the colors of the active theme', async () => {
    const themes = require('../config/themes');
    await client.db().collection('settings').updateOne({}, { $set: { 'theme.preset': 'forest' } }, { upsert: true });
    const html = await (await request('/print/collection', { cookie: admin })).text();
    assert.ok(html.includes(`background: ${themes.forest.light.highlight};`));
    await client.db().collection('settings').updateOne({}, { $set: { 'theme.preset': 'ranger' } });
});

test('nothing is left of the colors of the app this one is based on', () => {
    const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    for (const file of [...files(path.join(ROOT, 'views')), ...files(path.join(ROOT, 'public-tpl'))]) {
        const text = fs.readFileSync(file, 'utf8');
        assert.ok(!/ff89a9|ffd3df|255,\s*137,\s*169|bg-pink/i.test(text), file);
    }
});

test('frontend libraries ship with the app', async () => {
    const pages = [...PAGES, '/login'];
    for (const url of pages) {
        const html = await (await request(url, { cookie: url === '/login' ? undefined : admin })).text();
        for (const [, source] of html.matchAll(/<(?:script|link)[^>]+(?:src|href)="(https?:[^"]+)"/g)) {
            assert.fail(`${url} loads ${source}`);
        }
        for (const [, source] of html.matchAll(/<(?:script|link)[^>]+(?:src|href)="(\/[^"]+)"/g)) {
            assert.equal((await request(source)).status, 200, `${url}: ${source}`);
        }
    }
});

test('the web app files exist', async () => {
    const worker = await (await request('/sw.js')).text();
    const assets = [...worker.match(/STATIC_ASSETS = \[([\s\S]*?)\]/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert.ok(assets.length > 3);
    assert.ok(!assets.includes('/'), 'pages must not be cached');
    assert.match(worker, /event.request.mode === 'navigate'/);
    for (const asset of assets) assert.ok([200, 302].includes((await request(asset)).status), asset);
    const manifest = await (await request('/manifest.json')).json();
    assert.equal(manifest.theme_color, '#3dc6d0');
});

test('the changelog matches the app version and opens from the settings', async () => {
    const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const { entries } = JSON.parse(fs.readFileSync(path.join(ROOT, 'changelog.json'), 'utf8'));
    assert.equal(entries[0].version, version);
    const html = await (await request('/settings', { cookie: admin })).text();
    assert.ok(html.includes('id="changelogModal"') && html.includes(entries[0].changes[0].slice(0, 20)));
});

// ---------- Backups

test('backups are checked before anything is deleted', async () => {
    const good = await exportData();
    const count = await albums.countDocuments();
    const copies = safetyCopies().length;
    const bad = {
        empty: { harmless: 1 },
        'films only': { albums: good.albums },
        'no admin': { users: good.users.map((u) => ({ ...u, isAdmin: false })), albums: good.albums },
        'incomplete admin': { users: [{ username: 'x', isAdmin: true }] },
        'user is not an object': { users: ['x', good.users[0]] },
        'albums is not a list': { users: good.users, albums: 'x' },
        'film without title': { users: good.users, albums: [...good.albums, { kind: 'VHS', owner: good.users[0]._id }] },
        'wrong type': { users: good.users, albums: [{ ...good.albums[0], runtime: 'long' }] }
    };
    for (const [name, body] of Object.entries(bad)) {
        const response = await request('/backup/import', { cookie: admin, json: body });
        assert.equal(response.status, 400, name);
        assert.equal(await albums.countDocuments(), count, name);
    }
    assert.equal(safetyCopies().length, copies);
});

test('a failed restore puts the previous data back', async () => {
    const good = await exportData();
    const before = JSON.stringify(await albums.find().sort({ _id: 1 }).toArray());
    const copies = safetyCopies().length;
    const twice = { ...good, users: [...good.users, { ...good.users[0], _id: '64b000000000000000000001' }] };
    const response = await request('/backup/import', { cookie: admin, json: twice });
    assert.equal(response.status, 500);
    assert.match((await response.json()).error, /put back/);
    assert.equal(JSON.stringify(await albums.find().sort({ _id: 1 }).toArray()), before);
    assert.equal((await request('/collection', { cookie: admin })).status, 200);
    assert.equal(safetyCopies().length, copies + 1);
});

test('old backups without kind and with text IDs are restored completely', async () => {
    const legacy = JSON.parse(JSON.stringify(await exportData()));
    const tape = legacy.albums.find((a) => a.title === 'Lawrence' && a.cassette_number === '2');
    delete tape.kind;
    tape.title = 'OldBackup';
    tape.tmdb_id = '947';
    legacy.albums.find((a) => a.title === 'NoId').tmdb_id = 'abc';
    legacy.logs.push({ broken: true, status: 'unknown' });
    const response = await request('/backup/import', { cookie: admin, json: legacy });
    assert.equal(response.status, 200, await response.clone().text());
    admin = await login(OWNER.email, OWNER.password);
    const [restored] = await byTitle('OldBackup');
    assert.equal(restored.kind, 'VHS');
    assert.equal(restored.cast.length, 2);
    assert.equal(restored.cassette_number, '2');
    assert.equal(restored.tmdb_id, 947);
    assert.ok((await (await request('/collection?search=OldBackup', { cookie: admin })).text()).includes('OldBackup'));
});

test('a safety copy can be restored and survives the retention', async () => {
    const newest = safetyCopies().sort().pop();
    const response = await request(`/backup/backups/${encodeURIComponent(newest)}/restore`, { method: 'POST', cookie: admin });
    assert.equal(response.status, 200, await response.clone().text());
    admin = await login(OWNER.email, OWNER.password);
    assert.equal((await byTitle('OldBackup')).length, 0);
    assert.equal((await byTitle('Lawrence')).length, 2);

    await request('/backup/schedule', { cookie: admin, form: { enabled: 'on', time: '03:00', intervalDays: '1', retention: '1' } });
    const copies = safetyCopies().join();
    await request('/backup/backups/create', { method: 'POST', cookie: admin });
    await sleep(1100);
    const created = await (await request('/backup/backups/create', { method: 'POST', cookie: admin })).json();
    assert.equal(safetyCopies().join(), copies);
    assert.equal(fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('vhsranger_backup_')).length, 1);
    assert.ok(created.backups.some((b) => b.name.startsWith('vhsranger_before_restore_')));
    assert.ok(!fs.readdirSync(BACKUP_DIR).some((f) => f.endsWith('.tmp')));
});

test('at most three safety copies are kept', async () => {
    for (let i = 0; i < 4; i++) {
        const current = await exportData();
        await sleep(1100);
        await request('/backup/import', { cookie: admin, json: current });
        admin = await login(OWNER.email, OWNER.password);
    }
    assert.equal(safetyCopies().length, 3);
});

test('backup files outside the backup folder are refused', async () => {
    const response = await request(`/backup/backups/${encodeURIComponent('../../app.js')}`, { method: 'DELETE', cookie: admin });
    assert.equal(response.status, 400);
    assert.ok(fs.existsSync(path.join(ROOT, 'app.js')));
});

test('scheduled backups catch up but keep their interval', () => {
    const at = (s) => new Date(s);
    assert.equal(isBackupDue({ time: '03:00', intervalDays: 1, lastRunAt: at('2026-11-03T03:00:00') }, at('2026-11-04T02:59:00')), false);
    assert.equal(isBackupDue({ time: '03:00', intervalDays: 1, lastRunAt: at('2026-11-03T03:00:30') }, at('2026-11-04T03:00:00')), true);
    assert.equal(isBackupDue({ time: '03:00', intervalDays: 1, lastRunAt: at('2026-11-01T03:00:00') }, at('2026-11-04T17:00:00')), true);
    assert.equal(isBackupDue({ time: '03:00', intervalDays: 1, lastRunAt: at('2026-11-04T03:00:00') }, at('2026-11-04T17:00:00')), false);
    assert.equal(isBackupDue({ time: '03:00', intervalDays: 3, lastRunAt: at('2026-11-02T03:00:00') }, at('2026-11-04T17:00:00')), false);
    assert.equal(isBackupDue({ time: '03:00' }, at('2026-11-04T17:00:00')), true);
});

// ---------- Login throttling comes last, it would block the tests above

test('login only accepts plain text', async () => {
    const response = await request('/login', { json: { email: { $ne: null }, password: { $ne: null } } });
    assert.equal(response.status, 400);
    assert.equal(jwtCookie(response), '');
});

test('repeated failures block the client for this account, and the client cannot spoof its way out', async () => {
    for (let i = 0; i < 4; i++) await request('/login', { json: { email: 'ann@example.test', password: 'wrong' } });
    const blocked = await request('/login', { json: { email: 'ann@example.test', password: readerPassword } });
    assert.equal(blocked.status, 429);
    const spoofed = await request('/login', { headers: { 'x-forwarded-for': '9.9.9.9' }, json: { email: 'ann@example.test', password: readerPassword } });
    assert.equal(spoofed.status, 429);
    assert.ok(await login(OWNER.email, OWNER.password), 'other accounts still work');
    const log = await client.db().collection('loginlogs').findOne({ email: 'ann@example.test', status: 'failed' });
    assert.ok(log);
});
