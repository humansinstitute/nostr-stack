# CapRover Tower and GRasp deployment

Tower remains the authority API. Postgres, graph Postgres and MinIO keep their
existing persistent service apps and volumes. GRasp owns Git and NIP-34 reviews;
its private and public services use separate volumes and origins. See
[GRasp operations](grasp.md) for source pins, build, access and activation gates.

Only activate Forgejo removal after verified consumer cutover. Preserve previous
source images, protected configuration and volumes for rollback. The new Tower
image does not run a Git proxy, OIDC provider or permission worker.

## Tower API GitHub Deploy

Create `tower-stable-api` as a normal CapRover web app.

Recommended settings:

- Has Persistent Data: off
- Deployment method: GitHub
- Branch: `deployed-stable`
- Root `captain-definition`: included in this repo
- Container HTTP Port: `3100`
- Websocket Support: on if Flight Deck uses SSE/WebSocket routes through this hostname

Required API env:

```env
NODE_ENV=production
PORT=3100

SUPERBASED_DIRECT_HTTPS_URL=https://tower-stable-api.b.otherstuff.ai
ADMIN_NPUB=npub1rwzv24nmzfjypx2a8m264ws9vht3uxp5vpypnluuzl67n4waq78suk0wul
FLIGHT_DECK_PG_APP_NPUB=REPLACE_WITH_FLIGHT_DECK_APP_NPUB
SUPERBASED_SERVICE_NSEC=nsec1...

DB_HOST=srv-captain--tower-stable-postgres
DB_PORT=5432
DB_NAME=coworker_v4
DB_USER=postgres
DB_PASSWORD=REPLACE_WITH_POSTGRES_PASSWORD
DB_MAX_CONNECTIONS=10

STORAGE_S3_ENDPOINT=http://srv-captain--tower-stable-minio:9000
STORAGE_S3_ENDPOINT_PUBLIC=https://tower-stable-minio.b.otherstuff.ai
STORAGE_S3_REGION=us-east-1
STORAGE_S3_ACCESS_KEY=REPLACE_WITH_MINIO_ROOT_USER
STORAGE_S3_SECRET_KEY=REPLACE_WITH_MINIO_ROOT_PASSWORD
STORAGE_S3_BUCKET=superbased-storage
STORAGE_S3_FORCE_PATH_STYLE=true
STORAGE_PRESIGN_UPLOAD_TTL_SECONDS=900
STORAGE_PRESIGN_DOWNLOAD_TTL_SECONDS=900

GRAPH_ENABLED=false
GRAPH_DB_HOST=srv-captain--tower-stable-graph-postgres
GRAPH_DB_PORT=5432
GRAPH_DB_NAME=tower_graph
GRAPH_DB_ADMIN_USER=postgres
GRAPH_DB_ADMIN_PASSWORD=REPLACE_WITH_GRAPH_POSTGRES_PASSWORD
GRAPH_DB_APP_USER=tower_graph_app
GRAPH_DB_APP_PASSWORD=REPLACE_WITH_GRAPH_APP_PASSWORD
GRAPH_DB_MAX_CONNECTIONS=10
GRAPH_AGE_GRAPH_NAME=tower_memory
DB_WAIT_MAX_ATTEMPTS=40
```

The same values are available as a copyable template in:

```text
caprover/tower-api.env.example
```

If graph memory is enabled:

```env
GRAPH_ENABLED=true
GRAPH_DB_HOST=srv-captain--tower-stable-graph-postgres
GRAPH_DB_PORT=5432
GRAPH_DB_NAME=tower_graph
GRAPH_DB_ADMIN_USER=postgres
GRAPH_DB_ADMIN_PASSWORD=REPLACE_WITH_GRAPH_POSTGRES_PASSWORD
GRAPH_DB_APP_USER=tower_graph_app
GRAPH_DB_APP_PASSWORD=REPLACE_WITH_GRAPH_APP_PASSWORD
GRAPH_DB_MAX_CONNECTIONS=10
GRAPH_AGE_GRAPH_NAME=tower_memory
GRAPH_ALLOWED_NPUBS=npub1...
```

## Postgres App

Use CapRover's PostgreSQL one-click app when available. Otherwise create an app named `tower-stable-postgres`, mark it persistent, and deploy:

```json
{
  "schemaVersion": 2,
  "imageName": "postgres:16-alpine"
}
```

The same deploy JSON is available in:

```text
caprover/postgres.captain-definition
```

Set env:

```env
POSTGRES_DB=coworker_v4
POSTGRES_USER=postgres
POSTGRES_PASSWORD=REPLACE_WITH_POSTGRES_PASSWORD
```

The same values are available in:

```text
caprover/postgres.env.example
```

Add persistent directory:

```text
/var/lib/postgresql/data
```

Do not expose this app publicly unless you intentionally need remote DB access.

## MinIO App

Use CapRover's MinIO one-click app when available. Configure the access key, secret key, API domain, and console domain there.

Minimum required values:

```env
MINIO_ROOT_USER=REPLACE_WITH_MINIO_ROOT_USER
MINIO_ROOT_PASSWORD=REPLACE_WITH_MINIO_ROOT_PASSWORD
```

The same values are available in:

```text
caprover/minio.env.example
```

Persistent directory:

```text
/data
```

Tower expects bucket `superbased-storage`. Create it once in the MinIO console or with `mc`:

```bash
mc alias set tower-minio https://tower-stable-minio.b.otherstuff.ai REPLACE_WITH_MINIO_ROOT_USER REPLACE_WITH_MINIO_ROOT_PASSWORD
mc mb -p tower-minio/superbased-storage
mc anonymous set none tower-minio/superbased-storage
```

Set `STORAGE_S3_ENDPOINT_PUBLIC` to the externally reachable MinIO API URL used by browsers for presigned uploads/downloads.

## Stable branch update flow

Publish tested source to GitHub main first. Activation remains a separately
approved release: update the intended deployment branch only after repository,
reader, review/deployment and public-access checks pass. Do not deploy the new
Tower image while a surviving Forgejo consumer still depends on Tower OIDC.
After activation, check `/health`, `/.well-known/nstack.json`, private member and
denial tests, ordinary clone/fetch/push/review and isolated recovery. Keep all
retired source volumes until rollback retention is explicitly closed.

## Rollback

Keep retired workers stopped. Roll back only to a reviewed authentication-only
release; never restore the old permission writer/gateway architecture. See the
migration handoff for snapshot recovery.

Do not delete persistent Postgres or MinIO apps during rollback. If an app must be deleted and recreated, keep the same app name and do not remove its persistent volume.
