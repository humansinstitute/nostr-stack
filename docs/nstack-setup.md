# Start a fresh NStack

This additive bundle leaves existing production deployments unchanged. Docker
Compose is the only host prerequisite. Keep the project name stable: it determines
which persistent bootstrap, database and storage volumes are used.

```sh
docker compose -p nstack -f docker-compose.setup.yml up -d --build
```

Open <http://127.0.0.1:3101/ui>. Retrieve the one-time code **locally**:

```sh
docker compose -p nstack -f docker-compose.setup.yml exec tower bun -e "const s=await Bun.file('/run/nstack/bootstrap.json').json(); console.log(s.claim_code)"
```

Enter it in the setup screen, connect your Nostr signer, and confirm that identity
as installation administrator. The signed claim is atomic and cannot be repeated.
Create a workspace from the existing console after claiming. Instance ownership
does not imply workspace membership or automatic app registration.

Use `NSTACK_LOCAL_PORT=...` to select a different local port. Database and storage
admin ports are private. The bootstrap volume contains secrets: back it up with
normal protected-volume procedures, never publish it. `down` retains data;
`down -v` destroys it and is only appropriate for explicitly disposable installs.
Recreation with the same project reuses all credentials, identity and ownership.

FIPS desired state defaults on, but this first installation milestone reports it
as unverified until a host daemon and ingress have been validated. HTTPS is
optional. Open **Advanced tools → Installation settings** after connecting your administrator
signer. Settings apply restarts only this installation’s Tower API. A durable
controller verifies health and, when configured, a nonce-signed identity proof
through the HTTPS origin. Failed changes restore previous working settings.
Replaying a signed apply request returns the same operation without another
restart. Interrupted operations roll back; **Retry recovery** handles a transient
rollback failure. Explicit env settings are locked. Generated credential overrides
are rejected: use the existing env deployment until an explicit adoption is reviewed.

MinIO remains private. Same-origin authenticated Tower upload/content routes carry
file bytes; no public storage admin endpoint is required. Workspace administrators
can display a signed app-independent QR from a typed workspace card. A configured
HTTPS/FIPS route is required for QR generation; local HTTP alone is not published.

Current limits: optional graph/relay/Blossom/Git enablement, host FIPS provisioning,
all-service remote acceptance and mobile release remain subsequent stages. Local
startup or configuration alone does not establish remote transport readiness.

## Controller security boundary

Only the controller container mounts the Docker socket. It exposes no network API
and accepts only validated typed settings through a shared journal. It resolves
exactly one container by the installation Compose project plus `service=tower`
labels and can restart that container. Tower receives no socket, image selection,
command execution, arbitrary mount or service selector. Controller state uses a
SQLite transaction and signed-event ID for durable enqueue/idempotency; restart
recovery restores prior settings before trying again. Keep the project identity
stable and do not attach this bundle to existing deployment volumes.
