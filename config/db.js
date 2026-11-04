/**
 * config/db.js
 *
 * Simple module to connect to MongoDB using Mongoose. Exports an async
 * function that establishes the connection using the `MONGODB_URL`
 * environment variable. This keeps connection logic separated from the
 * application entrypoint and makes testing easier.
 */
const mongoose = require('mongoose');
require('dotenv').config();
const MONGODB_URL = process.env.MONGODB_URL;

mongoose.connection.on('disconnected', () => console.error('⚠️ MongoDB disconnected'));
mongoose.connection.on('reconnected', () => console.log('✅ MongoDB reconnected'));

module.exports = async () => {
  await mongoose.connect(MONGODB_URL, { serverSelectionTimeoutMS: 5000 });
  console.log('✅ MongoDB connected');
};
