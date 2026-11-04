/**
 * TMDb IDs are stored as numbers. Forms and old data can deliver them as text.
 *
 * @param {*} value
 * @returns {number|undefined} The ID, or undefined if the value is not a valid one.
 */
function parseTmdbId(value) {
    const text = String(value ?? '').trim();
    if (!/^[1-9]\d*$/.test(text)) return undefined;
    const id = Number(text);
    return Number.isSafeInteger(id) ? id : undefined;
}

module.exports = { parseTmdbId };
