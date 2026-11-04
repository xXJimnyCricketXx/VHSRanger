// Preloaded into the app under test: answers calls to TMDb and the exchange rate
// API, so the tests need no network and always see the same data.
const axios = require('axios');

const MOVIE = {
    id: 947,
    title: 'Lawrence of Arabia',
    overview: 'Text',
    release_date: '1962-12-11',
    runtime: 222,
    genres: [{ name: 'Drama' }],
    credits: {
        cast: [{ name: "Peter O'Toole", character: 'T. E. "Lawrence"', profile_path: null }],
        crew: [{ job: 'Director', name: 'David Lean' }]
    },
    external_ids: { imdb_id: 'tt0056172' },
    release_dates: { results: [] },
    videos: { results: [] }
};

const realGet = axios.get.bind(axios);
axios.get = (url, config) => {
    if (url.includes('api.frankfurter.dev')) {
        if (config.params.base === 'USD') return Promise.resolve({ data: { rates: { EUR: 0.5 } } });
        return Promise.reject(new Error('unknown currency'));
    }
    if (url.includes('api.themoviedb.org')) {
        if (url.includes('/movie/947')) return Promise.resolve({ data: MOVIE });
        return Promise.reject(new Error('unknown movie'));
    }
    return realGet(url, config);
};
