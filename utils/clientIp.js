/**
 * utils/clientIp.js
 *
 * The client address as Express resolves it. X-Forwarded-For only counts when
 * "trust proxy" is enabled (PROD=true), so clients cannot spoof it otherwise.
 */
function getClientIp(req) {
    return normalizeIp(req.ip);
}

// IPv4 clients on a dual-stack socket show up as "::ffff:1.2.3.4".
function normalizeIp(ip) {
    return String(ip || '').trim().replace(/^::ffff:/i, '');
}

module.exports = { getClientIp, normalizeIp };
