const axios = require('axios');

/**
 * utils/currencyHelper.js
 *
 * Converts amounts between currencies using the Frankfurter API (ECB
 * reference rates, no API key required). Rates are cached in memory for
 * 24h per base currency to avoid hammering the API on every estimate.
 */

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const rateCache = new Map(); // base -> { rates: {XXX: number}, fetchedAt: number }

async function getRates(base) {
    const cached = rateCache.get(base);
    if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
        return cached.rates;
    }

    const response = await axios.get(`https://api.frankfurter.dev/v1/latest`, {
        params: { base }
    });
    const rates = response.data.rates || {};
    rateCache.set(base, { rates, fetchedAt: Date.now() });
    return rates;
}

/**
 * Convert an amount from one currency to another.
 * Returns null if conversion failed (caller should keep the original value/currency instead).
 * @returns {Promise<number|null>}
 */
async function convertCurrency(amount, from, to) {
    if (!from || !to || from === to) return amount;

    try {
        const rates = await getRates(from);
        const rate = rates[to];
        if (!rate) return null;
        return Math.round(amount * rate * 100) / 100;
    } catch (e) {
        return null;
    }
}

module.exports = { convertCurrency };
