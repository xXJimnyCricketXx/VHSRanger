<div align="center">

<img src="docs/img/vhsranger-banner.png" alt="VHSRanger!" width="100%">

<br/><br/>

# VHSRanger!

### A self-hosted collection manager for VHS tape enthusiasts

Catalog your tapes with metadata from TMDb, keep track of where each one lives,
and see what your collection is made of. Your data stays on your own server.

<p>
  <img src="https://img.shields.io/badge/Status-Beta-3DC6D0?style=for-the-badge" alt="Status">
  <img src="https://img.shields.io/badge/Docker-Ready-3DC6D0?style=for-the-badge&logo=docker&logoColor=white" alt="Docker">
  <img src="https://img.shields.io/badge/Unraid-Template-3DC6D0?style=for-the-badge&logo=unraid&logoColor=white" alt="Unraid">
</p>

**[Overview](#-overview)** ·
**[Features](#-features)** ·
**[Getting Started](#-getting-started)** ·
**[Unraid](#-unraid)** ·
**[Configuration](#-configuration)** ·
**[Roadmap](#-roadmap)**

</div>

<br/><br/>

## <img src="https://api.iconify.design/lucide/book-open.svg?color=%233DC6D0" width="20"> Overview

**VHSRanger!** keeps track of your VHS tape collection. It uses the TMDb API to fetch metadata, covers
and cast information, and presents everything in a customizable dashboard on your home server.

Each tape can be flagged as an **original** retail release or a **home recording**, and only originals
carry a value estimate. Several films can share one cassette number, so the statistics can tell films
apart from physical tapes.

<br/><br/>

## <img src="https://api.iconify.design/lucide/sparkles.svg?color=%233DC6D0" width="20"> Features

- **Smart import** – Add tapes by searching TMDb, pasting a TMDb or IMDb link, scanning a barcode, or entering them manually.
- **Duplicate detection** – Flags matching entries when you add a tape you may already own, so you can bump the quantity instead.
- **Cassette numbers** – Number your physical tapes, record several films on one cassette, and get a warning when a number is already taken.
- **Original or home recording** – Every tape is flagged as a retail release or a self-recorded copy. Value estimates only apply to originals.
- **Price estimates** – Enter a value yourself or get a rough estimate from active eBay listings (optional, requires eBay API keys).
- **Organization** – Track the shelf location and condition of every tape, then search, filter and sort by them.
- **Statistics** – A statistics page with genres, conditions, release years and your most valuable tapes, plus modular dashboard widgets.
- **Wishlist** – Keep track of future finds and move them into your collection once you have them.
- **Print and PDF** – Export your collection or wishlist as a printable list.
- **User accounts** – Create read-only accounts for other people, and hide specific tapes, genres or types from them.
- **Backups** – Manual and scheduled backups with adjustable retention, plus restore.
- **Color themes** – 8 built-in themes, each with a light and a dark mode.
- **Five languages** – English, German, French, Spanish and Italian, switchable per account.

<br/><br/>

## <img src="https://api.iconify.design/lucide/layers-3.svg?color=%233DC6D0" width="20"> Tech Stack

| **Area** | **Technology** | **Purpose** |
| :--- | :--- | :--- |
| **Backend** | <img src="https://go-skill-icons.vercel.app/api/icons?i=nodejs,express&theme=dark" valign="middle" /> | Express with JWT login and bcrypt password hashes |
| **Frontend** | <img src="https://go-skill-icons.vercel.app/api/icons?i=html,tailwind,js&theme=dark" valign="middle" /> | EJS templates, Tailwind CSS and plain JavaScript |
| **Database** | <img src="https://go-skill-icons.vercel.app/api/icons?i=mongodb&theme=dark" valign="middle" /> | MongoDB, accessed through Mongoose |
| **Localization** | i18next | Translations for five languages |
| **External APIs** | TMDb, eBay Browse API | Film metadata and optional price estimates |
| **Container** | <img src="https://go-skill-icons.vercel.app/api/icons?i=docker&theme=dark" valign="middle" /> | Image published to GHCR via GitHub Actions |

<br/><br/>

## <img src="https://api.iconify.design/lucide/rocket.svg?color=%233DC6D0" width="20"> Getting Started

### Prerequisites

- Docker with Compose

### Installation

```bash
git clone https://github.com/xXJimnyCricketXx/VHSRanger.git
cd VHSRanger
cp .env.example .env
# edit .env and set at least PASSJWT and SESSION_SECRET
docker compose up -d --build
```

The app is now available at:

```text
http://localhost:18003
```

On the first visit, create your admin account on the setup page.

### Further guides

- [Docker deployment](docs/docker.md) – Pre-built image, troubleshooting and updates
- [Manual setup](docs/getting-started.md) – Running the app with Node.js and your own MongoDB
- [API configuration](docs/api-keys.md) – Getting your TMDb key

<br/><br/>

## <img src="https://api.iconify.design/lucide/container.svg?color=%233DC6D0" width="20"> Unraid

The image is built by GitHub Actions on every push to `main` and on `v*` tags
([docker-publish.yml](.github/workflows/docker-publish.yml)):

```text
ghcr.io/xxjimnycricketxx/vhsranger:latest
```

**1. Install MongoDB.** Any MongoDB template works. Note its IP or hostname.

**2. Install the template.** On the Unraid console:

```bash
curl -fsSL -o /boot/config/plugins/dockerMan/templates-user/my-VHSRanger.xml https://raw.githubusercontent.com/xXJimnyCricketXx/VHSRanger/main/unraid-template/vhsranger.xml
```

**3. Create the container.** Go to *Docker → Add Container → Template: VHSRanger*.

Port `18003` and the appdata paths under `/mnt/user/appdata/vhsranger` are pre-filled. Set `MongoDB URL`, `JWT Password` and `Session Secret`, and optionally your TMDb key.

**Updates:** *Docker → Check for Updates*, then apply the update for VHSRanger.

<br/><br/>

## <img src="https://api.iconify.design/lucide/settings.svg?color=%233DC6D0" width="20"> Configuration

All settings are environment variables: `.env` for Docker Compose, template variables on Unraid.

| Variable | Required | Default | Description |
| --- | :---: | --- | --- |
| `MONGODB_URL` | ✅ | – | Connection string for your MongoDB instance. The Compose setup uses `mongodb://mongodb:27017/vhsranger` |
| `PASSJWT` | ✅ | – | Long random secret that signs login tokens |
| `SESSION_SECRET` | ✅ | – | Long random secret for sessions, different from `PASSJWT` |
| `PROD` | ❌ | `false` | Set to `true` **only** when serving over HTTPS through a reverse proxy, otherwise login cookies stop working. Without it, the app sees the proxy's IP for every visitor, so login limits and IP blocks apply to all of them together |
| `VHS_PORT` | ❌ | `3098` | Port the app listens on inside the container |
| `BASE_URL` | ❌ | empty | Base path for serving on a sub-path, leave empty to serve from root |
| `TMDB_API_KEY` | ❌ | empty | TMDb **API Read Access Token**. The app works without it, but metadata lookup does not |
| `EBAY_APP_ID` / `EBAY_CERT_ID` | ❌ | empty | eBay Browse API production keys from [developer.ebay.com](https://developer.ebay.com). Enable the price estimate button on the detail page |

> [!IMPORTANT]
> Backups are stored in the `backups` folder on the same disk as the app and contain your account data,
> including password hashes. Copy them to another disk and keep them private.

> [!WARNING]
> The app itself speaks plain HTTP. Keep it inside your home network, and use a VPN or an HTTPS reverse
> proxy for access from outside.

<br/><br/>

## <img src="https://api.iconify.design/lucide/folder-tree.svg?color=%233DC6D0" width="20"> Project Structure

```text
VHSRanger/
├── config/              # database connection, constants, built-in themes
├── controllers/         # login and logout handlers
├── routes/              # Express routes
├── middleware/          # login protection and settings
├── models/              # Mongoose schemas
├── utils/               # backups, migrations, visibility and currency helpers
├── views/               # EJS templates
├── locales/             # translations
├── public/              # logos, icons and stylesheet
├── public-tpl/          # web app manifest and service worker templates
├── docs/                # guides and images
├── unraid-template/
├── .github/workflows/
│   └── docker-publish.yml
├── app.js
├── Dockerfile
├── docker-compose.yml
└── .env.example
```

<br/><br/>

## <img src="https://api.iconify.design/lucide/map.svg?color=%233DC6D0" width="20"> Roadmap

| **Version** | **Features** | **Status** |
| :---: | :--- | :---: |
| **1.1.0** | <ul><li>Automated test suite that runs before every image build</li><li>Container without root rights on a current Node.js LTS</li><li>Frontend libraries served from the app instead of external CDNs</li><li>Changelog</li></ul> | <img src="https://img.shields.io/badge/Planned-6E7681?style=for-the-badge" alt="Planned"> |
| **1.0.1** | <ul><li>Bug fixes for first login, admin tools and status messages</li><li>Natural sorting of titles and cassette numbers</li><li>Totals that respect different currencies</li></ul> | <img src="https://img.shields.io/badge/Planned-6E7681?style=for-the-badge" alt="Planned"> |
| **1.0.0** | <ul><li>First tagged release with versioned Docker images</li><li>Security hardening</li><li>Safer editing and backup restore</li></ul> | <img src="https://img.shields.io/badge/Planned-6E7681?style=for-the-badge" alt="Planned"> |

See the [open issues](../../issues) for planned features and known problems.

<br/><br/>

## <img src="https://api.iconify.design/lucide/code-2.svg?color=%233DC6D0" width="20"> Development

Run the app locally against your own MongoDB. Set `MONGODB_URL` in `.env` to point at it first:

```bash
npm install
cp .env.example .env
npm run dev
```

The app is then available at `http://localhost:3098`.

<br/><br/>

## <img src="https://api.iconify.design/lucide/git-pull-request.svg?color=%233DC6D0" width="20"> Contributing

Issues and pull requests are welcome. Please open an issue first for larger changes.

<br/><br/>

## <img src="https://api.iconify.design/lucide/scale.svg?color=%233DC6D0" width="20"> License

This project is licensed under the **MIT License**.

See [`LICENSE`](LICENSE) for details.

<br/><br/>

---

<br>

<div align="center">

<a href="https://github.com/xXJimnyCricketXx">
  <img src="https://img.shields.io/badge/GitHub-271B48?style=for-the-badge&logo=github&logoColor=white" alt="GitHub">
</a>
<a href="https://cricketcode.de">
  <img src="https://img.shields.io/badge/Website-271B48?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Website">
</a>

</div>
