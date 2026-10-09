import { execFileSync } from 'node:child_process';

export function guardLegacyDeployment({ variables = process.env, describe = (args) => execFileSync('gcloud', args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } = {}) {
  const blocked = () => { throw new Error('Workspace mode is active. Use scripts/workspace-gcp.js; legacy deployment would restore shared access.'); };
  if (variables.WORKSPACE_MODE === 'true') blocked();
  let service;
  try {
    service = JSON.parse(describe(['run', 'services', 'describe', 'whatsapp-admin',
      `--project=${variables.GOOGLE_CLOUD_PROJECT}`, `--region=${variables.GCP_REGION || 'europe-west4'}`, '--format=json']));
  } catch (error) {
    if (/NOT_FOUND|not found|does not exist|was not found/i.test(String(error.stderr))) return;
    throw new Error('Cannot verify deployment mode. Check project access before deploying.');
  }
  if (service.spec?.template?.spec?.containers?.some((container) => container.env?.some((entry) => entry.name === 'WORKSPACE_MODE' && entry.value === 'true'))) blocked();
}

if (process.argv[1]?.endsWith('/guard-legacy-deployment.js')) {
  try { guardLegacyDeployment(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
