# Packaged NStack shell

A FIPS-only installation must not need an HTTPS page to bootstrap its transport.
NBrowser packages the known NStack console as a hash-pinned local app, served at
an approved random loopback origin and capability path. This is static software,
not a proxy for remote HTML or scripts. Navigation to arbitrary `.fips` pages does
not grant the universal provider or expand native origin policy.

Build the reviewed static bundle from a committed Tower revision:

```sh
bun scripts/build-nstack-shell.ts
```

`dist/nstack-shell/manifest.json` contains `schemaVersion: 1`, `id: nstack`, full
`sourceRevision`, `entrypoint: index.html`, and a `files` map. Each relative path
maps to its SHA-256 and content type. NBrowser's catalogue pins the manifest hash
and checks all bundled file hashes before serving. Update requires a reviewed
Tower source revision, regenerated hashes, NBrowser import/catalogue update and
its normal release process. Do not pin an intermediate dirty worktree as a release.

The approved CSP permits explicit HTTPS API connections while blocking ambient HTTP; FIPS requests use the scoped native handle. Redirects, cookies and request-origin escape are rejected.

Assets use capability-relative paths, external script/style files, no CDN, eval,
remote HTML or remote script loader. The shell receives no operator keys or
credentials. Its paste flow validates the bounded signed v3 envelope locally,
shows exact service/workspace identities and transport choice, and requires
confirmation. FIPS uses only the existing `window.fipsTransport.connect` handle
for the exact peer/port and purpose `tower`; missing support fails closed.
NIP-98 uses the user's own signer. A fresh signed nonce proof must bind the exact
backend key, workspace UUID/authority and selected URL before workspace loading.
The shell never substitutes the first accessible workspace or registers an app
merely from connection. Backend and workspace pins persist locally and reject
silent identity replacement. Disconnect/navigation releases the scoped handle.

The ordinary `/ui` console remains hosted by Tower. Fresh setup mode defaults
workspace creation to the shared UUID model suitable for Alexandria/Ambulando;
existing env deployments retain the encrypted-record creation default. The model
is an explicit choice, and shared creation still requires instance administration.

Browser tests exercise the actual generated package under a capability prefix,
with CSP blocking ambient HTTP/FIPS and allowing the explicit HTTPS choice, with no Node globals. The native bridge in
those tests is a fixture: native main-frame/consent/signing and real-device FIPS
remain separate acceptance checks. Linux's missing native WebView message channel
must be reported as unsupported rather than replaced by an ambient fallback.
