# 🔑 API Configuration

VHSRanger relies on the TMDb (The Movie Database) API to fetch film metadata, covers, and cast information.
> You can get this key for **free**.

## 🎬 TMDb API (Recommended)

*Used for fetching film metadata, covers/backdrops, and cast & crew. The app works without it, but you'll only be able to add tapes manually.*

1.  Create a free account on [themoviedb.org](https://www.themoviedb.org/).
2.  Go to **Settings > API**.
3.  Request an **API Key** (choose "Developer" use).
4.  Copy the **API Read Access Token** and paste it into your `.env` file as `TMDB_API_KEY`.

## 💰 eBay Browse API (Optional)

*Used only for the "Estimate price" button on the detail page. The app works without it.*

1.  Create a free account on [developer.ebay.com](https://developer.ebay.com).
2.  Create a **production** keyset for your application.
3.  Paste the **App ID** and the **Cert ID** into your `.env` file as `EBAY_APP_ID` and `EBAY_CERT_ID`.

---

⚠️ **Security Note:** Never commit your `.env` file to GitHub. It contains sensitive credentials that should remain private.

[← Back to README](../README.md)  
