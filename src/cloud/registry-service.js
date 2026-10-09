import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { Firestore } from '@google-cloud/firestore';
import { OAuth2Client } from 'google-auth-library';
import { jidNormalizedUser } from 'baileys';
import { cloudEnvironment } from './env.js';
import { HttpError } from './settings.js';
import { publishDueIndex, workspaceEnvironment, validId, subjectKey } from './workspaces.js';

export function createRegistryService({ env, registryDb, database, accountKey,
  verifyToken = async (token) => (await new OAuth2Client().verifyIdToken({ idToken: token, audience: env.registryServiceUrl })).getPayload() }) {
  if (!accountKey || accountKey.length < 32) throw new Error('An account registry HMAC key is required');
  const fingerprint = (accountId) => {
    const id = typeof accountId === 'string' ? jidNormalizedUser(accountId) : '';
    if (!/^\d{7,15}@s\.whatsapp\.net$/.test(id)) throw new HttpError(400, 'Invalid WhatsApp account.');
    return createHmac('sha256', accountKey).update(id).digest('hex');
  };
  async function serviceIdentity(token) {
    let identity;
    try { identity = await verifyToken(token); } catch { throw new HttpError(401, 'Workload authentication failed.'); }
    if (!identity?.email || identity.email_verified !== true) throw new HttpError(403, 'Registered workload required.');
    const ref = registryDb.doc(`workloads/${createHmac('sha256', accountKey).update(identity.email).digest('hex')}`);
    const registered = (await ref.get()).data();
    if (!registered || registered.email !== identity.email || !['summary', 'pair'].includes(registered.mode)) throw new HttpError(403, 'Registered workload required.');
    const workspace = (await registryDb.doc(`workspaces/${registered.workspaceId}`).get()).data();
    if (workspace?.id !== registered.workspaceId) throw new HttpError(503, 'Invalid workspace registration.');
    const scopedEnv = workspaceEnvironment(env, workspace);
    if (workspace.status !== 'active') throw new HttpError(503, 'Workspace is unavailable.');
    return { env: scopedEnv, mode: registered.mode, db: database(scopedEnv.controlDatabase) };
  }
  async function accountAction(context, body, claim) {
    if (!body || Object.keys(body).some((key) => !['deviceId', 'operationId', 'accountId'].includes(key))
      || !validId(body.deviceId) || !/^[a-f0-9]{64}$/.test(body.operationId || '')) throw new HttpError(400, 'Invalid account request.');
    if (claim && context.mode !== 'pair') throw new HttpError(403, 'Pairing workload required.');
    const ref = context.db.doc(`configs/${body.deviceId}`), opRef = ref.collection('operations').doc(body.operationId);
    const device = (await ref.get()).data(), op = (await opRef.get()).data();
    if (!device || device.workspaceId !== context.env.workspaceId || device.deviceId !== body.deviceId
      || op?.workspaceId !== context.env.workspaceId || op.deviceId !== body.deviceId || op.status !== 'running'
      || op.mode !== context.mode || device.activeOperation !== body.operationId
      || (claim && device.latestPairing !== body.operationId)) throw new HttpError(404, 'Operation not found.');
    const request = (await context.db.doc(`requests/${body.operationId}`).get()).data();
    if (request?.workspaceId !== context.env.workspaceId || request.deviceId !== body.deviceId || request.mode !== context.mode
      || request.status !== 'running') throw new HttpError(404, 'Operation not found.');
    if (!(op.owner === 'scheduler' && request.scheduled && context.mode === 'summary')) {
      const member = typeof op.owner === 'string' ? (await registryDb.doc(`members/${subjectKey(op.owner)}`).get()).data() : null;
      if (member?.subject !== op.owner || member.workspaceId !== context.env.workspaceId || member.status !== 'active'
        || !['owner', 'editor'].includes(member.role)) throw new HttpError(403, 'The requesting user no longer has workspace access.');
    }
    const accountFingerprint = fingerprint(body.accountId);
    if (device.accountFingerprint && device.accountFingerprint !== accountFingerprint) throw new HttpError(409, 'This is a different WhatsApp account. Add a new device.');
    if (!claim && !device.accountFingerprint) throw new HttpError(409, 'Device ownership has not been verified.');
    await registryDb.runTransaction(async (tx) => {
      const ownershipRef = registryDb.doc(`accounts/${accountFingerprint}`);
      const deviceOwnershipRef = registryDb.doc(`deviceAccounts/${context.env.workspaceId}--${body.deviceId}`);
      const old = (await tx.get(ownershipRef)).data();
      const boundDevice = (await tx.get(deviceOwnershipRef)).data();
      if (old && (old.workspaceId !== context.env.workspaceId || old.deviceId !== body.deviceId)) throw new HttpError(409, 'This WhatsApp account is already assigned to another device.');
      if (boundDevice && boundDevice.fingerprint !== accountFingerprint) throw new HttpError(409, 'This is a different WhatsApp account. Add a new device.');
      if (!claim && !old) throw new HttpError(409, 'Device ownership has not been verified.');
      if (claim && !old) tx.create(ownershipRef, { workspaceId: context.env.workspaceId, deviceId: body.deviceId });
      if (claim && !boundDevice) tx.create(deviceOwnershipRef, { fingerprint: accountFingerprint });
    });
    if (claim) await context.db.runTransaction(async (tx) => {
      const latest = (await tx.get(ref)).data(), operation = (await tx.get(opRef)).data();
      if (latest.activeOperation !== body.operationId || operation?.status !== 'running'
        || (latest.accountFingerprint && latest.accountFingerprint !== accountFingerprint)) throw new HttpError(409, 'Pairing was superseded.');
      tx.update(ref, { accountFingerprint });
    });
    return { verified: true };
  }
  return createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const send = (status, data) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data)); };
    try {
      if (request.url === '/healthz') return send(200, { ok: true });
      if (request.method !== 'POST' || !['/sync', '/claim', '/verify'].includes(request.url)) throw new HttpError(404, 'Not found.');
      const context = await serviceIdentity(request.headers.authorization?.replace(/^Bearer /, '') || '');
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > 8192) throw new HttpError(413, 'Request is too large.'); chunks.push(chunk); }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new HttpError(400, 'Invalid JSON.'); }
      if (request.url === '/sync') {
        if (Object.keys(body).length) throw new HttpError(400, 'Unsupported request fields.');
        await publishDueIndex({ registryDb, controlDb: context.db, workspaceId: context.env.workspaceId });
        return send(200, { applied: true });
      }
      return send(200, await accountAction(context, body, request.url === '/claim'));
    } catch (error) { send(error instanceof HttpError ? error.status : 500, { error: error instanceof HttpError ? error.message : 'Registry request failed.' }); }
  });
}

if (process.argv[1]?.endsWith('/cloud/registry-service.js')) {
  const env = cloudEnvironment(), clients = new Map();
  const database = (id) => { if (!clients.has(id)) clients.set(id, new Firestore({ projectId: env.projectId, databaseId: id })); return clients.get(id); };
  createRegistryService({ env, registryDb: database(env.registryDatabase), database, accountKey: process.env.ACCOUNT_REGISTRY_KEY })
    .listen(env.port, '0.0.0.0');
}
