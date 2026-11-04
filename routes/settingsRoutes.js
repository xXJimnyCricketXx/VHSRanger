const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const { requireAuth } = require('../middleware/authMiddleware');

const MAX_USERNAME_LENGTH = 50;
const MIN_PASSWORD_LENGTH = 6;
const MAX_PASSWORD_LENGTH = 200;

/**
 * routes/settingsRoutes.js
 *
 * User settings routes: avatar upload, username/theme/language updates
 * and password changes. Uses Multer for avatar uploads with local storage.
 */

const IMAGE_TYPES = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp'
};

// The browser declares the MIME type, so check the file's first bytes as well.
function hasImageSignature(filePath, mimetype) {
    const head = Buffer.alloc(12);
    const fd = fs.openSync(filePath, 'r');
    try {
        fs.readSync(fd, head, 0, 12, 0);
    } finally {
        fs.closeSync(fd);
    }
    switch (mimetype) {
        case 'image/jpeg': return head[0] === 0xFF && head[1] === 0xD8 && head[2] === 0xFF;
        case 'image/png': return head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
        case 'image/gif': return ['GIF87a', 'GIF89a'].includes(head.toString('latin1', 0, 6));
        case 'image/webp': return head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP';
        default: return false;
    }
}

// Multer configuration (image uploads)
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../public/uploads/avatars');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
        // Keep a timestamp to avoid browser cache and include user ID for clarity.
        // The extension comes from the checked type, never from the uploaded name.
        const ext = IMAGE_TYPES[file.mimetype];
        const userId = req.user ? req.user._id : 'unknown'; // req.user is available via requireAuth
        cb(null, `avatar-${userId}-${Date.now()}${ext}`);
  }
});

// Note: Multer runs before route handlers so accessing res.locals.user can be tricky.
// We include the user id in the filename (or use a wrapper) to associate uploads.
const upload = multer({
    storage: storage,
    fileFilter: (req, file, cb) => {
        if (IMAGE_TYPES[file.mimetype]) cb(null, true);
        else cb(new Error('Format non supporté (JPG, PNG, GIF, WEBP uniquement).'));
    },
    limits: { fileSize: 5 * 1024 * 1024 },
});


// Reports upload errors (wrong type, too large) as JSON like the rest of the form.
const uploadAvatar = (req, res, next) => {
    upload.single('avatar')(req, res, (err) => {
        if (err) return res.status(400).json({ success: false, message: req.t('messages.avatar_upload_error') });
        next();
    });
};

// Routes

// Render settings page
router.get('/', requireAuth, (req, res) => {
    res.render('settings', { user: res.locals.user });
});

// Check whether a username is available
router.post('/check-username', requireAuth, async (req, res) => {
    const { username } = req.body;
    try {
        // If user checks their current username, consider it available
        if (username === res.locals.user.username) {
            return res.json({ success: true, message: req.t('messages.username_current') });
        }

        const userExists = await User.findOne({ username: username });
        if (userExists) {
            return res.status(400).json({ success: false, message: req.t('errors.username_taken') });
        }
        res.json({ success: true, message: req.t('messages.username_available') });
    } catch (error) {
        res.status(500).json({ success: false, message: req.t('messages.generic_error') });
    }
});

// Update username
router.post('/update-username', requireAuth, async (req, res) => {
    const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
    if (!username || username.length > MAX_USERNAME_LENGTH) {
        return res.status(400).json({ success: false, message: req.t('auth.username_required') });
    }
    try {
        const userExists = await User.findOne({ username: username });
        if (userExists && userExists._id.toString() !== res.locals.user._id.toString()) {
            return res.status(400).json({ success: false, message: req.t('errors.username_taken') });
        }
        await User.findByIdAndUpdate(res.locals.user._id, { username: username });
        res.redirect('/settings');
    } catch (error) {
        res.status(500).json({ success: false, message: req.t('messages.generic_error') });
    }
});

