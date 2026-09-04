const express = require('express');
const router = express.Router();
const axios = require('axios');

const Item = require('../models/Item');
const VHS = require('../models/VHS');

const { requireAuth, requireAdmin } = require('../middleware/authMiddleware'); // Protect routes
const User = require('../models/User');
const { TMDB_LANG_MAP, TMDB_COUNTRY_MAP } = require('../config/constants');
const { applyVisibilityFilter } = require('../utils/visibilityHelper');

const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMG_BASE = 'https://image.tmdb.org/t/p';

// Gibt den TMDb API-Key zurück – oder leeren String wenn nicht konfiguriert
function tmdbKey() {
    const k = process.env.TMDB_API_KEY;
    return (k && k !== 'YourTMDbAPIKeyHere') ? k : '';
}

function tmdbHeaders(key) {
    const h = { 'User-Agent': 'VHSRangerApp/1.0' };
    if (key) h['Authorization'] = `Bearer ${key}`;
    return h;
}

async function tmdbGet(path, key, params = {}) {
    const res = await axios.get(`${TMDB_BASE}${path}`, {
        headers: tmdbHeaders(key),
        params
    });
    return res.data;
}

function tmdbLang(locale) {
    return TMDB_LANG_MAP[locale] || 'en-US';
}

function tmdbCountry(locale) {
    return TMDB_COUNTRY_MAP[locale] || 'US';
}

const EBAY_BASE = 'https://api.ebay.com';
let ebayTokenCache = { token: null, expiresAt: 0 };

