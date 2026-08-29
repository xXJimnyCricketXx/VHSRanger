module.exports = {
  BASE_URL: process.env.BASE_URL
    ? (process.env.BASE_URL.startsWith('/') ? process.env.BASE_URL : `/${process.env.BASE_URL}`)
    : '',
  TMDB_LANG_MAP: {
    fr: "fr-FR",
    en: "en-US",
    es: "es-ES",
    it: "it-IT",
    de: "de-DE"
  },
  TMDB_COUNTRY_MAP: {
    fr: "FR",
    en: "US",
    es: "ES",
    it: "IT",
    de: "DE"
  },
  VHS_CONDITIONS: ['sealed', 'mint', 'good', 'fair', 'poor']
};
