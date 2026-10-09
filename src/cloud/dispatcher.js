import { Firestore } from '@google-cloud/firestore';
import { cloudEnvironment } from './env.js';
import { createGoogleApi } from './google.js';
import { workspaceEnvironment, validId } from './workspaces.js';
import { logWorkerEvent } from './logging.js';

export async function dispatchWorkspaces({ env = cloudEnvironment(), registryDb = new Firestore({ projectId: env.projectId, databaseId: env.registryDatabase }),
  googleFactory = (scopedEnv) => createGoogleApi({ env: scopedEnv, fixed: true }), now = new Date(), log = logWorkerEvent } = {}) {
  // Read the complete index so a fixed limit cannot silently skip workspaces.
  const entries = await registryDb.collection('dispatch').get();
  let launched = 0, failed = 0;
  for (const doc of entries.docs) {
    const hint = doc.data();
    if (!validId(hint.workspaceId) || hint.workspaceId !== doc.id) continue;
    const workspace = (await registryDb.doc(`workspaces/${hint.workspaceId}`).get()).data();
    if (workspace?.status !== 'active') continue;
    try {
      if (workspace.id !== hint.workspaceId) throw new Error('Invalid workspace registration');
      const api = googleFactory(workspaceEnvironment(env, workspace));
      if (hint.pairPending) { await api.start('pair'); launched++; }
      // A small idle probe also repairs missed index writes and expired claims.
      if ((hint.nextSummaryAt && Date.parse(hint.nextSummaryAt) <= now.getTime())
        || !hint.lastProbeAt || now.getTime() - Date.parse(hint.lastProbeAt) >= 3600000) {
        const count = Math.min(2, Math.max(1, Number(hint.summaryLaunches) || 1));
        for (let i = 0; i < count; i++) { await api.start('summary'); launched++; }
        await doc.ref.set({ lastProbeAt: now.toISOString() }, { merge: true });
      }
    } catch { failed++; log({ event: 'workspace_dispatch_failed', workspaceId: hint.workspaceId }); }
  }
  log({ event: 'workspace_dispatch_finished', launched, failed });
  if (failed) throw new Error('Workspace dispatch failed');
  return { launched, failed };
}
if (process.argv[1]?.endsWith('/cloud/dispatcher.js')) {
  try { await dispatchWorkspaces(); } catch { process.exitCode = 1; }
}
