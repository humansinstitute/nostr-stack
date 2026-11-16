export const legacyOidcPaths = {
      '/api/v4/git/oidc/.well-known/openid-configuration': {
        get: { tags: ['Forgejo Authentication'], summary: 'Discover Tower OpenID Connect endpoints for Forgejo', responses: { '200': { description: 'OIDC provider metadata' }, '503': { description: 'OIDC provider is not configured' } } },
      },
      '/api/v4/git/oidc/authorize': {
        get: { tags: ['Forgejo Authentication'], summary: 'Authorize Forgejo through an allowlisted Nostr signer', responses: { '200': { description: 'Human sign-in page, or the same challenge as JSON when Accept is application/json', content: { 'text/html': { schema: { type: 'string' } }, 'application/json': { schema: { type: 'object', required: ['request_id', 'completion_url', 'client_id', 'expires_at'], properties: { request_id: { type: 'string' }, completion_url: { type: 'string', format: 'uri' }, client_id: { type: 'string' }, expires_at: { type: 'integer', description: 'Unix seconds' } } } } } }, '400': { description: 'Invalid OAuth authorization request' } } },
      },
      '/api/v4/git/oidc/authorize/complete': {
        post: { tags: ['Forgejo Authentication'], summary: 'Complete a single-use allowlisted Nostr login challenge',
          description: 'NIP-98 signature binds exact URL, POST, body SHA256, nonce=request_id, aud=client_id and expiration=expires_at. No Git grants or Forgejo permissions are evaluated.',
          responses: { '200': { description: 'Validated OIDC callback redirect' }, '401': { description: 'Invalid, replayed or expired challenge' }, '403': { description: 'Nostr identity is not allowlisted' } } },
      },
      '/api/v4/git/oidc/token': {
        post: { tags: ['Forgejo Authentication'], summary: 'Exchange a one-use authorization code for OIDC tokens', responses: { '200': { description: 'OIDC token response' }, '400': { description: 'Invalid or expired grant' }, '401': { description: 'Client authentication failed' } } },
      },
      '/api/v4/git/oidc/userinfo': {
        get: { tags: ['Forgejo Authentication'], summary: 'Return claims for a Tower-issued Forgejo access token', responses: { '200': { description: 'Stable Tower actor claims' }, '401': { description: 'Invalid or expired access token' } } },
      },
      '/api/v4/git/oidc/jwks': {
        get: { tags: ['Forgejo Authentication'], summary: 'Return Tower OIDC public signing keys', responses: { '200': { description: 'JSON Web Key Set' } } },
      },
};
