// Licensed under MIT

/**
 * app.js
 *
 * Express application entrypoint. Sets up i18n, global middleware,
 * route mounting, database connection and sockets. Intended for local
 * development and small deployments; review security settings for
 * production use.
 */
require('dotenv').config();

// A publicly known signing secret would let anyone forge an admin login.
const EXAMPLE_SECRETS = ['SomeComplexPassword', 'ChangeThisToAComplexPassword'];
if (!process.env.PASSJWT || EXAMPLE_SECRETS.includes(process.env.PASSJWT)) {
  console.error('❌ PASSJWT is missing or still the example value. Set it to a long random secret, e.g. the output of: openssl rand -hex 32');
  process.exit(1);
}

const express = require('express');
const path = require('path');
const { checkUser, resolveUser } = require('./middleware/authMiddleware.js');
const cookieParser = require('cookie-parser');
const mongoose = require('mongoose');
const http = require('http');
const { Server } = require("socket.io");

const i18next = require('i18next');
const i18nMiddleware = require('i18next-http-middleware');

const settingsMiddleware = require('./middleware/settingsMiddleware');
const themesConfig = require('./config/themes');
const { BASE_URL } = require('./config/constants');
const { getClientIp } = require('./utils/clientIp');

// Models
const User = require('./models/User.js');
const BlockedIP = require('./models/blockedIP.js');

// Routes imports
const setupRoutes = require('./routes/setupRoutes');
const authRoutes = require('./routes/authRoutes.js');
const vhsRoutes = require('./routes/vhsRoutes.js');
const adminRoutes = require('./routes/adminRoutes.js');
const settingsRoutes = require('./routes/settingsRoutes.js');
const backupRoutes = require('./routes/backupRoutes.js');

// A forgotten await must not take the whole app down.
process.on('unhandledRejection', (reason) => {
  console.error('[ERR] Unhandled rejection:', reason);
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  path: BASE_URL + '/socket.io',
});

// Sockets only carry admin progress events, so only admins may connect.
io.engine.use(cookieParser());
io.use(async (socket, next) => {
  try {
    const user = await resolveUser(socket.request.cookies && socket.request.cookies.jwt);
    if (user && user.isAdmin === true) return next();
  } catch (err) {
    // Handled below like any other rejected connection.
  }
  next(new Error('unauthorized'));
});


i18next
  .use(i18nMiddleware.LanguageDetector) // Detect language via query/cookie/header
  .init({
    fallbackLng: 'en',
    supportedLngs: ['en', 'fr', 'es', 'it', 'de'],
    load: 'languageOnly', // de-DE uses the de translations
    preload: ['fr', 'en', 'es', 'it', 'de'],
    resources: {
      en: { translation: require('./locales/en.json') },
      fr: { translation: require('./locales/fr.json') },
      es: { translation: require('./locales/es.json') },
      it: { translation: require('./locales/it.json') },
      de: { translation: require('./locales/de.json') }
    },
    detection: {
      order: ['querystring', 'cookie', 'header'], // detection order
      caches: ['cookie']
    }
  });


// Basic configuration
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('io', io); // Expose io to routes

// Global middlewares
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Referrer-Policy', 'same-origin');
  next();
});
// Uploads are avatars only. Anything else in that folder is not served.
app.use(BASE_URL + '/uploads', (req, res, next) => {
  if (/\.(jpe?g|png|gif|webp)$/i.test(req.path)) return next();
  res.status(404).end();
});
app.use(BASE_URL, express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
// Express 5 leaves req.body undefined when a request has no parsable body.
app.use((req, res, next) => {
  if (req.body === undefined) req.body = {};
  next();
});
app.use(cookieParser());


app.use(i18nMiddleware.handle(i18next));


if (process.env.PROD === 'true') {
  app.set('trust proxy', 1); // Trust first proxy
}

const pkg = require('./package.json');
const changelog = require('./changelog.json').entries;

// Incext BASE_URL in each res.redirect call
app.use((req, res, next) => {
  const redirect = res.redirect;

  res.redirect = function (url) {
    if (url.startsWith('/') && !url.startsWith(BASE_URL)) {
      return redirect.call(this, `${BASE_URL}${url}`);
    } else {
      return redirect.call(this, url);
    }
  };

  next();
});

// Without a database no page can work: answer right away instead of hanging.
app.use((req, res, next) => {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).send(req.t('errors.database_unavailable'));
  }
  next();
});

app.use(checkUser);

