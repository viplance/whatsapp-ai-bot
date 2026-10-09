import { createControl, operationId } from './control.js';
import { configurationsOf } from './configurations.js';
import { HttpError, validateSettings } from './settings.js';
import { MAX_DEVICES, assertWorkspace, devicesOf, publishDueIndex, validId } from './workspaces.js';

const iso = () => new Date().toISOString();
const notFound = () => new HttpError(404, 'Resource not found.');
const initialSettings = () => validateSettings({ enabled: false, timezone: 'UTC', settings: { period: '4h', model: 'gemini-3.1-flash-lite', showScanLogs: false } });
export function createWorkspaceControl({ db, registryDb, env, google }) {
  const workspaceId = env.workspaceId;
  const reconcile = () => publishDueIndex({ registryDb, controlDb: db, workspaceId });
  async function deviceControl(id) {
    if (!validId(id)) throw notFound();
    await assertWorkspace(db, workspaceId);
    const value = (await db.doc(`configs/${id}`).get()).data();
    if (!value || value.workspaceId !== workspaceId || value.deviceId !== id) throw notFound();
    const deviceEnv = { ...env, configId: id };
    const controller = createControl({ db, env: deviceEnv, google: {
      reconcile,
      start: async (mode, values) => {
        const requestRef = db.doc(`requests/${values.REQUEST_ID}`);
        await db.runTransaction(async (tx) => {
          const previous = (await tx.get(requestRef)).data();
          const operation = (await tx.get(db.doc(`configs/${id}/operations/${values.REQUEST_ID}`))).data();
          if (!operation || operation.workspaceId !== workspaceId || operation.deviceId !== id || operation.mode !== mode) throw notFound();
          if (previous) {
            if (previous.workspaceId !== workspaceId || previous.deviceId !== id || previous.mode !== mode) throw notFound();
            return;
          }
          tx.create(requestRef, { id: values.REQUEST_ID, workspaceId, deviceId: id, mode,
            status: 'queued', attempts: 0, createdAt: iso(), updatedAt: iso() });
        });
        await reconcile();
        await google.start(mode); // Fixed Job; the worker chooses its durable request.
        return {};
      },
      execution: (record) => google.execution(record),
      cancel: async (record) => {
        await db.doc(`requests/${record.id}`).set({ status: 'cancelled', updatedAt: iso() }, { merge: true });
        await reconcile();
        return record.execution ? google.cancel(record) : true;
      },
    } });
    return controller;
  }
  function checkInput(input, allowed) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !allowed.includes(key))) throw new HttpError(400, 'Unsupported request fields.');
    if (input.workspaceId !== undefined && input.workspaceId !== workspaceId) throw notFound();
  }
  async function configurationControl(id, input) {
    const devices = await devicesOf(db, workspaceId);
    const matches = devices.filter((device) => configurationsOf(device).some((item) => item.id === id));
    if (matches.length !== 1 || (input?.deviceId !== undefined && input.deviceId !== matches[0].id)) throw notFound();
    return deviceControl(matches[0].id);
  }
  async function overview() {
    await assertWorkspace(db, workspaceId);
    const devices = await devicesOf(db, workspaceId);
    const results = await Promise.all(devices.map(async (device) => ({ device,
      value: await (await deviceControl(device.id)).overview() })));
    const configurations = results.flatMap(({ device, value }) => value.configurations.map((item) => ({ ...item, workspaceId, deviceId: device.id, deviceName: device.name })));
    const safeDevices = results.map(({ device, value }) => ({ id: device.id, name: device.name, version: device.version,
      authStatus: value.config.authStatus, maintenance: value.config.maintenance, activeOperation: value.config.activeOperation,
      scheduleStatus: value.config.scheduleStatus, scheduleRevision: value.config.scheduleRevision,
      appliedScheduleRevision: value.config.appliedScheduleRevision, lastVerifiedAt: value.config.lastVerifiedAt || null }));
    for (const [index, { device }] of results.entries()) safeDevices[index].removable = device.authStatus !== 'linked'
      && !device.activeOperation && !device.latestPairing && !device.accountFingerprint && !configurationsOf(device).length;
    const operations = results.flatMap(({ device, value }) => value.operations.map((item) => ({ ...item, deviceId: device.id, deviceName: device.name })))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 12);
    const pending = safeDevices.some((device) => device.scheduleStatus !== 'applied' || device.scheduleRevision !== device.appliedScheduleRevision);
    const config = { workspaceId, settings: initialSettings().settings,
      authStatus: safeDevices.some((device) => device.authStatus === 'linked') ? 'linked' : 'needsPairing',
      maintenance: false, scheduleStatus: pending ? 'pending' : 'applied', scheduleRevision: 1, appliedScheduleRevision: pending ? 0 : 1,
      lastVerifiedAt: safeDevices.map((device) => device.lastVerifiedAt).filter(Boolean).sort().at(-1) || null,
      queueCount: configurations.reduce((sum, item) => sum + (item.queueCount || 0), 0),
      queueOldestAt: configurations.map((item) => item.queueOldestAt).filter(Boolean).sort()[0] || null };
    return { workspace: { id: workspaceId }, config, configurations, devices: safeDevices, operations,
      nextRunAt: configurations.map((item) => item.nextRunAt).filter(Boolean).sort()[0] || null };
  }
  const configurationFields = ['name', 'enabled', 'timezone', 'settings', 'baseVersion', 'idempotencyKey', 'workspaceId', 'deviceId'];
  return {
    overview,
    async reconcile() {
      for (const device of await devicesOf(db, workspaceId)) await (await deviceControl(device.id)).reconcile();
      await reconcile();
    },
    async createDevice(input, user) {
      checkInput(input, ['name', 'idempotencyKey', 'workspaceId']);
      if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 100
        || typeof input.idempotencyKey !== 'string' || !/^[\w-]{8,100}$/.test(input.idempotencyKey)) throw new HttpError(400, 'A device name and idempotency key are required.');
      const id = `device-${operationId(user, workspaceId, input.idempotencyKey).slice(0, 24)}`;
      const metaRef = db.doc('workspace/meta'), ref = db.doc(`configs/${id}`);
      await db.runTransaction(async (tx) => {
        const meta = (await tx.get(metaRef)).data(), old = (await tx.get(ref)).data();
        const removed = (await tx.get(db.doc(`removedDevices/${id}`))).exists;
        if (meta?.id !== workspaceId || meta.status !== 'active') throw notFound();
        if (old) { if (old.name !== input.name.trim()) throw new HttpError(409, 'Device was already saved.'); return; }
        if (removed) throw new HttpError(409, 'This device was removed. Use a new request key.');
        if ((meta.deviceCount || 0) >= MAX_DEVICES) throw new HttpError(400, `At most ${MAX_DEVICES} devices are supported.`);
        const initial = initialSettings();
        const value = { ...initial, workspaceId, deviceId: id, name: input.name.trim(), version: 1, configurations: [],
          activeVersion: 1, scheduleRevision: 1, appliedScheduleRevision: 1, scheduleStatus: 'applied',
          maintenance: false, authStatus: 'needsPairing', activeOperation: null, queueCount: 0, createdAt: iso() };
        tx.create(ref, value); tx.create(ref.collection('versions').doc('1'), { ...initial, workspaceId, deviceId: id, configurations: [] });
        tx.update(metaRef, { deviceCount: (meta.deviceCount || 0) + 1 });
      });
      await reconcile();
      return { id, ...(await overview()) };
    },
    async removeDevice(id, input) {
      checkInput(input, ['baseVersion', 'workspaceId']);
      const control = await deviceControl(id);
      await db.runTransaction(async (tx) => {
        const device = (await tx.get(control.ref)).data(), meta = (await tx.get(db.doc('workspace/meta'))).data();
        if (device.version !== input.baseVersion) throw new HttpError(409, 'Device changed. Reload before removing it.');
        if (device.activeOperation || device.authStatus === 'linked' || device.latestPairing || device.accountFingerprint || configurationsOf(device).length) throw new HttpError(409, 'Only unused devices without configurations can be removed.');
        tx.delete(control.ref); tx.create(db.doc(`removedDevices/${id}`), { removedAt: iso() });
        tx.update(db.doc('workspace/meta'), { deviceCount: meta.deviceCount - 1 });
      });
      await reconcile(); return overview();
    },
    async createConfiguration(input, user) {
      checkInput(input, configurationFields);
      const controller = await deviceControl(input.deviceId);
      const result = await controller.createConfiguration(input, user);
      return { id: result.id, ...(await overview()) };
    },
    async updateConfiguration(id, input, user) {
      checkInput(input, configurationFields);
      const controller = await configurationControl(id, input);
      await controller.updateConfiguration(id, input, user);
      return { id, ...(await overview()) };
    },
    async removeConfiguration(id, input, user) {
      checkInput(input, ['baseVersion', 'deviceId', 'workspaceId']);
      await (await configurationControl(id, input)).removeConfiguration(id, input, user);
      return overview();
    },
    async start(mode, key, user, selection, deviceId) {
      if (mode === 'pair') return (await deviceControl(deviceId)).start(mode, key, user);
      if (selection !== 'all') return (await configurationControl(selection, deviceId === undefined ? undefined : { deviceId })).start('summary', key, user, selection);
      const results = [];
      for (const device of await devicesOf(db, workspaceId)) {
        if (!configurationsOf(device).length) continue;
        try { results.push({ deviceId: device.id, ...(await (await deviceControl(device.id)).start('summary', key, user, 'all')) }); }
        catch (error) { if (!(error instanceof HttpError)) throw error; results.push({ deviceId: device.id, status: 'rejected', error: error.message }); }
      }
      if (!results.length) throw notFound();
      return { devices: results };
    },
    pairing: async (user, deviceId) => (await deviceControl(deviceId)).pairing(user),
    cancelPairing: async (user, deviceId) => (await deviceControl(deviceId)).cancelPairing(user),
  };
}
