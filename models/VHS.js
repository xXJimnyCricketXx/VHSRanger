const mongoose = require('mongoose');
const Item = require('./Item');

const vhsSchema = new mongoose.Schema({
  // true = original retail release, false = home recording / self-taped copy.
  // Value estimates only ever apply to originals.
  is_original: { type: Boolean, default: true },

  director: { type: String, default: '' },
  cast: [{ name: String, character: String, photo: String }],
  genres: { type: [String], default: [] },

  media_type: {
    type: String,
    enum: ['vhs'],
    default: 'vhs'
  },
  format_type: { type: String, default: 'VHS' },
  distributor: String,
  catalog_number: String,
  // Physical tape identifier (like the old sticker-label numbering system).
  // Several entries can share the same cassette_number when multiple films
  // are recorded on one physical tape (common with home recordings) — that's
  // what lets the collection stats tell "films" apart from "physical tapes".
  cassette_number: { type: String, default: '' },
  condition: { type: String, default: '' },
  region: { type: String, default: '' }, // PAL / NTSC / SECAM
  age_rating: { type: String, default: '' },
  runtime: Number, // minutes
  overview: { type: String, default: '' },
  tagline: { type: String, default: '' },
  backdrop_image: { type: String, default: '' },
  country: { type: String, default: '' },

  tmdb_id: Number,
  imdb_id: String,
  trailer_key: { type: String, default: '' }, // YouTube video id, from TMDb

  estimated_price: {
    value:      { type: Number, default: null },
    currency:   { type: String, default: null },
    source:     { type: String, default: null },
    updated_at: { type: Date,   default: null }
  }
});

const VHS = Item.discriminator('VHS', vhsSchema);

module.exports = VHS;
