# 🐳 Docker Deployment

The recommended way to run VHSRanger is using Docker. You have two options depending on your needs.

## Option 1: Using Pre-built Image (Recommended)

Best for: Most users who just want to run the app. No need to clone the full repository or install Node.js.

### 1. Setup

Create a new folder and a `docker-compose.yml` file with this content:

```yaml
services:
  vhsranger-app:
    image: ghcr.io/xxjimnycricketxx/vhsranger:latest
    container_name: vhsranger_app
    restart: unless-stopped
    ports:
      - "18003:3098"
    volumes:
      - ./public/uploads:/app/public/uploads
      - ./backups:/app/backups
    env_file:
      - .env
    depends_on:
      - mongodb

  mongodb:
    image: mongo:8
    container_name: vhsranger_db
    restart: unless-stopped
    volumes:
      - ./mongo_data:/data/db
```

If you are struggling with the deployment, you can try this config:

```yaml
services:
  vhsranger-app:
    image: ghcr.io/xxjimnycricketxx/vhsranger:latest
    pull_policy: missing
    container_name: vhsranger_app
    restart: unless-stopped
    depends_on:
      - mongodb
    environment:
      - MONGODB_URL=mongodb://mongodb:27017/vhsranger
      - VHS_PORT=80
      - BASE_URL=
      - PROD=false
      - PASSJWT=<something>
      - PUID=1000
      - PGID=1000
      - TZ=Europe/Berlin
      - TMDB_API_KEY=<something>
      - EBAY_APP_ID=<something>
      - EBAY_CERT_ID=<something>
    ports:
      - '<external_port>:80'
    volumes:
      - /mnt/<uploads_dataset>:/app/public/uploads
      - /mnt/<backups_dataset>:/app/backups

  mongodb:
    image: mongo:8
    pull_policy: missing
    container_name: vhsranger_db
    restart: unless-stopped
    volumes:
      - /mnt/<mongo_dataset>:/data/db
```

> Note: If you're using a **Raspberry Pi** and MongoDB keeps restarting, try a different version of MongoDB, such as:
> ```yaml
> mongodb:
>   image: mongo:4.4.18
> ```

> Note: If MongoDB exits with `Linux kernel versions 6.19 and newer has a known incompatibility`, your host kernel is too new for the current `mongo:8` image. This can happen on Ubuntu 26.04, for example. Use `mongo:8.2` instead. A database that already ran on a newer version may not open with an older one, so export a backup first and restore it after switching if needed.

### 2. Prepare Environment

If you don't use `environment` in your conf file, ensure you have a `.env` file in the root directory.  
In both cases, you can use the provided `.env.example` as a starting point.

[Get your API keys here.](./api-keys.md)

### 3. Launch

```bash
docker compose up -d
```

## Option 2: Build from Source

Best for: Developers or those who want to customize the code.

1. **Clone the repo**: `git clone https://github.com/xXJimnyCricketXx/VHSRanger.git`
2. **Make your `.env` file** using `.env.example` and [api keys page](./api-keys.md).
3. **Build and start**:

```bash
docker compose up --build -d
```

## Option 3: Unraid

Best for: Unraid users. VHSRanger isn't (yet) listed in Community Applications, but you can add it manually:

1. Install a MongoDB container first (any MongoDB template works), and note its container IP or hostname.
2. On the Unraid console, save the template under the name Unraid itself uses for this container:
   ```bash
   curl -fsSL -o /boot/config/plugins/dockerMan/templates-user/my-VHSRanger.xml https://raw.githubusercontent.com/xXJimnyCricketXx/VHSRanger/main/unraid-template/vhsranger.xml
   ```
3. Go to **Docker → Add Container → Template: VHSRanger**.
4. All fields (port, paths, variables) will auto-fill. Adjust the `MongoDB URL`, `JWT Password` and `TMDb API Key` fields, then click **Apply**.

> **Installed before 1.1.1?** An older install may have left a second template named `vhsranger.xml`. Unraid can then rebuild the container from that file on updates and drop variables added later. Move it out of the way once:
>
> ```bash
> mv /boot/config/plugins/dockerMan/templates-user/vhsranger.xml /boot/config/plugins/dockerMan/vhsranger.xml.bak
> ```
>
> Then add `PUID=99` and `PGID=100` to your container, remove `SESSION_SECRET`, and make sure `JWT Password` is your own random value.

## 🔒 Database Access

The examples above run MongoDB without a login. That is fine as long as only VHSRanger can reach it. If its port is reachable on your network, anyone there can read the database, including password hashes, so don't publish the port or [enable MongoDB authentication](https://www.mongodb.com/docs/manual/tutorial/configure-scram-client-authentication/) and put the credentials into `MONGODB_URL`.

## 🔄 Updating

### Updating (Pre-built Image)

If you are using the GHCR image (Option 1):

```bash
docker compose pull
docker compose up -d
```

### Updating (Manual Build)

If you cloned the repository (Option 2):

```bash
git pull
docker compose up --build -d
```


## 💾 Persistence

By default, the database data is stored in a Docker volume named mongo-data. This ensures your collection is not lost when you stop or update the containers.

## 🗑️ Full reset & Data loss

If you have made significant changes and need to rebuild the application from a clean slate, follow the steps below.

> [!IMPORTANT]
> This procedure will permanently delete all local data. If you have data you wish to keep, export your database before proceeding.

```bash
# Stop containers and remove volumes (-v)
sudo docker compose down -v

# Delete local database files
sudo rm -rf ./mongo_data

# Rebuild and restart the services
sudo docker compose up -d
```

[← Back to README](../README.md)  
[Get your API keys →](./api-keys.md)