// Upload avatar
router.post('/upload-avatar', requireAuth, uploadAvatar, async (req, res) => {
    // Multer error handling
    if (!req.file) return res.status(400).json({ success: false, message: req.t('messages.avatar_upload_error') });

    try {
        if (!hasImageSignature(req.file.path, req.file.mimetype)) {
            fs.unlinkSync(req.file.path);
            return res.status(400).json({ success: false, message: req.t('messages.avatar_upload_error') });
        }

        const userId = res.locals.user._id;

        // Retrieve previous avatar to remove it from disk
        const currentUser = await User.findById(userId);
        const oldAvatarPath = currentUser.img; // e.g. "/uploads/avatars/avatar-123.jpg"

        // Remove old file from disk if not the default image
        if (oldAvatarPath && !oldAvatarPath.includes('no-pp.jpg')) {
            const absoluteOldPath = path.join(__dirname, '../public', oldAvatarPath);

            if (fs.existsSync(absoluteOldPath)) {
                fs.unlinkSync(absoluteOldPath);
                console.log(`🗑️ Removed old avatar: ${absoluteOldPath}`);
            }
        }

        // Update DB with new path
        const newAvatarPath = `/uploads/avatars/${req.file.filename}`;
        await User.findByIdAndUpdate(userId, { img: newAvatarPath });

        res.json({ success: true, message: req.t('messages.avatar_updated'), avatarPath: newAvatarPath });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: req.t('messages.generic_error') });
    }
});

// Update Password
router.post('/update-password', requireAuth, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string' ||
        newPassword.length < MIN_PASSWORD_LENGTH || newPassword.length > MAX_PASSWORD_LENGTH) {
        return res.status(400).json({ success: false, message: req.t('auth.password_too_short') });
    }
    try {
        // Verify current password
        const user = await User.findById(res.locals.user._id);

        const isMatch = await bcrypt.compare(currentPassword, user.password);
        if (!isMatch) {
            return res.status(400).json({ success: false, message: req.t('errors.current_password_incorrect') });
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await User.findByIdAndUpdate(res.locals.user._id, {
            password: hashedPassword,
            lastChange: Date.now()
        });

        res.json({ success: true, message: req.t('messages.password_updated') });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: req.t('messages.generic_error') });
    }
});

// Update Theme
router.post('/update-theme', requireAuth, async (req, res) => {
    const { theme } = req.body;

    if (!['light', 'dark'].includes(theme)) {
        return res.status(400).json({ success: false, message: req.t('errors.invalid_theme') });
    }

    try {
        await User.findByIdAndUpdate(res.locals.user._id, { theme: theme });
        res.json({ success: true, message: req.t('messages.theme_updated') });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: req.t('messages.generic_error') });
    }
});

// Update Language
router.post('/update-language', requireAuth, async (req, res) => {
  const { language } = req.body;
  const userId = res.locals.user._id;

  if (!User.schema.path('language').enumValues.includes(language)) {
    return res.status(400).send(req.t('errors.lang_change_error'));
  }

  try {
    // Update language in DB
    await User.findByIdAndUpdate(userId, { language });

    // Update i18n language for current session
    await req.i18n.changeLanguage(language);

    // Redirect back or to settings page
    const backURL = req.header('Referer') || '/settings';
    res.redirect(backURL);

  } catch (err) {
    console.error(err);
    res.status(500).send(req.t('errors.lang_change_error'));
  }
});

router.post('/update-currency', requireAuth, async (req, res) => {
    const { currency } = req.body;
    const userId = res.locals.user._id;

    if (!['EUR', 'USD', 'GBP'].includes(currency)) {
        return res.status(400).send('Devise non supportée');
    }

    try {
        await User.findByIdAndUpdate(userId, { currency });
        res.redirect('/settings');
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: req.t('messages.generic_error') });
    }
});

module.exports = router;