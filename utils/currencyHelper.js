const axios = require('axios');

/**
 * utils/currencyHelper.js
 *
 * Converts amounts between currencies using the Frankfurter API (ECB
 * reference rates, no API key required). Rates are cached in memory for
 * 24h per base currency to avoid hammering the API on every estimate.
 */

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 5 * 60 * 1000;
const rateCache = new Map(); // base -> { rates: {XXX: number}, fetchedAt: number }
const lastFailure = new Map(); // base -> timestamp

async function getRates(base) {
    const cached = rateCache.get(base);
    if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
        return cached.rates;
    }

    // Without internet access a page must not wait for the timeout on every request.
    if (Date.now() - (lastFailure.get(base) || 0) < RETRY_AFTER_FAILURE_MS) {
        if (cached) return cached.rates;
        throw new Error('Exchange rates unavailable');
    }

    try {
        const response = await axios.get(`https://api.frankfurter.dev/v1/latest`, {
            params: { base },
            timeout: 3000
        });
        const rates = response.data.rates || {};
        rateCache.set(base, { rates, fetchedAt: Date.now() });
        return rates;
    } catch (err) {
        lastFailure.set(base, Date.now());
        if (cached) return cached.rates;
        throw err;
    }
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

/**
 * Build a function returning an item's estimated value in the target currency,
 * so values stored in different currencies are never added up as if they were
 * the same. Each currency is looked up once. The function returns null for an
 * item without a value or whose currency could not be converted.
 *
 * @param {object[]} items
 * @param {string} to Target currency.
 * @returns {Promise<(item: object) => number|null>}
 */
async function createValueConverter(items, to) {
    const rates = new Map([[to, 1]]);

    for (const item of items) {
        const from = item.estimated_price && item.estimated_price.currency;
        if (!from || rates.has(from)) continue;
        try {
            const fetched = await getRates(from);
            rates.set(from, fetched[to] || null);
        } catch (e) {
            rates.set(from, null);
        }
    }

    return (item) => {
        const price = item.estimated_price;
        if (!price || !price.value) return null;
        const rate = rates.get(price.currency || to);
        return rate ? price.value * rate : null;
    };
}

module.exports = { convertCurrency, createValueConverter };
