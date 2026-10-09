import { createHash } from 'node:crypto';
import { HttpError, nextRunAt, validateSettings } from './settings.js';
import { configurationId, configurationsOf, configurationSnapshot, MAX_CONFIGURATIONS,
  validateConfiguration, withConfigurations } from './configurations.js';

const ACTIVE = new Set(['queued', 'running', 'cancelling']);
export const activeOperation = (operation) => operation && ACTIVE.has(operation.status);
export const operationId = (user, mode, key) => createHash('sha256').update(`${user}:${mode}:${key}`).digest('hex');
const iso = () => new Date().toISOString();

export function createControl({ db, env, google }) {
  const ref = db.doc(`configs/${env.configId}`);
  const opRef = (id) => ref.collection('operations').doc(id);
  const config = async () => {
    const value = (await ref.get()).data();
    if (!value) throw new HttpError(503, 'Cloud configuration has not been initialized.');
    return value;
  };
  async function reconcile() {
    const owner = crypto.randomUUID();
    const acquired = await db.runTransaction(async (tx) => {
      const value = (await tx.get(ref)).data();
      if (value.reconcileUntil > Date.now()) return false;
      tx.update(ref, { reconcileOwner: owner, reconcileUntil: Date.now() + 120000 });
      return true;
    });
    if (!acquired) throw new HttpError(409, 'Schedule reconciliation is already in progress.');
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        const value = await config();
        try { await google.reconcile(value); }
        catch {
          await db.runTransaction(async (tx) => {
            const latest = (await tx.get(ref)).data();
            if (latest.scheduleRevision === value.scheduleRevision) tx.update(ref, { scheduleStatus: 'error', scheduleError: 'Scheduler update failed. Retry reconciliation.' });
          });
          throw new HttpError(503, 'Scheduler update failed. Settings are saved; retry reconciliation.');
        }
        const applied = await db.runTransaction(async (tx) => {
          const latest = (await tx.get(ref)).data();
          if (latest.scheduleRevision !== value.scheduleRevision) return false;
          tx.update(ref, { appliedScheduleRevision: value.scheduleRevision, scheduleStatus: 'applied', scheduleError: null, reconciledAt: iso() });
          return true;
        });
        if (applied) return;
      }
      throw new HttpError(409, 'Settings changed during reconciliation. Retry.');
    } finally {
      await db.runTransaction(async (tx) => {
        if ((await tx.get(ref)).data()?.reconcileOwner === owner) tx.update(ref, { reconcileUntil: 0 });
      });
    }
  }
  async function update(input, user) {
    const value = validateSettings(input);
    await db.runTransaction(async (tx) => {
      const current = (await tx.get(ref)).data();
      if (current.configurations) throw new HttpError(409, 'Use the Configurations page to edit individual configurations.');
      if (current.activeVersion !== input.baseVersion) throw new HttpError(409, 'Settings changed. Reload before saving.');
      if (value.enabled && (current.maintenance || current.authStatus !== 'linked')) throw new HttpError(409, 'Link WhatsApp and finish maintenance before enabling runs.');
      const next = { ...current, ...value, activeVersion: current.activeVersion + 1,
        scheduleRevision: current.scheduleRevision + 1, scheduleStatus: 'pending', updatedAt: iso(), updatedBy: user };
      tx.create(ref.collection('versions').doc(String(next.activeVersion)), { ...value, createdAt: iso(), createdBy: user });
      tx.set(ref, next);
    });
    await reconcile();
    return config();
  }
  async function changeConfiguration(id, input, user, mode) {
    if (mode !== 'create') configurationId(id);
    const value = mode === 'remove' ? null : validateConfiguration(input);
    if (mode === 'create') {
      if (input.idempotencyKey !== undefined && (typeof input.idempotencyKey !== 'string' || !/^[\w-]{8,100}$/.test(input.idempotencyKey))) throw new HttpError(400, 'A valid idempotency key is required.');
      id = `config-${input.idempotencyKey ? operationId(user, 'configuration-create', input.idempotencyKey).slice(0, 32) : crypto.randomUUID()}`;
    }
    await db.runTransaction(async (tx) => {
      const current = (await tx.get(ref)).data();
      if (!current) throw new HttpError(503, 'Cloud configuration has not been initialized.');
      const items = configurationsOf(current);
      const existing = items.find((item) => item.id === id);
      if (mode === 'create' && existing) {
        if (existing.name !== value.name || existing.enabled !== value.enabled || existing.timezone !== value.timezone
          || JSON.stringify(existing.settings) !== JSON.stringify(value.settings)) throw new HttpError(409, 'Configuration was already saved. Reload it before making further changes.');
        return;
      }
      if (mode !== 'create' && !existing) throw new HttpError(404, 'Configuration not found.');
      if (mode !== 'create' && input.baseVersion !== existing.version) throw new HttpError(409, 'Configuration changed. Reload before saving.');
      if (mode === 'create' && items.length >= MAX_CONFIGURATIONS) throw new HttpError(400, `At most ${MAX_CONFIGURATIONS} configurations are supported.`);
      if (value?.enabled && (current.maintenance || current.authStatus !== 'linked')) throw new HttpError(409, 'Link WhatsApp and finish maintenance before enabling runs.');
      if (mode === 'remove' && current.activeOperation) throw new HttpError(409, 'Wait for the active operation before removing a configuration.');
      if (mode === 'remove' && (existing.queueCount || existing.pendingReportCount)) throw new HttpError(409, 'This configuration has pending work. Run it before removing it.');
      const changes = value && { ...existing, ...value, id, version: (existing?.version || 0) + 1,
        createdAt: existing?.createdAt || iso(), updatedAt: iso(), updatedBy: user,
        ...(!existing || existing.enabled !== value.enabled || existing.timezone !== value.timezone
          || existing.settings.period !== value.settings.period ? { scheduleStartedAt: iso(), lastScheduledSlot: null } : {}) };
      const configurations = mode === 'create' ? [...items, changes]
        : mode === 'remove' ? items.filter((item) => item.id !== id) : items.map((item) => item.id === id ? changes : item);
      const next = { ...withConfigurations(current, configurations), updatedAt: iso(), updatedBy: user };
      tx.create(ref.collection('versions').doc(String(next.activeVersion)), { ...configurationSnapshot(next), createdAt: iso(), createdBy: user });
      tx.set(ref, next);
    });
    await reconcile();
    return { id, ...(await overview()) };
  }
  async function refreshOperation(id) {
    if (!id) return null;
    const record = (await opRef(id).get()).data();
    if (!record || !activeOperation(record) || Date.now() - Date.parse(record.updatedAt) < 20000) return record;
    try {
      const execution = await google.execution(record);
      const completed = execution?.completionTime || execution?.conditions?.some((c) => c.type === 'Completed' && c.state === 'CONDITION_FAILED');
      const expired = !execution && Date.now() - Date.parse(record.createdAt) > 15 * 60000;
      if (completed || expired) {
        const status = record.status === 'cancelling' ? 'cancelled' : 'failed';
        await db.runTransaction(async (tx) => {
          const current = (await tx.get(opRef(id))).data();
          const cfg = (await tx.get(ref)).data();
          if (!activeOperation(current)) return;
          tx.update(opRef(id), { status, qr: null, updatedAt: iso(), error: 'Worker ended before confirming completion. Pending work is preserved.' });
          if (cfg.activeOperation === id) tx.update(ref, { activeOperation: null, maintenance: false });
        });
      }
    } catch { /* Keep the durable state on transient monitoring API errors. */ }
    return (await opRef(id).get()).data();
  }
  async function start(mode, key, user, selection) {
    if (!['summary', 'pair'].includes(mode) || typeof key !== 'string' || !/^[\w-]{8,100}$/.test(key)) throw new HttpError(400, 'A valid idempotency key is required.');
    if (selection !== undefined && selection !== 'all') configurationId(selection);
    const id = operationId(user, selection ? `${mode}:${selection}` : mode, key);
    const existing = (await opRef(id).get()).data();
    if (existing) return { id, status: existing.status };
    const latest = await config();
    await refreshOperation(latest.activeOperation);
    const result = await db.runTransaction(async (tx) => {
      const old = (await tx.get(opRef(id))).data();
      const cfg = (await tx.get(ref)).data();
      const current = cfg.activeOperation ? (await tx.get(opRef(cfg.activeOperation))).data() : null;
      if (old) return { fresh: false, cfg, record: old };
      if (activeOperation(current)) throw new HttpError(409, 'Another operation is active. Wait for it to finish.');
      if (mode === 'summary' && ((!selection && !cfg.enabled) || cfg.maintenance || cfg.authStatus !== 'linked'
        || cfg.scheduleStatus !== 'applied' || cfg.appliedScheduleRevision !== cfg.scheduleRevision)) throw new HttpError(409, 'Use a linked device with an applied schedule before running.');
      const configurations = configurationsOf(cfg);
      const selected = selection === 'all' ? configurations : configurations.filter((item) => item.id === selection);
      if (mode === 'summary' && selection && !selected.length) throw new HttpError(404, 'Configuration not found.');
      const changes = mode === 'pair' ? { enabled: false, maintenance: true,
        scheduleRevision: cfg.scheduleRevision + 1, scheduleStatus: 'pending', latestPairing: id } : {};
      if (mode === 'pair' && cfg.configurations) {
        changes.configurations = configurations.map((item) => ({ ...item, enabled: false, version: item.version + 1 }));
        changes.activeVersion = cfg.activeVersion + 1;
        tx.create(ref.collection('versions').doc(String(changes.activeVersion)), {
          ...configurationSnapshot({ ...cfg, ...changes }), createdAt: iso(), createdBy: user });
      }
      const record = { id, mode, owner: user, status: 'queued', createdAt: iso(), updatedAt: iso(), qr: null,
        ...(selection ? { configurationIds: selected.map((item) => item.id), configVersion: cfg.activeVersion } : {}) };
      tx.create(opRef(id), record);
      tx.update(ref, { ...changes, activeOperation: id });
      return { fresh: true, cfg: { ...cfg, ...changes }, record };
    });
    if (!result.fresh) return { id, status: result.record.status };
    try {
      if (mode === 'pair') await reconcile();
      const launched = await google.start(mode, { CONFIG_ID: env.configId, REQUEST_ID: id,
        SCHEDULE_REVISION: result.cfg.scheduleRevision,
        CONFIGURATION_IDS: result.record.configurationIds?.join(',') || '' });
      await opRef(id).set(launched, { merge: true });
    } catch (error) {
      // An ambiguous HTTP result could have started a worker. Do not auto-start
      // a second execution; reconciliation observes its execution/lease state.
      await opRef(id).set({ launchError: 'Could not confirm Job launch. Check status before retrying.', updatedAt: iso() }, { merge: true });
      throw error instanceof HttpError ? error : new HttpError(503, 'Could not confirm Job launch. Check status before retrying.');
    }
    return { id, status: 'queued' };
  }
  async function pairing(user) {
    const cfg = await config();
    if (!cfg.latestPairing) return null;
    const record = await refreshOperation(cfg.latestPairing);
    if (!record) return null;
    const { qr, ...safe } = record;
    return { ...safe, qr: record.owner === user && record.status === 'running' && record.qrExpiresAt > Date.now() ? qr : null };
  }
  async function cancelPairing(user) {
    const cfg = await config();
    if (!cfg.latestPairing) throw new HttpError(404, 'No pairing attempt.');
    const record = (await opRef(cfg.latestPairing).get()).data();
    if (record.owner !== user) throw new HttpError(403, 'Only the initiating administrator can cancel pairing.');
    if (!activeOperation(record)) return;
    await opRef(record.id).update({ status: 'cancelling', qr: null, updatedAt: iso() });
    const stopped = await google.cancel(record);
    if (!stopped) throw new HttpError(409, 'Launch is still pending. Cancellation is recorded; retry to stop the execution.');
    await opRef(record.id).update({ status: 'cancelled', updatedAt: iso() });
    await db.runTransaction(async (tx) => {
      if ((await tx.get(ref)).data().activeOperation === record.id) tx.update(ref, { enabled: false, maintenance: false, activeOperation: null });
    });
  }
  async function overview() {
    const cfg = await config();
    await refreshOperation(cfg.activeOperation);
    const latest = await config();
    const recent = await ref.collection('operations').orderBy('createdAt', 'desc').limit(12).get();
    const configurations = configurationsOf(latest).map((item) => {
      const next = nextRunAt({ ...item, maintenance: latest.maintenance,
        scheduleStatus: latest.appliedScheduleRevision === latest.scheduleRevision ? latest.scheduleStatus : 'pending' });
      return { ...item, nextRunAt: next && latest.configurations
        ? new Date(Math.ceil(Date.parse(next) / 1800000) * 1800000).toISOString() : next };
    });
    return { config: latest, configurations, nextRunAt: configurations.map((item) => item.nextRunAt).filter(Boolean).sort()[0] || null, operations: recent.docs.map((d) => {
      const { qr, ...safe } = d.data(); return safe;
    }) };
  }
  return { ref, opRef, config, update, reconcile, start, pairing, cancelPairing, overview, refreshOperation,
    createConfiguration: (input, user) => changeConfiguration(null, input, user, 'create'),
    updateConfiguration: (id, input, user) => changeConfiguration(id, input, user, 'update'),
    removeConfiguration: (id, input, user) => changeConfiguration(id, input, user, 'remove') };
}
