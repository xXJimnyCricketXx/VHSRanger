/**
 * controllers/authController.js
 *
 * Authentication controller: handles rendering the login page, processing
 * login submissions, creating a JWT cookie on success, logging login
 * attempts, rate-limiting repeated failures and logging out users.
 */
const User = require("../models/User");
const jwt = require('jsonwebtoken');
const LoginLog = require("../models/LoginLog");
const geoip = require('geoip-lite');
const { getClientIp } = require('../utils/clientIp');

const MAX_ATTEMPTS = 4; // per client and account
const MAX_IP_ATTEMPTS = 20; // per client across all accounts
const BLOCK_TIME = 5 * 60 * 1000; // 5 minutes
const MAX_EMAIL_LENGTH = 254;
const MAX_PASSWORD_LENGTH = 200;

// In-memory attempt tracking. Failures count per client, so a stranger who
// knows an email address cannot lock the real owner out of the account.
const attempts = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of attempts) {
    if (now - entry.lastTry > BLOCK_TIME && !(entry.blockedUntil > now)) attempts.delete(key);
  }
}, BLOCK_TIME).unref();

/**
 * @returns {number} Milliseconds until the key is unblocked, 0 if it is not blocked.
 */
const blockedFor = (key, now) => {
  const entry = attempts.get(key);
  if (!entry) return 0;
  if (entry.blockedUntil && now < entry.blockedUntil) return entry.blockedUntil - now;
  if (entry.blockedUntil || now - entry.lastTry > BLOCK_TIME) attempts.delete(key);
  return 0;
};

/**
 * @returns {boolean} Whether this failure blocked the key.
 */
const registerFailure = (key, max, now) => {
  const entry = attempts.get(key) || { count: 0, lastTry: now };
  entry.count++;
  entry.lastTry = now;
  if (entry.count >= max) entry.blockedUntil = now + BLOCK_TIME;
  attempts.set(key, entry);
  return entry.count >= max;
};

const writeLoginLog = (req, ip, status, { user, username, email }) => {
  const geo = geoip.lookup(ip) || {};
  return LoginLog.create({
    user,
    username,
    email,
    ip,
    country: geo.country || 'XX',
    city: geo.city || req.t('common.unknown'),
    userAgent: String(req.headers['user-agent'] || '').slice(0, 500),
    status
  });
};

/**
 * GET /login
 * Render the login page.
 */
module.exports.login_get = (req, res) => {
  res.render('login');
};

/**
 * POST /login
 * Process login form submissions. Implements simple in-memory rate limiting
 * and logs each attempt (success or failure) with geolocation information.
 */
module.exports.login_post = async (req, res, next) => {
  const { email: rawEmail, password } = req.body;

  // Only plain strings reach the database, which also rules out query operators.
  if (typeof rawEmail !== 'string' || typeof password !== 'string' ||
      !rawEmail || !password ||
      rawEmail.length > MAX_EMAIL_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    return res.status(400).json({ errors: { login: req.t('errors.invalid_credentials') } });
  }

  const email = rawEmail.trim().toLowerCase();
  const ip = getClientIp(req);
  const now = Date.now();
  const accountKey = `account:${ip}|${email}`;
  const ipKey = `ip:${ip}`;

  const waitMs = Math.max(blockedFor(accountKey, now), blockedFor(ipKey, now));
  if (waitMs > 0) {
    return res.status(429).json({
      errors: { login: req.t('errors.too_many_attempts_timed', { seconds: Math.ceil(waitMs / 1000) }) }
    });
  }

  try {
    const user = await User.login(email, password);

    await writeLoginLog(req, ip, 'success', { user: user._id, username: user.username, email: user.email });

    attempts.delete(accountKey);

    const token = jwt.sign({ id: user._id }, process.env.PASSJWT, { expiresIn: '3d' });

    res.cookie('jwt', token, {
        httpOnly: true,
        maxAge: 3 * 24 * 60 * 60 * 1000,
        secure: process.env.PROD === 'true', // Only send cookie over HTTPS in production
        sameSite: 'lax' // Mitigate CSRF
    });
    res.status(200).json({ user: user._id });

  } catch (err) {
    if (err.message !== 'incorrect email' && err.message !== 'incorrect password') {
      return next(err);
    }

    await writeLoginLog(req, ip, 'failed', { email }).catch(console.error);

    const accountBlocked = registerFailure(accountKey, MAX_ATTEMPTS, now);
    const ipBlocked = registerFailure(ipKey, MAX_IP_ATTEMPTS, now);
    if (accountBlocked || ipBlocked) {
      return res.status(429).json({
        errors: { login: req.t('errors.too_many_attempts_blocked') }
      });
    }

    res.status(400).json({
      errors: { login: req.t('errors.invalid_credentials') }
    });
  }
};

/**
 * GET /logout
 */
module.exports.logout_get = (req, res) => {
  res.cookie('jwt', '', { maxAge: 1 });
  res.redirect('/');
};
