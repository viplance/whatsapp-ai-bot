import { randomBytes, timingSafeEqual } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { HttpError } from './settings.js';

export function createAdminAuthenticator({ env, client = new OAuth2Client() }) {
  if (!env.iapAudience || (!env.workspaceMode && !env.adminEmails.length)) throw new Error('IAP_AUDIENCE and ADMIN_EMAILS are required');
  let keys, expiresAt = 0;
  return async (request) => {
    const jwt = request.headers['x-goog-iap-jwt-assertion'];
    if (!jwt || typeof jwt !== 'string') throw new HttpError(401, 'Google sign-in is required.');
    let payload;
    try {
      if (!keys || Date.now() >= expiresAt) {
        keys = (await client.getIapPublicKeys()).pubkeys;
        expiresAt = Date.now() + 3600000;
      }
      payload = (await client.verifySignedJwtWithCertsAsync(jwt, keys, env.iapAudience, ['https://cloud.google.com/iap'])).getPayload();
    } catch { throw new HttpError(401, 'Google sign-in could not be verified.'); }
    const email = payload?.email?.toLowerCase();
    if (!payload?.sub || !email || (!env.workspaceMode && !env.adminEmails.includes(email))) throw new HttpError(403, 'This account is not an administrator.');
    // IAP assertions can rotate between requests. Keep CSRF independent of the
    // JWT, using a host-only HttpOnly cookie and a matching request header.
    const cookie = request.headers.cookie?.split(';').map((s) => s.trim()).find((s) => s.startsWith('__Host-whatsapp-csrf='))?.slice('__Host-whatsapp-csrf='.length);
    const existing = typeof cookie === 'string' && /^[a-f0-9]{64}$/.test(cookie);
    return { email, userId: payload.sub, csrf: existing ? cookie : randomBytes(32).toString('hex'), newCookie: !existing };
  };
}

export function checkMutation(request, identity) {
  const expectedOrigin = `https://${request.headers.host}`;
  const token = request.headers['x-csrf-token'];
  if (request.headers.origin !== expectedOrigin || typeof token !== 'string'
    || Buffer.byteLength(token) !== Buffer.byteLength(identity.csrf) || !timingSafeEqual(Buffer.from(token), Buffer.from(identity.csrf))) {
    throw new HttpError(403, 'Refresh the page before submitting this request.');
  }
  if (!request.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'JSON is required.');
}
