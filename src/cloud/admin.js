import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { Firestore } from '@google-cloud/firestore';
import QRCode from 'qrcode';
import { cloudEnvironment } from './env.js';
import { createGoogleApi } from './google.js';
import { createControl } from './control.js';
import { createAdminAuthenticator, checkMutation } from './admin-auth.js';
import { HttpError } from './settings.js';

async function readBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 65536) throw new HttpError(413, 'Request is too large.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw new HttpError(400, 'Invalid JSON.'); }
}

export function createAdminServer({ env, control, authenticate = createAdminAuthenticator({ env }) }) {
  const assets = { '/': ['index.html', 'text/html'], '/admin.js': ['admin.js', 'text/javascript'], '/admin.css': ['admin.css', 'text/css'] };
  return createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value)); };
    try {
      const path = new URL(request.url, 'https://admin.invalid').pathname;
      if (path === '/healthz' && request.method === 'GET') return json(200, { ok: true });
      const identity = await authenticate(request);
      if (identity.newCookie) response.setHeader('Set-Cookie', `__Host-whatsapp-csrf=${identity.csrf}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=3600`);
      if (request.method === 'GET' && assets[path]) {
        const [file, type] = assets[path];
        response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
        response.end(await readFile(new URL(`../admin/${file}`, import.meta.url)));
        return;
      }
      if (request.method === 'GET') {
        if (path === '/api/session') return json(200, { email: identity.email, csrf: identity.csrf });
        if (path === '/api/overview') return json(200, await control.overview());
        if (path === '/api/configurations') return json(200, await control.overview());
        if (path === '/api/pairing') {
          const value = await control.pairing(identity.email);
          if (value?.qr) { value.qrDataUrl = await QRCode.toDataURL(value.qr, { width: 300, margin: 2 }); delete value.qr; }
          return json(200, value);
        }
        throw new HttpError(404, 'Not found.');
      }
      if (!['POST', 'PUT', 'DELETE'].includes(request.method)) throw new HttpError(405, 'Method not allowed.');
      checkMutation(request, identity);
      const body = await readBody(request);
      const item = path.match(/^\/api\/configurations\/([a-z0-9-]{1,60})(\/run)?$/);
      if (path === '/api/configurations' && request.method === 'POST') return json(201, await control.createConfiguration(body, identity.email));
      if (path === '/api/configurations/run-all' && request.method === 'POST') return json(202, await control.start('summary', body.idempotencyKey, identity.email, 'all'));
      if (item && item[2] && request.method === 'POST') return json(202, await control.start('summary', body.idempotencyKey, identity.email, item[1]));
      if (item && !item[2] && request.method === 'PUT') return json(200, await control.updateConfiguration(item[1], body, identity.email));
      if (item && !item[2] && request.method === 'DELETE') return json(200, await control.removeConfiguration(item[1], body, identity.email));
      if (path === '/api/settings' && request.method === 'PUT') return json(200, await control.update(body, identity.email));
      if (request.method === 'POST') {
        if (path === '/api/reconcile') { await control.reconcile(); return json(200, { applied: true }); }
        if (path === '/api/run') return json(202, await control.start('summary', body.idempotencyKey, identity.email));
        if (path === '/api/pairing') return json(202, await control.start('pair', body.idempotencyKey, identity.email));
        if (path === '/api/pairing/cancel') { await control.cancelPairing(identity.email); return json(200, { cancelled: true }); }
      }
      throw new HttpError(404, 'Not found.');
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status >= 500) console.error(JSON.stringify({ event: 'admin_request_failed', type: error.name }));
      if (!response.headersSent) json(status, { error: error instanceof HttpError ? error.message : 'Service error. Retry or inspect Cloud Logging.' });
      else response.end();
    }
  });
}

if (process.argv[1]?.endsWith('/cloud/admin.js')) {
  const env = cloudEnvironment();
  const db = new Firestore({ projectId: env.projectId, databaseId: env.controlDatabase });
  const control = createControl({ db, env, google: createGoogleApi({ env }) });
  const server = createAdminServer({ env, control });
  server.listen(env.port, '0.0.0.0', () => console.log(JSON.stringify({ event: 'admin_listening', port: env.port })));
  process.once('SIGTERM', () => server.close());
}
