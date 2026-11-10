# Android UnifiedPush transport v1

Tower stores registrations and delivers generic encrypted alerts for Android Ambulando. The shared inbox remains authoritative. Clients fetch an item through a previously stored trusted Tower connection, with their own credentials; they must never navigate to or authenticate against an origin supplied by a push message alone.

## Enrollment and registration

Use the existing NIP-98 authenticated workspace routes under `/api/v4/flightdeck-pg/workspaces/:workspaceId/notifications`:

1. `PUT installations/:id` with `{"client_app_id":"ambulando","platform":"android","permission_state":"granted"}`. Use a persistent device UUID; enroll each workspace explicitly. Report the actual Android permission state.
2. `PUT installations/:id/transports/unifiedpush` with the following body, using the connector's endpoint and Web Push keys (placeholders below):

```json
{
  "endpoint": "https://push.example.com/connector-issued-capability",
  "keys": { "p256dh": "<base64url P-256 public key>", "auth": "<base64url 16-byte secret>" },
  "preview": "generic",
  "lease_seconds": 604800
}
```

The endpoint is at most 1000 UTF-8 bytes. It must use HTTPS and an exact configured provider origin, without credentials, fragments or IP literals. Keys must be canonical unpadded base64url: an on-curve uncompressed P-256 point (65 bytes) and a 16-byte auth secret. Private DNS answers are blocked at dispatch. Unknown fields and full previews are rejected. Lease bounds are 1–2592000 seconds, default seven days. Renew before expiry and whenever the connector changes endpoint/keys. Only android/ambulando installations are accepted; this label does not attest application identity.

A transport PUT returns the existing `{identity, installation, device, delivery}` shape. `device.kind` is `unifiedpush`; environment and bundle_id are null. Endpoint, keys and token suffix are absent. Another actor's active, unexpired endpoint cannot be taken over. Replacing a transport or moving an expired/revoked endpoint suppresses pending alerts belonging to the old installation/owner. One active transport of each kind exists per installation.

`DELETE installations/:id/transports/unifiedpush` revokes that installation's transport across workspaces and suppresses pending alerts. `DELETE installations/:id` removes only the current workspace enrollment; removal of the final workspace revokes all transports. Account removal must remove enrollment, stop local registration and clear the local trusted routing association.

The workspace notification descriptor advertises `transports: ["apns", "unifiedpush"]` and:

```json
{"transport_status":{"unifiedpush":{"ready":true,"reason":null,"vapid_public_key":"<public key>"}}}
```

Missing/invalid server configuration advertises `ready:false`, a fixed reason (`unifiedpush_not_configured` or `unifiedpush_invalid_configuration`) and a null public key. Registration then returns `409 transport_unavailable`. Installation permission and a usable Tower HTTPS origin are additional per-device delivery gates. Readiness confirms server configuration, not phone reachability or delivery. APNs readiness and its circuit remain independent.

## Payload and delivery

Tower encrypts with the existing `web-push` library, RFC8291 `aes128gcm`, and independent RFC8292 VAPID credentials. The decrypted JSON is:

```json
{
  "fd": {
    "v": 1,
    "notification_id": "<inbox item UUID>",
    "workspace_id": "<workspace UUID>",
    "change_seq": 123,
    "origin": "https://tower.example.com",
    "tower_service_npub": "<trusted Tower service identity>"
  },
  "title": "New notification",
  "body": ""
}
```

No private title/body, source payload, endpoint or key is included. The receiver matches workspace and Tower identity against its stored connection, fetches the authoritative item, checks current access, and deduplicates notification/item sequence locally. The origin is only a matching hint. Delivery is at least once; OS permission, distributor connectivity and Android background restrictions still apply.

The existing worker rechecks membership, record ACL, source grant, app audience, channel mute, alert rules, transport ownership/status/lease, enrollment, permission, read/dismiss/archive/expiry state, deadline and queue lease before delivery. DNS resolves afresh for each send; every answer must be public, and the actual socket uses a validated IP with the original hostname for TLS verification. Fresh direct sockets bypass proxy environment settings; redirects are not followed. DNS and request lifetimes are bounded. Provider bodies/errors/URLs are never persisted or logged by this adapter; only fixed error classes and status codes are retained.

2xx succeeds. 404/410 marks the transport stale and suppresses other pending alerts. 429/5xx/network failures use the durable queue's bounded retry/backoff/deadline rules. Numeric Retry-After is capped at 24 hours. 401/403 opens only the UnifiedPush credential circuit. Other statuses, including redirects, are permanent rejections. There is no polling substitute for push.

## Operator setup

1. Choose an existing UnifiedPush provider. For a public ntfy distributor use its configured public server origin (commonly `https://ntfy.sh`); approve that exact origin explicitly. For self-hosted ntfy, configure a public HTTPS base URL, valid TLS, public DNS, and the provider's UnifiedPush ACLs. Private/LAN-only and split-horizon private addresses are intentionally unsupported. The endpoint comes from the distributor; do not invent a topic or capability URL.
2. Install independent VAPID material through the deployment's supported secret configuration. Set `UNIFIEDPUSH_VAPID_PUBLIC_KEY`, `UNIFIEDPUSH_VAPID_PRIVATE_KEY`, `UNIFIEDPUSH_VAPID_SUBJECT` (an operator `mailto:` or HTTPS contact), and `UNIFIEDPUSH_ALLOWED_ORIGINS` (comma-separated exact HTTPS origins, without wildcards, paths or trailing slashes). Set `NOTIF_PUBLIC_ORIGIN` to the canonical HTTPS Tower origin. Otherwise, Tower uses the HTTPS origin seen when the transport was registered. Do not reuse browser/APNs keys, commit secrets, put them in CLI arguments/logs, or export existing credentials. New key generation requires separate operator authorization and the supported secret workflow.
3. Docker Compose forwards these four independent variables to Tower. Install them in its protected environment configuration; remote deployments use their own protected runtime settings. Review the actual target before applying changes. Rebuild/restart Tower through its supported deployment workflow, preserving its database. Never restart Autopilot as part of push activation.
4. Check Tower health, the authenticated notification descriptor, and per-installation `delivery`. With no configuration, disabled UnifiedPush is expected and APNs/inbox remain usable. A missing provider key or allowlist is an activation gate, not a successful delivery test.
5. On Android install a compatible UnifiedPush distributor such as the Google-free ntfy app, configure the chosen public/self-hosted server, enable Ambulando notifications, grant Android notification permission, and select that distributor. Use the server's advertised VAPID public key at connector registration. If the connector supplies no RFC8291 key set, do not enroll an unencrypted fallback. Follow the distributor's own background operation guidance; do not force battery exemptions globally.
6. Verify with a real authorized inbox event on a locked/backgrounded phone, then test tap routing, read-before-send suppression, duplicates, account removal, endpoint renewal, permission denial, offline recovery and expiry. Repeat with a second distributor before claiming provider interoperability. Unit/simulated sender checks do not establish live device delivery. No external accounts or services are created by this implementation.

Primary protocol references: [UnifiedPush server integration and security](https://unifiedpush.org/developers/intro/), [official PushEndpoint API](https://unifiedpush.org/kdoc/connector/org.unifiedpush.android.connector.data/-push-endpoint/), [RFC8291](https://www.rfc-editor.org/rfc/rfc8291.html), [ntfy UnifiedPush ACL example](https://docs.ntfy.sh/config/#example-unifiedpush). These distinguish a phone distributor from Tower's application-server VAPID keys and ntfy's separate browser Web Push configuration.