app.use(async (req, res, next) => {
  // If the user is authenticated and has a language preference, enforce it
  if (req.user && req.user.language) {
    await req.i18n.changeLanguage(req.user.language);
  }

  // Make translation helper and current language available to all EJS views
  res.locals.t = req.t;
  res.locals.currentLng = req.language;
  res.locals.appVersion = pkg.version;
  res.locals.changelog = changelog;
  res.locals.baseUrl = BASE_URL;
  // JSON for inline <script> blocks: data cannot close the script tag.
  res.locals.scriptJson = (value) => JSON.stringify(value).replace(/</g, '\\u003c');
  res.locals.currentPath = req.path;
  req.io = io;
  next();
});


// Inject IO object into requests
app.use((req, res, next) => {
  req.io = io;
  next();
});

// Security: IP blocking middleware
app.use(async (req, res, next) => {
  const clientIP = getClientIp(req);
  try {
    // Older entries may still carry the "::ffff:" prefix.
    const blocked = await BlockedIP.findOne({ ip: { $in: [clientIP, '::ffff:' + clientIP] } });
    if (blocked) return res.status(403).send(req.t('common.forbidden'));
    next();
  } catch (err) {
    console.error('IP error:', err);
    next();
  }
});

// Check user middleware (populate res.locals.user for all views)
app.use(settingsMiddleware);

// Installation gatekeeper middleware
app.use(async (req, res, next) => {
    // Ignore paths that should not be redirected during setup
    if (req.path.startsWith(BASE_URL + '/setup') ||
      req.path.startsWith(BASE_URL + '/ressources') ||
      req.path.startsWith(BASE_URL + '/styles') ||
      req.path.startsWith(BASE_URL + '/login') ||
      req.path.startsWith(BASE_URL + '/backup') ) { // allow login and backup import while setting up
        return next();
    }

    try {
        const count = await User.countDocuments();
        if (count === 0) {
            return res.redirect(BASE_URL + '/setup');
        }
    } catch (e) {
        console.error("Check setup error:", e);
    }

    next();
});

app.use((req, res, next) => {
    res.locals.allThemes = themesConfig;
    next();
});


// Dynamic manifest.json endpoint - injects BASE_URL
app.get(BASE_URL + '/manifest.json', (req, res) => {
    res.set('Content-Type', 'application/json');
    res.render(path.join(__dirname, 'public-tpl', 'manifest.json.ejs'));
});

// Dynamic service worker endpoint - injects BASE_URL
app.get(BASE_URL + '/sw.js', (req, res) => {
    res.set('Content-Type', 'application/javascript');
    res.set('Service-Worker-Allowed', BASE_URL || '/');
    res.render(path.join(__dirname, 'public-tpl', 'sw.js.ejs'));
});


// Route mounting
app.use(BASE_URL + '/setup', setupRoutes);
app.use(BASE_URL, authRoutes);
app.use(BASE_URL, vhsRoutes);
app.use(BASE_URL + '/admin', adminRoutes);
app.use(BASE_URL + '/settings', settingsRoutes);
app.use(BASE_URL + '/backup', backupRoutes);

app.use((req, res) => {
    res.status(404).render('404');
});

// Without this handler Express prints stack traces and server paths to the client.
app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);

    const candidate = err.status || err.statusCode;
    const status = candidate >= 400 && candidate < 600 ? candidate : 500;
    if (status >= 500) console.error(err);

    // Body parser errors happen before the i18n middleware has run.
    const translate = req.t || i18next.getFixedT('en');
    const message = translate(status >= 500 ? 'errors.generic_server_error' : 'errors.bad_request');
    if (req.is('json') || req.accepts(['html', 'json']) === 'json') {
        return res.status(status).json({ error: message });
    }
    res.status(status).type('text/plain').send(message);
});

const connectDB = require('./config/db.js');
const migrateDatabase = require('./utils/migrate.js');
const { startScheduler } = require('./utils/backupScheduler.js');
// The database may start later than the app (e.g. after a server reboot), so keep trying.
const connectWithRetry = async () => {
  for (;;) {
    try {
      await connectDB();
      return;
    } catch (err) {
      console.log('❌DB Error:', err.message);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
};

// Server start and database connection
const port = process.env.VHS_PORT || 3098;
server.listen(port, () => {
    console.log(`🚀 Server started on port ${port}`);
});

connectWithRetry()
  .then(async () => {
    await migrateDatabase();
    startScheduler();
  })
  .catch((err) => console.error('[ERR] Startup:', err));


// Socket event
// io.on('connection', (socket) => {
//   console.log('Connected socket :', socket.id);
// });
