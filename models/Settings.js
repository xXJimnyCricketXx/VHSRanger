const mongoose = require('mongoose');

const settingsSchema = new mongoose.Schema({
    siteName: { type: String, default: 'VHSRanger!' },
    theme: {
        preset: { type: String, default: 'ranger' }
    },
    statsWidgets: {
        type: [String],
        default: ['total', 'films', 'originals', 'director']
    },
    visibility: {
        applyToAdmin: { type: Boolean, default: false },
        hiddenItems: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Item' }],
        hiddenGenres: [{ type: String }],
        hiddenTypes: [{ type: String }]
    },
    backupSchedule: {
        enabled:      { type: Boolean, default: false },
        time:         { type: String,  default: '03:00' }, // HH:mm, 24h
        intervalDays: { type: Number,  default: 1 },
        retention:    { type: Number,  default: 3 },
        lastRunAt:    { type: Date,    default: null }
    }
});

module.exports = mongoose.model('Settings', settingsSchema);