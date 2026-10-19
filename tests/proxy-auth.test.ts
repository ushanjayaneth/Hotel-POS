import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../server/app';
import type {Snapshot} from '../shared/types';

test('a fresh production owner can authenticate through the allowed HTTPS proxy without demo access or cross-origin writes', async () => {
  const environment = {
    NODE_ENV: 'production',
    POS_DEMO_MODE: 'false',
    INITIAL_ADMIN_PIN: '9876543210',
    COOKIE_SECURE: 'true',
    ALLOWED_ORIGINS: 'https://hotel-pos-kappa.vercel.app',
    SYNC_ENDPOINT: undefined,
    SYNC_TOKEN: undefined,
  };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const app = await createApp({databasePath: ':memory:', seed: false});
    try {
      // TLS terminates outside Fastify. The backend receives an internal HTTP
      // request, while the browser's Origin remains the public HTTPS frontend.
      const headers = {
        host: 'hotel-pos-backend.example.onrender.com',
        origin: 'https://hotel-pos-kappa.vercel.app',
        'x-forwarded-host': 'hotel-pos-kappa.vercel.app',
        'x-forwarded-proto': 'https',
      };
      const demoLogin = await app.inject({method: 'POST', url: '/api/login', headers, payload: {pin: '1234'}});
      assert.equal(demoLogin.statusCode, 401);
      assert.equal(demoLogin.json().code, 'INVALID_CREDENTIALS');

      const login = await app.inject({method: 'POST', url: '/api/login', headers, payload: {pin: environment.INITIAL_ADMIN_PIN}});
      assert.equal(login.statusCode, 200, login.body);
      assert.equal(login.json().user.role, 'owner');
      assert.equal(login.cookies.length, 1);
      const sessionCookie = login.cookies[0];
      assert.equal(sessionCookie.name, 'demo_hotel_session');
      assert.equal(sessionCookie.secure, true);
      assert.equal(sessionCookie.httpOnly, true);
      assert.equal(sessionCookie.sameSite, 'Strict');
      assert.equal(sessionCookie.path, '/');
      assert.equal(sessionCookie.domain, undefined);
      const authenticatedHeaders = {...headers, cookie: `${sessionCookie.name}=${sessionCookie.value}`};

      const session = await app.inject({url: '/api/session', headers: authenticatedHeaders});
      assert.equal(session.statusCode, 200, session.body);
      assert.equal(session.json().user.role, 'owner');
      assert.equal(session.json().demo, false);
      const bootstrap = await app.inject({url: '/api/bootstrap?branchId=b1', headers: authenticatedHeaders});
      assert.equal(bootstrap.statusCode, 200, bootstrap.body);
      const state = bootstrap.json<Snapshot>();
      assert.equal(state.staff.length, 1);
      assert.equal(state.staff[0].role, 'owner');
      assert.equal(state.branches.length, 1);
      assert.equal(state.orders.length, 0);

      const rejected = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        headers: {...authenticatedHeaders, origin: 'https://untrusted.example'},
        payload: {businessName: 'Untrusted update'},
      });
      assert.equal(rejected.statusCode, 403);
      assert.equal(rejected.json().code, 'ORIGIN_FORBIDDEN');
      const unchanged = await app.inject({url: '/api/bootstrap?branchId=b1', headers: authenticatedHeaders});
      assert.equal(unchanged.json<Snapshot>().settings.businessName, state.settings.businessName);

      // Forwarded headers alone never bypass the explicit origin allowlist.
      process.env.ALLOWED_ORIGINS = '';
      const missingAllowlist = await app.inject({method: 'POST', url: '/api/logout', headers: authenticatedHeaders});
      assert.equal(missingAllowlist.statusCode, 403);
      assert.equal(missingAllowlist.json().code, 'ORIGIN_FORBIDDEN');
    } finally {
      await app.close();
    }
  } finally {
    for (const key of Object.keys(environment)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
