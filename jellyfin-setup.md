# Step 1: Jellyfin

Run inside the Linux VM.

## Prepare folders

```bash
sudo mkdir -p /data/media/movies /data/media/tv
sudo chown -R 1000:1000 /data
```

Use your VM user's IDs (`id -u` and `id -g`) if they aren't `1000`.

## docker-compose.yml

```yaml
services:
  jellyfin:
    image: jellyfin/jellyfin:10.11.11   # pinned; check github.com/jellyfin/jellyfin/releases for newer
    container_name: jellyfin
    user: "1000:1000"                   # match the owner of /data
    ports:
      - "8096:8096"                     # web UI, for now; later only the server API is published
    volumes:
      - ./config/jellyfin:/config
      - ./cache/jellyfin:/cache
      - /data:/data                     # same /data path Sonarr and Radarr will use later
    restart: unless-stopped
```

## Start it

```bash
docker compose up -d
```

## Add a test file

Download Big Buck Bunny from Blender's site and place it at:

```
/data/media/movies/Big Buck Bunny (2008)/Big Buck Bunny (2008).mp4
```

The `Title (Year)` naming is what Jellyfin uses to match metadata.

## Setup wizard

1. Open `http://<vm-ip>:8096`.
2. Create an admin user.
3. Add a Movies library pointing at `/data/media/movies`.
4. Confirm the poster and description appear and the movie plays.

## Test the API

In Dashboard → API Keys, create a key, then from your dev machine:

```bash
curl -H "Authorization: MediaBrowser Token=<key>" \
  "http://<vm-ip>:8096/Items?Recursive=true&IncludeItemTypes=Movie"
```

Step 1 is done when this returns JSON describing the movie.

## Note

Publishing port 8096 is temporary. Once the server API exists, Jellyfin becomes internal-only.
