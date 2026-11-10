# Android FCM notifications v1

FCM is the default Android transport for Ambulando on devices with Google Play
Services. Installing Ambulando and granting notification permission is enough
once the matching Firebase app and Tower provider have been configured. No
second distributor app or background signing/read credential is required for
Google's generic background OS alert. Optional UnifiedPush and APNs remain
independent transports.

## Registration and discovery

Use authenticated notification consumer routes under
`/api/v4/flightdeck-pg/workspaces/:workspaceId/notifications`:

1. `PUT installations/:installationId` with `client_app_id: "ambulando"`,
   `platform: "android"`, and actual `permission_state`.
2. `PUT installations/:installationId/transports/fcm`:

```json
{
  "device_token": "<Firebase SDK token>",
  "project_id": "<configured project ID>",
  "sender_id": "<configured numeric project number>",
  "package_name": "<registered Android package>",
  "preview": "generic",
  "lease_seconds": 604800
}
```

Lease range: 1–2592000 seconds. Renew before expiry and update on token refresh.
Only generic previews are accepted. Unknown request fields are rejected.
Registration returns the standard installation/device/delivery shape; it never
returns token, token suffix, OAuth token, private key or provider error text.
`DELETE installations/:id/transports/fcm` revokes only that installation's FCM
transport and suppresses its queued alerts. Removing the installation enrollment
also uses existing queue suppression semantics.

The workspace descriptor advertises `notifications.transports` including `fcm`
and `notifications.transport_status.fcm` with `ready`, `reason`, `project_id`,
`sender_id`, `package_name`. Unconfigured identity fields are null. Ready means
local configuration validates; it does not attest cloud IAM or real delivery.
Registration is refused when configuration is missing/invalid or metadata differs.
Client metadata is a matching constraint, not cryptographic device attestation.
Google additionally checks sender authorization and `restricted_package_name`.

The stable Android SDK uses one token for its default Firebase app. Use one stable
installation per origin/signer, enrolled in each workspace. Local workspace routing
rows may share that installation ID. DELETE the installation enrollment through the
selected workspace route to remove only that workspace; the final enrollment
removal revokes transports. Explicit transport DELETE revokes delivery for all
remaining workspace enrollments. Claims are serialized by token hash; an active
unexpired token owned by another actor is refused. APNs/UnifiedPush ownership
and address uniqueness remain unchanged. Reassignment to a new installation
suppresses queued alerts belonging to the old installation. On identity removal,
revoke all owned registrations and rotate the Firebase token before reuse.

## Privacy and OS behavior

The HTTP v1 message contains fixed purpose-only notification copy and string
`data.fd` encoding this hint:

```json
{
  "v": 1,
  "installation_id": "<registered installation UUID>",
  "origin": "<trusted registered/configured HTTPS origin>",
  "tower_service_npub": "<Tower identity>",
  "workspace_id": "<workspace UUID>",
  "notification_id": "<inbox item UUID>",
  "change_seq": 1
}
```

Android channel: `workspace_activity_v1`; click action:
`studio.otherstuff.ambulando.PUSH_TAP`. Visible notification tag is
`installation_id:workspace_id:notification_id` so the app can cancel a workspace
alert without touching another workspace; TTL is bounded by the alert deadline, at most 24 hours.
No private message, actor, task title, subject IDs or preview text goes to Google.
FCM receives device token, purpose text and opaque routing metadata. Notification
messages may be collapsed by FCM; the inbox remains authoritative.

Android matches the hint to its stored installation and trusted service/workspace.
Never follow an arbitrary payload URL. On tap, authenticate and fetch the current
item, then check access before navigation. Receiving or tapping does not mark read.
Background/cold OS presentation can occur without executing the app. An alert
already accepted by Google cannot be recalled after mute/logout/read; disabled or
removed registrations must reject taps locally. Foreground handling must dedupe
against the same installation/item/change sequence and avoid a second alert.

## Protected runtime configuration

- `FCM_PROJECT_ID`: existing Firebase project ID.
- `FCM_SENDER_ID`: matching numeric Firebase project number (Android sender ID).
- `FCM_ANDROID_PACKAGE`: exact registered Android package.
- Exactly one of `FCM_SERVICE_ACCOUNT_JSON` or `FCM_SERVICE_ACCOUNT_JSON_FILE`:
  protected service-account credential for that same project. Prefer a read-only
  file, readable only by the service account running Tower.
- `NOTIF_PUBLIC_ORIGIN`: canonical HTTPS Tower origin. Without it, a trusted HTTPS
  registration origin is required for each transport.
- `NOTIF_ALERTS=on` (default), existing projector and alert worker enabled.

Docker Compose mounts `TOWER_FCM_SECRETS_DIR` (default
`.runtime/tower-fcm-secrets`) at `/run/tower-fcm-secrets:ro`; set
`FCM_SERVICE_ACCOUNT_JSON_FILE=/run/tower-fcm-secrets/service-account.json`.
Protected registered-app runtime settings may inject JSON where mounted file
custody is unavailable. Do not paste credentials into chat, docs or source.

Activate only after an operator verifies the existing Firebase project, matching
Android client config, enabled FCM HTTP v1 API and service-account IAM permission
to send messages. The Android client needs its public Firebase app ID/API key,
project ID/number and matching package configuration. No legacy server key,
endpoint override, new project, purchase or billing change is implicit.
Use the reviewed owner-space registered-app deployment/configuration broker for
remote activation; do not bypass it with direct host or CapRover credentials.

## Provider and queue behavior

OAuth uses RS256 service-account assertions with fixed audience/token endpoint
`https://oauth2.googleapis.com/token`, one-hour assertion expiry and scope
`https://www.googleapis.com/auth/firebase.messaging`. Access tokens are cached
only to their bounded returned TTL minus 60 seconds, keyed by credential identity;
concurrent refreshes are coalesced. Redirects are refused. Sending uses only
`https://fcm.googleapis.com/v1/projects/<validated-project>/messages:send`.
No credentials, URLs or arbitrary error bodies enter attempt logs.

FCM reuses inbox/rules/mutes/audience, late ACL/membership/read/enrollment checks,
leases, durable attempts, retry budget, deadlines and dedupe. Provider metadata
is checked again before send after configuration changes. OAuth and send have
separate bounded timeouts within the delivery lease. FCM has its own credential
circuit; APNs and optional UnifiedPush continue independently.

Only typed FCM `UNREGISTERED` with HTTP 404 stales a token. Generic 404 and
`INVALID_ARGUMENT` fail the alert without revoking the device. HTTP 401/403 and
sender mismatch open the FCM credential circuit; HTTP 429 and 5xx/network failures
retry durably. Quota retries wait at least one minute; Retry-After is honored up
to the alert deadline. Configuration readiness alone is not cloud delivery proof.

Primary references: [HTTP v1 authorization](https://firebase.google.com/docs/cloud-messaging/send/v1-api),
[OAuth service accounts](https://developers.google.com/identity/protocols/oauth2/service-account),
[message schema](https://firebase.google.com/docs/reference/fcm/rest/v1/projects.messages),
[error codes](https://firebase.google.com/docs/cloud-messaging/error-codes),
[Android reception](https://firebase.google.com/docs/cloud-messaging/android/receive-messages).
