/**
 * routes/setupRoutes.js
 *
 * Initial setup routes used to create the first admin user. This module
 * exposes GET/POST handlers for `/setup`. In normal operation this route
 * should be disabled or removed after the initial admin account is created.
 */
const express = require('express');
const router = express.Router();
const User = require('../models/User');
const jwt = require('jsonwebtoken');


const maxAge = 3 * 24 * 60 * 60;
const createToken = (id) => {
    return jwt.sign({ id }, process.env.PASSJWT, {
        expiresIn: maxAge
    });
}

// GET /setup - render initial setup page if no users exist
router.get('/', async (req, res) => {
    const count = await User.countDocuments();
    if (count > 0) return res.redirect('/login'); // safety: only allow setup when DB empty
    res.render('setup', { error: null });
});

// Browsers may report a region (de-DE) or a language the app does not have.
const pickLanguage = (...candidates) => {
    const supported = User.schema.path('language').enumValues;
    return candidates.map((c) => String(c || '').split('-')[0]).find((c) => supported.includes(c)) || 'en';
};

// POST /setup - create initial admin user and issue a JWT
router.post('/', async (req, res) => {
    try {
        const count = await User.countDocuments();
        if (count > 0) return res.redirect('/login'); // safety: only allow setup when DB empty

        const { username, email, password, language } = req.body;

        // Create the initial admin user (isAdmin: true)
        const newAdmin = await User.createWithPassword({
            username,
            email,
            password,
            isAdmin: true,
            language: pickLanguage(language, req.language),
            lastChange: new Date()
        });

        // Issue JWT and set cookie
        const token = createToken(newAdmin._id);
        res.cookie('jwt', token, {
            httpOnly: true,
            maxAge: 3 * 24 * 60 * 60 * 1000,
            secure: process.env.PROD === 'true', // Only send cookie over HTTPS in production
            sameSite: 'lax' // Mitigate CSRF
        });
        res.redirect('/');
    } catch (err) {
        console.error(err);
        res.render('setup', { error: req.t('errors.setup_error') });
    }
});

module.exports = router;