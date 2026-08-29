# 🔑 API Configuration

VHSRanger relies on the TMDb (The Movie Database) API to fetch film metadata, covers, and cast information.
> You can get this key for **free**.

## 🎬 TMDb API (Recommended)

*Used for fetching film metadata, covers/backdrops, and cast & crew. The app works without it, but you'll only be able to add tapes manually.*

1.  Create a free account on [themoviedb.org](https://www.themoviedb.org/).
2.  Go to **Settings > API**.
3.  Request an **API Key** (choose "Developer" use).
4.  Copy the **API Read Access Token** (or the v3 API key) and paste it into your `.env` file as `TMDB_API_KEY`.

---

⚠️ **Security Note:** Never commit your `.env` file to GitHub. It contains sensitive credentials that should remain private.

[← Back to README](../README.md)  
