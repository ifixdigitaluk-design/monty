// A minimal OpenID Connect provider for tests (stands in for Google). NOT for production use.
// - Discovery, /authorize (form or immediate), /token (PKCE S256, client secret, one-time codes), /jwks (RS256).
// - The /authorize form lets a browser test "choose an account"; API tests pass `email` (and friends) in the query.
// - Test hooks via query on /authorize: tamper=nonce|aud|exp|sig|iss to produce a bad ID token.
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const b64url = (b) => Buffer.from(b).toString('base64url');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function startFakeOidc({ port = 0, clientId = 'test-client', clientSecret = 'test-secret' } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 }); // signs "sig"-tampered tokens
  const kid = b64url(randomBytes(8));
  const codes = new Map();
  const stats = { tokenRequests: 0 };
  let issuer = '';

  const jwt = (claims, key = privateKey) => {
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
    const body = b64url(JSON.stringify(claims));
    const sig = sign('RSA-SHA256', Buffer.from(`${header}.${body}`), key);
    return `${header}.${body}.${b64url(sig)}`;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, issuer);
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` });
    }
    if (url.pathname === '/jwks') return json(200, { keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }] });
    if (url.pathname === '/authorize') {
      const q = url.searchParams;
      if (q.get('client_id') !== clientId || q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) {
        return json(400, { error: 'invalid_request' });
      }
      const back = new URL(q.get('redirect_uri'));
      if (q.get('deny') === '1') {
        back.searchParams.set('error', 'access_denied');
        back.searchParams.set('state', q.get('state') ?? '');
        res.writeHead(302, { Location: back.toString() });
        return res.end();
      }
      if (!q.get('email')) {
        // Account chooser for browser tests.
        const hidden = [...q.entries()].map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(`<!doctype html><html lang="en"><title>Test identity provider</title><main><h1>Test identity provider</h1>
          <form method="get" action="/authorize">${hidden}
          <label>Email <input name="email" type="email" required></label>
          <label>Name <input name="name"></label>
          <button type="submit">Continue</button></form>
          <form method="get" action="/authorize">${hidden}<input type="hidden" name="deny" value="1"><button type="submit">Cancel</button></form></main></html>`);
      }
      const code = b64url(randomBytes(16));
      codes.set(code, {
        used: false,
        redirectUri: q.get('redirect_uri'),
        challenge: q.get('code_challenge'),
        nonce: q.get('nonce'),
        tamper: q.get('tamper'),
        identity: {
          sub: q.get('sub') ?? `sub-${createHash('sha256').update(q.get('email').toLowerCase()).digest('hex').slice(0, 16)}`,
          email: q.get('email'),
          email_verified: q.get('email_verified') !== 'false',
          name: q.get('name') || q.get('email').split('@')[0],
          ...(q.get('claim_hd') ? { hd: q.get('claim_hd') } : {}),
        },
      });
      back.searchParams.set('code', code);
      back.searchParams.set('state', q.get('state') ?? '');
      res.writeHead(302, { Location: back.toString() });
      return res.end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      stats.tokenRequests++;
      let raw = '';
      for await (const c of req) raw += c;
      const f = new URLSearchParams(raw);
      const entry = codes.get(f.get('code') ?? '');
      if (f.get('grant_type') !== 'authorization_code' || f.get('client_id') !== clientId || f.get('client_secret') !== clientSecret) return json(401, { error: 'invalid_client' });
      if (!entry || entry.used || entry.redirectUri !== f.get('redirect_uri')) return json(400, { error: 'invalid_grant' });
      if (b64url(createHash('sha256').update(f.get('code_verifier') ?? '').digest()) !== entry.challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE' });
      entry.used = true;
      const now = Math.floor(Date.now() / 1000);
      const t = entry.tamper;
      const claims = {
        iss: t === 'iss' ? 'https://evil.example' : issuer,
        aud: t === 'aud' ? 'someone-else' : clientId,
        azp: clientId,
        iat: now,
        exp: t === 'exp' ? now - 3600 : now + 3600,
        nonce: t === 'nonce' ? 'wrong' : entry.nonce,
        ...entry.identity,
      };
      return json(200, { access_token: b64url(randomBytes(16)), token_type: 'Bearer', expires_in: 3600, id_token: jwt(claims, t === 'sig' ? other.privateKey : privateKey) });
    }
    json(404, { error: 'not_found' });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      issuer = `http://127.0.0.1:${server.address().port}`;
      resolve({ issuer, clientId, clientSecret, stats, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

// `node apps/api/test/fake-oidc.mjs` → runs on FAKE_OIDC_PORT (Playwright webServer).
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const p = await startFakeOidc({ port: Number(process.env.FAKE_OIDC_PORT ?? 4300) });
  console.warn(`fake OIDC provider on ${p.issuer}`);
}
