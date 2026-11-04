const jwt = require('jsonwebtoken');
const User = require('../models/User');

/**
 * Resolve the user behind a login cookie. Returns null if the token is missing,
 * invalid, belongs to a deleted user or was issued before the last password
 * change. Every auth check goes through here, so they all treat a token alike.
 *
 * @param {string|undefined} token
 * @returns {Promise<import('mongoose').Document|null>}
 */
const resolveUser = async (token) => {
  if (!token) return null;

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.PASSJWT);
  } catch (err) {
    return null;
  }

  const user = await User.findById(decoded.id);
  if (!user) return null;
  // iat only has second precision, so lastChange is rounded down before comparing.
  if (user.lastChange && decoded.iat < Math.floor(user.lastChange.getTime() / 1000)) return null;
  return user;
};

/**
 * Middleware: requireAuth
 * Attaches the logged-in user to `req.user`, or clears the cookie and redirects
 * to the login page.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
const requireAuth = async (req, res, next) => {
  try {
    const user = await resolveUser(req.cookies.jwt);
    if (!user) {
      if (req.cookies.jwt) res.clearCookie('jwt');
      return res.redirect('/login');
    }
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * Middleware: checkUser
 * Populates `req.user`, `res.locals.user` and `res.locals.isAdmin` for routes
 * and templates. All of them stay empty without a valid token.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
const checkUser = async (req, res, next) => {
  try {
    const user = await resolveUser(req.cookies.jwt);
    req.user = user;
    res.locals.user = user;
    res.locals.isAdmin = !!(user && user.isAdmin === true);
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * Middleware: requireAdmin
 * Ensures the current request is performed by an admin user. Relies on
 * `checkUser` having populated `res.locals.user` beforehand.
 * Redirects to home if the user is not an admin.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
const requireAdmin = (req, res, next) => {
    const user = res.locals.user;

    if (user && user.isAdmin === true) {
        next(); // Admin, allow
    } else {
        res.redirect('/'); // Not admin, redirect
    }
};

module.exports = { requireAuth, checkUser, requireAdmin, resolveUser };