// Client-credentials OAuth token for the Browse API (application-level, no user login).
// Cached in-memory until shortly before expiry to avoid a token request per search.
async function ebayToken() {
    const appId = process.env.EBAY_APP_ID;
    const certId = process.env.EBAY_CERT_ID;
    if (!appId || !certId) return null;

    if (ebayTokenCache.token && Date.now() < ebayTokenCache.expiresAt) {
        return ebayTokenCache.token;
    }

    const credentials = Buffer.from(`${appId}:${certId}`).toString('base64');
    const res = await axios.post(
        `${EBAY_BASE}/identity/v1/oauth2/token`,
        'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope',
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${credentials}` } }
    );

    ebayTokenCache = {
        token: res.data.access_token,
        expiresAt: Date.now() + (res.data.expires_in - 60) * 1000
    };
    return ebayTokenCache.token;
}

// Rough price estimate from ACTIVE listings (asking prices / running bids) -
// not a real sales-history value. Returns min/median/max of found prices.
async function ebaySearchPrices(query) {
    const token = await ebayToken();
    if (!token) return null;

    const res = await axios.get(`${EBAY_BASE}/buy/browse/v1/item_summary/search`, {
        headers: { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_DE' },
        params: { q: query, limit: 30, filter: 'buyingOptions:{FIXED_PRICE|AUCTION}' }
    });

    const items = res.data.itemSummaries || [];
    const prices = items
        .map(i => i.price && parseFloat(i.price.value))
        .filter(v => v && v > 0)
        .sort((a, b) => a - b);

    if (!prices.length) return { count: 0 };

    const withPrice = items.find(i => i.price);
    const mid = Math.floor(prices.length / 2);
    const median = prices.length % 2 !== 0 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2;

    return {
        count: prices.length,
        min: prices[0],
        max: prices[prices.length - 1],
        median: Math.round(median * 100) / 100,
        currency: (withPrice && withPrice.price.currency) || 'EUR'
    };
}

function posterUrl(path) {
    return path ? `${TMDB_IMG_BASE}/w500${path}` : '';
}

function backdropUrl(path) {
    return path ? `${TMDB_IMG_BASE}/w1280${path}` : '';
}

function profileUrl(path) {
    return path ? `${TMDB_IMG_BASE}/w185${path}` : '';
}

// Picks the best available YouTube trailer key from a TMDb "videos" append.
function extractTrailerKey(data) {
    const videos = (data.videos && data.videos.results) || [];
    const youtube = videos.filter(v => v.site === 'YouTube');
    const trailer = youtube.find(v => v.type === 'Trailer' && v.official)
        || youtube.find(v => v.type === 'Trailer')
        || youtube.find(v => v.type === 'Teaser');
    return trailer ? trailer.key : '';
}

// Maps a full TMDb movie payload (with credits/external_ids/release_dates
// appended) to the flat shape our VHS documents/forms use.
function mapTmdbMovie(data, locale) {
    const director = (data.credits && data.credits.crew || [])
        .filter(c => c.job === 'Director')
        .map(c => c.name)
        .join(', ');

    const cast = (data.credits && data.credits.cast || [])
        .slice(0, 12)
        .map(c => ({ name: c.name, character: c.character || '', photo: profileUrl(c.profile_path) }));

    let ageRating = '';
    const countryCode = tmdbCountry(locale);
    const releaseDatesResults = (data.release_dates && data.release_dates.results) || [];
    const countryEntry = releaseDatesResults.find(r => r.iso_3166_1 === countryCode)
        || releaseDatesResults.find(r => r.iso_3166_1 === 'US');
    if (countryEntry) {
        const withCert = countryEntry.release_dates.find(rd => rd.certification);
        if (withCert) ageRating = withCert.certification;
    }

    return {
        tmdb_id: data.id,
        imdb_id: (data.external_ids && data.external_ids.imdb_id) || '',
        title: data.title,
        year: data.release_date ? data.release_date.slice(0, 4) : '',
        overview: data.overview || '',
        tagline: data.tagline || '',
        director: director || '',
        cast,
        genres: (data.genres || []).map(g => g.name),
        genre: (data.genres && data.genres[0] && data.genres[0].name) || '',
        runtime: data.runtime || null,
        age_rating: ageRating,
        country: (data.production_countries && data.production_countries[0] && data.production_countries[0].iso_3166_1) || '',
        cover_image: posterUrl(data.poster_path),
        backdrop_image: backdropUrl(data.backdrop_path),
        trailer_key: extractTrailerKey(data)
    };
}

// Counts physical tapes rather than film entries: several entries sharing the
// same cassette_number (multiple films recorded on one home-taped cassette)
// only count once, since they're the same physical object.
function countPhysicalCassettes(items) {
    const seen = new Set();
    let count = 0;
    items.forEach(item => {
        const num = (item.cassette_number || '').trim();
        if (num) {
            if (!seen.has(num)) {
                seen.add(num);
                count += 1;
            }
        } else {
            count += (item.quantity || 1);
        }
    });
    return count;
}

function countTotalFilms(items) {
    return items.reduce((acc, i) => acc + (i.quantity || 1), 0);
}

// Collapses multiple copies of the same film (several cassettes, or one
// cassette with quantity > 1) down to one entry, so "favorite director/actor/genre"
// stats reflect distinct films owned rather than physical copy count.
function dedupeFilms(items) {
    const seen = new Set();
    const result = [];
    items.forEach(item => {
        const key = item.tmdb_id ? `tmdb:${item.tmdb_id}` : `title:${(item.title || '').trim().toLowerCase()}`;
        if (!seen.has(key)) {
            seen.add(key);
            result.push(item);
        }
    });
    return result;
}

async function getAdminId() {
    const admin = await User.findOne({ isAdmin: true }).select('_id');
    return admin ? admin._id : null;
}

const formatForView = (item) => {
    if (!item) return null;
    const obj = item.toObject ? item.toObject() : item;

    return {
        ...obj,
        director: obj.director || '',
        media_type: obj.media_type || 'vhs',
        cover_image: obj.cover_image || obj.user_image || '/ressources/logo.png',
        cast: obj.cast || [],
        distributor: obj.distributor || '',
        year: obj.year || '',
        format_type: obj.format_type || 'VHS',
        condition: obj.condition || '',
        location: obj.location || '',
        genre: obj.genre || '',
        quantity: obj.quantity || 1,
        country: obj.country || '',
        is_original: obj.is_original !== undefined ? obj.is_original : true
    };
};

// Dashboard: view collection summary
router.get('/', requireAuth, async (req, res) => {
    try {
        const adminId = await getAdminId();
        const settings = res.locals.settings;
        let queryAll = { owner: adminId, in_wishlist: false };
        applyVisibilityFilter(queryAll, res.locals.isAdmin, settings);
        const allItems = await Item.find(queryAll).lean();

        const userCurrency = res.locals.user.currency || 'EUR';
        const totalValue = allItems.reduce((acc, i) => {
            const price = i.estimated_price && i.estimated_price.value;
            return price ? acc + (price * (i.quantity || 1)) : acc;
        }, 0);
        const valuedCount = allItems.filter(i => i.estimated_price && i.estimated_price.value).length;
        const originalsCount = allItems.filter(i => i.is_original !== false).reduce((acc, i) => acc + (i.quantity || 1), 0);
        const recordingsCount = allItems.filter(i => i.is_original === false).reduce((acc, i) => acc + (i.quantity || 1), 0);

        const stats = {
            total: countPhysicalCassettes(allItems),
            films: countTotalFilms(allItems),
            originals: originalsCount,
            recordings: recordingsCount,
            totalValue,
            valueCurrency: userCurrency,
            valuedCount
        };

        const getTop = (items, field) => {
            const map = {};
            let topName = req.t('common.not_available');
            let topCount = 0;
            items.forEach(item => {
                const name = item[field];
                if (name) {
                    map[name] = (map[name] || 0) + 1;
                    if (map[name] > topCount) {
                        topCount = map[name];
                        topName = name;
                    }
                }
            });
            return { name: topName, count: topCount };
        };

        const getTopActor = (items) => {
            const map = {};
            let topName = req.t('common.not_available');
            let topCount = 0;
            items.forEach(item => {
                (item.cast || []).forEach(member => {
                    if (member && member.name) {
                        map[member.name] = (map[member.name] || 0) + 1;
                        if (map[member.name] > topCount) {
                            topCount = map[member.name];
                            topName = member.name;
                        }
                    }
                });
            });
            return { name: topName, count: topCount };
        };

        const uniqueFilms = dedupeFilms(allItems);
        stats.director = getTop(uniqueFilms, 'director');
        stats.genre = getTop(uniqueFilms, 'genre');
        stats.actor = getTopActor(uniqueFilms);

        let latestQuery = { owner: adminId, in_wishlist: false };
        applyVisibilityFilter(latestQuery, res.locals.isAdmin, settings);

        let wishlistQuery = { owner: adminId, in_wishlist: true };
        applyVisibilityFilter(wishlistQuery, res.locals.isAdmin, settings);

        res.render('index', {
            latestCollection: (await Item.find(latestQuery).sort({ added_at: -1 }).limit(4)).map(formatForView),
            latestWishlist: (await Item.find(wishlistQuery).sort({ added_at: -1 }).limit(4)).map(formatForView),
            stats,
            settings
        });
    } catch (err) {
        console.error("Dashboard error:", err);
        res.status(500).send(req.t('errors.generic_server_error'));
    }
});

// Statistics page
router.get('/stats', requireAuth, async (req, res) => {
    try {
        const adminId = await getAdminId();
        const allItems = await Item.find({ owner: adminId, in_wishlist: false }).lean();

        const totalTapes = countPhysicalCassettes(allItems);
        const totalFilms = countTotalFilms(allItems);
        const currency = res.locals.user.currency || 'EUR';
        const totalValue = allItems.reduce((a, i) => {
            const p = i.estimated_price && i.estimated_price.value;
            return p ? a + p * (i.quantity || 1) : a;
        }, 0);

        // Genre distribution (use genres array, fallback to genre string).
        // Counted per distinct film, not per physical copy/cassette.
        const genreMap = {};
        dedupeFilms(allItems).forEach(item => {
            const gs = (item.genres && item.genres.length) ? item.genres : (item.genre ? [item.genre] : []);
            gs.forEach(g => { if (g) genreMap[g] = (genreMap[g] || 0) + 1; });
        });
        const genres = Object.entries(genreMap).sort((a, b) => b[1] - a[1]).slice(0, 15);

        // Condition distribution
        const condGroup = {};
        allItems.forEach(item => {
            const c = item.condition;
            if (!c) return;
            condGroup[c] = (condGroup[c] || 0) + (item.quantity || 1);
        });
        const conditions = Object.entries(condGroup).sort((a, b) => b[1] - a[1]);

        // Originals vs. home recordings
        const originalGroup = { original: 0, recording: 0 };
        allItems.forEach(item => {
            if (item.is_original === false) originalGroup.recording += (item.quantity || 1);
            else originalGroup.original += (item.quantity || 1);
        });

        // Tapes by release year
        const yearMap = {};
        allItems.forEach(item => {
            const y = parseInt(item.year);
            if (y > 1900 && y <= new Date().getFullYear()) {
                yearMap[y] = (yearMap[y] || 0) + (item.quantity || 1);
            }
        });
        const years = Object.entries(yearMap).sort((a, b) => a[0] - b[0]);

        // Top 10 most valuable
        const mostValuable = allItems
            .filter(i => i.estimated_price && i.estimated_price.value)
            .sort((a, b) => (b.estimated_price.value * (b.quantity || 1)) - (a.estimated_price.value * (a.quantity || 1)))
            .slice(0, 10)
            .map(formatForView);

        // 10 most recent additions
        const recentAdditions = allItems
            .sort((a, b) => new Date(b.added_at) - new Date(a.added_at))
            .slice(0, 10)
            .map(formatForView);

        res.render('stats', {
            totalTapes, totalFilms, totalValue, currency,
            genres, conditions, years, originalGroup,
            mostValuable, recentAdditions,
            printDate: new Date().toLocaleDateString(res.locals.currentLng === 'de' ? 'de-DE' : 'en-US')
        });
    } catch (err) {
        console.error(err);
        res.status(500).send(req.t('errors.generic_server_error'));
    }
});

router.get('/collection', requireAuth, async (req, res) => {
    try {
        const adminId = await getAdminId();
        const { search, format, location, genre, original } = req.query;
        let sort = req.query.sort;
        if (sort) {
            res.cookie('sortPref', sort, { maxAge: 365 * 24 * 60 * 60 * 1000 });
        } else {
            sort = req.cookies.sortPref || 'added_desc';
        }
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 25;

        let query = { owner: adminId, in_wishlist: false, kind: 'VHS' };
        let conditions = [];

        if (search) {
            const regex = new RegExp(escapeRegExp(search), 'i');
            conditions.push({
                $or: [{ title: regex }, { director: regex }, { barcode: regex }, { 'cast.name': regex }]
            });
        }

        if (format && format !== 'all') {
            conditions.push({ format_type: new RegExp(`^${escapeRegExp(format)}$`, 'i') });
        }

        if (location) {
            conditions.push({ location });
        }

        if (genre) {
            const genreArr = genre.split(',').map(g => g.trim()).filter(Boolean);
            if (genreArr.length > 0) {
                conditions.push({
                    $or: [
                        { genre: { $in: genreArr.map(g => new RegExp(escapeRegExp(g), 'i')) } },
                        { genres: { $in: genreArr.map(g => new RegExp(escapeRegExp(g), 'i')) } }
                    ]
                });
            }
        }

        if (original === 'original') {
            conditions.push({ is_original: { $ne: false } });
        } else if (original === 'recording') {
            conditions.push({ is_original: false });
        }

        // Wrap conditions if filterMode is 'hide'
        const filterMode = req.query.filterMode || 'show';
        if (filterMode === 'hide' && conditions.length > 0) {
            query.$and = [{ $nor: [{ $and: conditions }] }];
        } else if (conditions.length > 0) {
            query.$and = conditions;
        }

        applyVisibilityFilter(query, res.locals.isAdmin, res.locals.settings);

        const totalItems = await Item.countDocuments(query);

        // Build dynamic sort object
        const buildSortObj = () => {
            const sortMap = {
                'added_desc': { added_at: -1 },
                'added_asc': { added_at: 1 },
                'title_asc': { title: 1 },
                'title_desc': { title: -1 },
                'year_desc': { year: -1 },
                'year_asc': { year: 1 },
                'value_desc': { 'estimated_price.value': -1 },
                'value_asc': { 'estimated_price.value': 1 },
                'cassette_asc': { cassette_number: 1 },
                'cassette_desc': { cassette_number: -1 },
            };

            return sortMap[sort] || { added_at: -1 };
        };

        const items = await Item.find(query)
            .sort(buildSortObj())
            .skip((page - 1) * limit)
            .limit(limit)
            .lean();

        res.render('collection', {
            tapes: items.map(formatForView),
            totalItems,
            totalPages: Math.ceil(totalItems / limit),
            currentPage: page,
            queryLimit: limit,
            querySearch: search || '',
            queryLocation: location || '',
            queryGenre: genre || '',
            queryOriginal: original || '',
            queryFilterMode: filterMode,
            currentSort: sort,

            locations: await Item.distinct('location', { owner: adminId, kind: 'VHS' }),
            genres: await (async () => {
                const [gBase, gArray] = await Promise.all([
                    Item.distinct('genre', { owner: adminId, kind: 'VHS', genre: { $nin: ['', null] } }),
                    Item.distinct('genres', { owner: adminId, kind: 'VHS' })
                ]);
                return [...new Set([...gBase, ...gArray])].filter(Boolean).sort();
            })()
        });

    } catch (err) {
        console.error(err);
        res.status(500).send(req.t('errors.generic_server_error'));
    }
});

// Add-VHS search page (view)
router.get('/add-vhs', requireAuth, requireAdmin, (req, res) => {
    const searchQuery = req.query.search || '';
    res.render('add-vhs', { searchQuery, currentType: 'add-vhs' });
});

// Manual entry page
router.get('/add-vhs/manual', requireAuth, requireAdmin, async (req, res) => {
    try {
        const adminId = await getAdminId();
        const locations = await Item.distinct('location', { owner: adminId, location: { $ne: "" } });
        const genres = await Item.distinct('genre', { owner: adminId, genre: { $ne: "" } });
        res.render('add-manual', { locations, genres, currentType: 'add-vhs' });
    } catch (err) {
        console.error(err);
        res.redirect('/add-vhs');
    }
});

// route for editing an existing tape
router.get('/vhs/edit/:id', requireAuth, async (req, res) => {
    try {
        const tape = await Item.findById(req.params.id);
        if (!tape) {
            return res.redirect('/collection');
        }
        const tapeFormatted = formatForView(tape);
        const adminId = await getAdminId();
        const locations = await Item.distinct('location', { owner: adminId, location: { $ne: "" } });
        const genres = await Item.distinct('genre', { owner: adminId, kind: 'VHS', genre: { $ne: "" } });

        res.render('edit-vhs', { tape: tapeFormatted, user: res.locals.user, locations, genres, currentType: 'vhs' });
    } catch (err) {
        console.error(err);
        res.redirect('/collection');
    }
});

// Search TMDb by title, or resolve a pasted TMDb/IMDb URL / IMDb ID directly
router.post('/search-tmdb', requireAuth, requireAdmin, async (req, res) => {
    const query = (req.body.query || '').trim();
    const key = tmdbKey();
    const language = tmdbLang(res.locals.currentLng);

    try {
        let directId = null;

        const tmdbUrlMatch = query.match(/themoviedb\.org\/movie\/(\d+)/);
        const imdbMatch = query.match(/^(tt\d+)$/) || query.match(/imdb\.com\/title\/(tt\d+)/);

        if (tmdbUrlMatch) {
            directId = tmdbUrlMatch[1];
        } else if (imdbMatch) {
            const found = await tmdbGet(`/find/${imdbMatch[1]}`, key, { external_source: 'imdb_id' });
            if (found.movie_results && found.movie_results.length > 0) {
                directId = found.movie_results[0].id;
            }
        }

        let results = [];

        if (directId) {
            const movie = await tmdbGet(`/movie/${directId}`, key, { language });
            results = [{
                id: movie.id,
                title: movie.title,
                year: movie.release_date ? movie.release_date.slice(0, 4) : '',
                cover_image: posterUrl(movie.poster_path),
                overview: movie.overview
            }];
        } else if (query) {
            const data = await tmdbGet('/search/movie', key, { query, language, include_adult: false });
            results = (data.results || []).slice(0, 40).map(m => ({
                id: m.id,
                title: m.title,
                year: m.release_date ? m.release_date.slice(0, 4) : '',
                cover_image: posterUrl(m.poster_path),
                overview: m.overview
            }));
        }

        res.render('add-vhs', {
            results,
            searchQuery: query,
            user: res.locals.user,
            currentType: 'add-vhs'
        });
    } catch (err) {
        console.error(`❌ TMDb search error:`, err.message);
        res.render('add-vhs', { results: [], error: req.t('errors.api_error'), searchQuery: query, user: res.locals.user, currentType: 'add-vhs' });
    }
});

// Confirmation page with full TMDb details (credits, cast, certification)
router.get('/confirm-vhs/:id', requireAuth, async (req, res) => {
    const tmdbId = req.params.id;
    const key = tmdbKey();
    const language = tmdbLang(res.locals.currentLng);

    try {
        const data = await tmdbGet(`/movie/${tmdbId}`, key, {
            language,
            append_to_response: 'credits,external_ids,release_dates,videos'
        });

        const mapped = mapTmdbMovie(data, res.locals.currentLng);

        const adminId = await getAdminId();
        const locations = await Item.distinct('location', { owner: adminId, location: { $ne: "" } });
        const genres = await Item.distinct('genre', { owner: adminId, kind: 'VHS', genre: { $ne: "" } });

        res.render('confirm-vhs', { tape: mapped, user: res.locals.user, locations, genres, currentType: 'vhs' });
    } catch (err) {
        console.error(`❌ TMDb movie details error for ID ${tmdbId}:`, err.message);
        res.render('add-vhs', {
            results: [],
            error: `${req.t('errors.api_error')} (TMDb HTTP ${err.response ? err.response.status : '500'})`,
            searchQuery: '',
            user: res.locals.user,
            currentType: 'add-vhs'
        });
    }
});

// Save handler: smart create or update logic
router.post('/save-vhs', requireAuth, requireAdmin, async (req, res) => {
    try {
        const {
            mongo_id, title, director, year, distributor, catalog_number, cassette_number, country,
            format_type, cover_image, user_image, backdrop_image, overview, tagline,
            tmdb_id, imdb_id, trailer_key, runtime, age_rating, region, condition,
            in_wishlist, comments, location, genre, quantity,
            genres, barcode, barcode_locked, added_at,
            is_original, estimated_value, estimated_currency, cast_json
        } = req.body;

        const parsedGenres = Array.isArray(genres) ? genres : (genres ? genres.split(',').map(g => g.trim()).filter(Boolean) : []);

        const adminId = req.user._id;
        const isWishlist = in_wishlist === 'true';
        const isBarcodeLocked = barcode_locked === 'on' || barcode_locked === 'true' || barcode_locked === true;
        const isOriginal = is_original === 'true' || is_original === true || is_original === 'on';

        let cast = [];
        if (cast_json) {
            try { cast = JSON.parse(cast_json); } catch (e) { cast = []; }
        }

        let tape;

        if (mongo_id) {
            tape = await Item.findById(mongo_id);
        }

        if (!tape && tmdb_id) {
            tape = await Item.findOne({ tmdb_id: tmdb_id, owner: adminId });
        }

        const priceValue = estimated_value !== undefined && estimated_value !== '' ? parseFloat(estimated_value) : null;

        const sharedData = {
            title,
            director: director || '',
            tmdb_id: tmdb_id || undefined,
            imdb_id: imdb_id || '',
            trailer_key: trailer_key || '',
            year,
            distributor: distributor || '',
            catalog_number: catalog_number || '',
            cassette_number: (cassette_number || '').trim(),
            format_type: format_type || 'VHS',
            condition: condition || '',
            region: region || '',
            age_rating: age_rating || '',
            runtime: runtime ? parseInt(runtime) : null,
            overview: overview || '',
            tagline: tagline || '',
            backdrop_image: backdrop_image || '',
            cast,
            cover_image,
            user_image,
            is_original: isOriginal,
            'estimated_price.value': isOriginal ? priceValue : null,
            'estimated_price.currency': isOriginal && priceValue !== null ? (estimated_currency || res.locals.user.currency || 'EUR') : null,
            'estimated_price.source': isOriginal && priceValue !== null ? 'manual' : null,
            'estimated_price.updated_at': isOriginal && priceValue !== null ? new Date() : null,
            in_wishlist: isWishlist,
            media_type: 'vhs',
            comments: comments || '',
            location: location || '',
            genre: genre || (parsedGenres.length > 0 ? parsedGenres[0] : ''),
            genres: parsedGenres,
            quantity: parseInt(quantity) || 1,
            country: country || '',
            barcode: barcode || '',
            barcode_locked: isBarcodeLocked,
            kind: 'VHS'
        };

        if (tape) {
            sharedData.added_at = added_at ? new Date(added_at) : (tape.added_at || new Date());

            if (user_image && user_image.length > 0) {
                sharedData.user_image = user_image;
            }

            await Item.updateOne(
                { _id: tape._id },
                { $set: sharedData },
                { strict: false }
            );
        } else {
            sharedData.owner = adminId;
            sharedData.added_at = added_at ? new Date(added_at) : new Date();
            await VHS.create(sharedData);
        }

        if (isWishlist) {
            res.redirect('/wishlist');
        } else {
            res.redirect('/collection');
        }

    } catch (err) {
        console.error("Save error:", err);
        res.status(500).send(req.t('errors.generic_server_error'));
    }
});

// API route to move a tape from wishlist to collection
router.post('/api/vhs/:id/move-to-collection', requireAuth, requireAdmin, async (req, res) => {
    try {
        await Item.findByIdAndUpdate(req.params.id, { in_wishlist: false, added_at: new Date() });
        res.json({ success: true });
    } catch (err) {
        res.status(500).send(req.t('errors.generic_server_error'));
    }
});

// Duplicate check
router.get('/api/check-duplicate', requireAuth, async (req, res) => {
    try {
        const { title, director, excludeId, cassette_number } = req.query;
        if (!title) return res.json({ duplicate: false });

        const adminId = await getAdminId();

        const escReg = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const titleReg = new RegExp(`^${escReg(title.trim())}$`, 'i');

        // Same title but a different cassette_number means a different physical
        // tape, not a duplicate entry - only flag it when both title and
        // cassette_number match (including both being empty/unassigned).
        const cassetteReg = new RegExp(`^${escReg((cassette_number || '').trim())}$`, 'i');

        const query = { owner: adminId, kind: 'VHS', title: titleReg, cassette_number: cassetteReg };
        if (director) query.director = new RegExp(`^${escReg(director.trim())}$`, 'i');
        if (excludeId) query._id = { $ne: excludeId };

        const matches = await Item.find(query).lean();
        if (!matches.length) return res.json({ duplicate: false });

        res.json({
            duplicate: true,
            matches: matches.map(formatForView)
        });
    } catch (err) {
        console.error(err);
        res.json({ duplicate: false });
    }
});

// Detects when a cassette_number is already used by a DIFFERENT title.
// This is intentionally allowed (several films can share one physical tape),
// but two independently-numbered collections can also collide by coincidence -
// the frontend asks the user which case it is before saving.
router.get('/api/check-cassette-number', requireAuth, async (req, res) => {
    try {
        const { cassette_number, excludeId } = req.query;
        const val = (cassette_number || '').trim();
        if (!val) return res.json({ taken: false });

        const adminId = await getAdminId();
        const escReg = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        // Match the base number AND any "-N" suffix variants already created for it,
        // so a collision offers every existing physical tape in the family, not just the base.
        const familyReg = new RegExp(`^${escReg(val)}(-\\d+)?$`, 'i');
        const query = { owner: adminId, kind: 'VHS', cassette_number: familyReg };
        if (excludeId) query._id = { $ne: excludeId };

        const matches = await Item.find(query).select('title cassette_number').lean();
        if (!matches.length) return res.json({ taken: false });

        const groupsByKey = {};
        matches.forEach(m => {
            const key = m.cassette_number.toLowerCase();
            if (!groupsByKey[key]) groupsByKey[key] = { number: m.cassette_number, titles: [] };
            groupsByKey[key].titles.push(m.title);
        });
        const groups = Object.values(groupsByKey).sort((a, b) =>
            a.number.localeCompare(b.number, undefined, { numeric: true })
        );

        const suffixReg = new RegExp(`^${escReg(val)}-(\\d+)$`, 'i');
        let maxSuffix = 1;
        matches.forEach(m => {
            const s = m.cassette_number.match(suffixReg);
            if (s) maxSuffix = Math.max(maxSuffix, parseInt(s[1], 10));
        });

        res.json({
            taken: true,
            groups,
            suggestion: `${val}-${maxSuffix + 1}`
        });
    } catch (err) {
        console.error(err);
        res.json({ taken: false });
    }
});

// Increment quantity of existing tape (used after duplicate confirmation)
router.post('/api/increment-quantity/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        const adminId = await getAdminId();
        const tape = await Item.findOne({ _id: req.params.id, owner: adminId });
        if (!tape) return res.status(404).json({ success: false });

        const newQty = (tape.quantity || 1) + 1;
        await Item.updateOne({ _id: tape._id }, { $set: { quantity: newQty } });

        res.json({ success: true, quantity: newQty, redirectUrl: `/vhs/${tape._id}` });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false });
    }
});

// Rough price estimate from active eBay listings (asking prices, not sales data -
// see the "estimate price" button on the detail page for the caveat shown to the user).
router.post('/api/vhs/:id/estimate-price', requireAuth, requireAdmin, async (req, res) => {
    try {
        if (!process.env.EBAY_APP_ID || !process.env.EBAY_CERT_ID) {
            return res.status(400).json({ success: false, error: 'not_configured' });
        }

        const adminId = await getAdminId();
        const tape = await Item.findOne({ _id: req.params.id, owner: adminId });
        if (!tape) return res.status(404).json({ success: false });

        const result = await ebaySearchPrices(`${tape.title} VHS`);
        if (!result || !result.count) {
            return res.json({ success: false, error: 'no_results' });
        }

        await Item.updateOne({ _id: tape._id }, {
            $set: {
                'estimated_price.value': result.median,
                'estimated_price.currency': result.currency,
                'estimated_price.source': 'ebay_estimate',
                'estimated_price.updated_at': new Date()
            }
        }, { strict: false });

        res.json({ success: true, ...result });
    } catch (err) {
        console.error('[eBay estimate] error:', err.message);
        res.status(500).json({ success: false, error: 'api_error' });
    }
});

// Print routes
router.get('/print/collection', requireAuth, async (req, res) => {
    try {
        const adminId = await getAdminId();
        const items = await Item.find({ owner: adminId, in_wishlist: false, kind: 'VHS' })
            .sort({ title: 1 })
            .lean();
        res.render('print', {
            tapes: items.map(formatForView),
            title: req.t('collection.title'),
            printDate: new Date().toLocaleDateString(res.locals.currentLng === 'de' ? 'de-DE' : 'en-US')
        });
    } catch (err) {
        res.status(500).send(req.t('errors.generic_server_error'));
    }
});

router.get('/print/wishlist', requireAuth, async (req, res) => {
    try {
        const adminId = await getAdminId();
        const items = await Item.find({ owner: adminId, in_wishlist: true, kind: 'VHS' })
            .sort({ title: 1 })
            .lean();
        res.render('print', {
            tapes: items.map(formatForView),
            title: req.t('wishlist.title'),
            printDate: new Date().toLocaleDateString(res.locals.currentLng === 'de' ? 'de-DE' : 'en-US')
        });
    } catch (err) {
        res.status(500).send(req.t('errors.generic_server_error'));
    }
});

router.get('/wishlist', requireAuth, async (req, res) => {
    try {
        const adminId = await getAdminId();
        const { search, location, genre, original } = req.query;
        let sort = req.query.sort;
        if (sort) {
            res.cookie('wishlistSortPref', sort, { maxAge: 365 * 24 * 60 * 60 * 1000 });
        } else {
            sort = req.cookies.wishlistSortPref || 'added_desc';
        }

        let query = { owner: adminId, in_wishlist: true, kind: 'VHS' };
        let conditions = [];

        if (search) {
            const regex = new RegExp(escapeRegExp(search), 'i');
            conditions.push({
                $or: [{ title: regex }, { director: regex }, { barcode: regex }, { 'cast.name': regex }]
            });
        }

        if (location) {
            conditions.push({ location });
        }

        if (genre) {
            const genreArr = genre.split(',').map(g => g.trim()).filter(Boolean);
            if (genreArr.length > 0) {
                conditions.push({
                    $or: [
                        { genre: { $in: genreArr.map(g => new RegExp(escapeRegExp(g), 'i')) } },
                        { genres: { $in: genreArr.map(g => new RegExp(escapeRegExp(g), 'i')) } }
                    ]
                });
            }
        }

        if (original === 'original') {
            conditions.push({ is_original: { $ne: false } });
        } else if (original === 'recording') {
            conditions.push({ is_original: false });
        }

        const filterMode = req.query.filterMode || 'show';
        if (filterMode === 'hide' && conditions.length > 0) {
            query.$and = [{ $nor: [{ $and: conditions }] }];
        } else if (conditions.length > 0) {
            query.$and = conditions;
        }

        applyVisibilityFilter(query, res.locals.isAdmin, res.locals.settings);

        const buildSortObj = () => {
            const sortMap = {
                'added_desc': { added_at: -1 },
                'added_asc': { added_at: 1 },
                'title_asc': { title: 1 },
                'title_desc': { title: -1 },
                'year_desc': { year: -1 },
                'year_asc': { year: 1 },
                'value_desc': { 'estimated_price.value': -1 },
                'value_asc': { 'estimated_price.value': 1 },
                'cassette_asc': { cassette_number: 1 },
                'cassette_desc': { cassette_number: -1 },
            };
            return sortMap[sort] || { added_at: -1 };
        };

        const items = await Item.find(query).sort(buildSortObj()).lean();

        res.render('wishlist', {
            tapes: items.map(formatForView),
            user: res.locals.user,
            querySearch: search || '',
            queryLocation: location || '',
            queryGenre: genre || '',
            queryOriginal: original || '',
            queryFilterMode: filterMode,
            currentSort: sort,

            locations: await Item.distinct('location', { owner: adminId, kind: 'VHS', in_wishlist: true }),
            genres: await (async () => {
                const [gBase, gArray] = await Promise.all([
                    Item.distinct('genre', { owner: adminId, kind: 'VHS', in_wishlist: true, genre: { $nin: ['', null] } }),
                    Item.distinct('genres', { owner: adminId, kind: 'VHS', in_wishlist: true })
                ]);
                return [...new Set([...gBase, ...gArray])].filter(Boolean).sort();
            })()
        });
    } catch (err) {
        console.error(err);
        res.status(500).send(req.t('errors.generic_server_error'));
    }
});

// collection item detail
router.get('/vhs/:id', requireAuth, async (req, res) => {
    try {
        const tape = await Item.findById(req.params.id);
        if (!tape) return res.redirect('/collection');
        const tapeFormatted = formatForView(tape);
        const ebayEnabled = !!(process.env.EBAY_APP_ID && process.env.EBAY_CERT_ID);

        res.render('vhs-detail', { tape: tapeFormatted, user: res.locals.user, currentType: 'vhs', ebayEnabled });
    } catch (err) {
        res.redirect('/collection');
    }
});

// Delete route (API)
router.delete('/api/vhs/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        const tape = await Item.findOne({ _id: req.params.id, owner: res.locals.user._id });

        if (!tape) {
            return res.status(404).json({ error: "Tape not found or you are not the owner." });
        }

        await Item.deleteOne({ _id: req.params.id });

        res.json({ success: true, redirectUrl: `/collection` });

    } catch (err) {
        console.error(err);
        res.status(500).send(req.t('errors.generic_server_error'));
    }
});

// Refresh metadata (genres, cast, overview, backdrop, certification) from TMDb
router.post('/api/vhs/:id/refresh-info', requireAuth, requireAdmin, async (req, res) => {
    const tapeId = req.params.id;
    const { tmdbId } = req.body;
    const key = tmdbKey();
    const language = tmdbLang(res.locals.currentLng);

    if (!tmdbId) {
        return res.status(400).json({ success: false, error: "TMDb ID missing" });
    }

    try {
        const data = await tmdbGet(`/movie/${tmdbId}`, key, {
            language,
            append_to_response: 'credits,external_ids,release_dates,videos'
        });
        const mapped = mapTmdbMovie(data, res.locals.currentLng);

        const updateData = {
            genres: mapped.genres,
            director: mapped.director,
            cast: mapped.cast,
            overview: mapped.overview,
            tagline: mapped.tagline,
            backdrop_image: mapped.backdrop_image,
            runtime: mapped.runtime,
            age_rating: mapped.age_rating,
            imdb_id: mapped.imdb_id,
            trailer_key: mapped.trailer_key
        };

        const currentTape = await Item.findById(tapeId);

        if (currentTape && (!currentTape.genre || currentTape.genre === '') && mapped.genres.length > 0) {
            updateData.genre = mapped.genres[0];
        }

        await Item.findByIdAndUpdate(tapeId, { $set: updateData }, { strict: false });

        res.json({ success: true, genres: updateData.genres, cast: updateData.cast });
    } catch (err) {
        console.error("Refresh info error:", err);
        res.status(500).json({ success: false, error: req.t('detail.refresh_info_error') });
    }
});

function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = router;
