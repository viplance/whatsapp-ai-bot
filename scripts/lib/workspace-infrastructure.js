import { subjectKey, validId, workspaceEnvironment } from '../../src/cloud/workspaces.js';

export function workspaceResources({ projectId, ownerSubject, name = 'Personal workspace' }) {
  if (typeof ownerSubject !== 'string' || !ownerSubject.trim() || ownerSubject.length > 500) throw new Error('A verified IAP owner subject is required');
  if (typeof name !== 'string' || !name.trim() || name.length > 100) throw new Error('A workspace name is required');
  const suffix = subjectKey(ownerSubject).slice(0, 16), prefix = `wa-${suffix}`;
  return { id: `ws-${suffix}`, name: name.trim(), ownerSubject, status: 'provisioning',
    controlDatabase: `${prefix}-control`, runtimeDatabase: `${prefix}-runtime`,
    summaryJob: `${prefix}-summary`, pairingJob: `${prefix}-pair`,
    summaryAccount: `${prefix}-summary@${projectId}.iam.gserviceaccount.com`,
    pairingAccount: `${prefix}-pair@${projectId}.iam.gserviceaccount.com`, geminiSecret: `${prefix}-gemini` };
}

export function workspaceDeploymentPlan({ env, workspace, image, registryUrl }) {
  workspaceEnvironment(env, workspace);
  if (!image || !registryUrl?.startsWith('https://')) throw new Error('IMAGE and the registry service URL are required');
  const project = `--project=${env.projectId}`, region = `--region=${env.region}`;
  const admin = `whatsapp-admin@${env.projectId}.iam.gserviceaccount.com`, broker = `whatsapp-registry@${env.projectId}.iam.gserviceaccount.com`;
  const dispatcher = `whatsapp-dispatcher@${env.projectId}.iam.gserviceaccount.com`;
  const plan = [];
  for (const database of [workspace.controlDatabase, workspace.runtimeDatabase]) plan.push({
    check: ['firestore', 'databases', 'describe', project, `--database=${database}`],
    args: ['firestore', 'databases', 'create', project, `--database=${database}`, `--location=${env.region}`, '--type=firestore-native', '--delete-protection', '--quiet'] });
  for (const email of [workspace.summaryAccount, workspace.pairingAccount]) {
    const name = email.split('@')[0];
    if (!validId(name) || name.length > 30) throw new Error('Invalid worker service account');
    plan.push({ check: ['iam', 'service-accounts', 'describe', email, project], args: ['iam', 'service-accounts', 'create', name, project, '--quiet'] });
  }
  for (const [email, databases] of [[admin, [workspace.controlDatabase]], [broker, [workspace.controlDatabase]],
    [workspace.summaryAccount, [workspace.controlDatabase, workspace.runtimeDatabase]], [workspace.pairingAccount, [workspace.controlDatabase, workspace.runtimeDatabase]]]) {
    const expression = databases.map((id) => `resource.name=='projects/${env.projectId}/databases/${id}'`).join(' || ');
    plan.push({ args: ['projects', 'add-iam-policy-binding', env.projectId, `--member=serviceAccount:${email}`, '--role=roles/datastore.user',
      `--condition=title=${workspace.id}-${email.split('@')[0]},expression=${expression}`, '--quiet'] });
  }
  const common = { GOOGLE_CLOUD_PROJECT: env.projectId, GCP_REGION: env.region, WORKSPACE_ID: workspace.id,
    CONTROL_DATABASE: workspace.controlDatabase, RUNTIME_DATABASE: workspace.runtimeDatabase,
    REGISTRY_SERVICE_URL: registryUrl, SUMMARY_JOB: workspace.summaryJob, PAIRING_JOB: workspace.pairingJob };
  const variables = Object.entries(common).map(([key, value]) => `${key}=${value}`).join(',');
  for (const mode of ['summary', 'pair']) {
    const job = mode === 'summary' ? workspace.summaryJob : workspace.pairingJob;
    const email = mode === 'summary' ? workspace.summaryAccount : workspace.pairingAccount;
    plan.push({ args: ['run', 'jobs', 'deploy', job, project, region, `--image=${image}`, `--service-account=${email}`,
      '--command=node', `--args=src/cloud/worker.js,${mode === 'summary' ? '--once' : '--pair'}`, `--set-env-vars=${variables}`,
      '--cpu=1', '--memory=512Mi', '--tasks=1', '--parallelism=1', `--task-timeout=${mode === 'summary' ? 600 : 300}s`,
      `--max-retries=${mode === 'summary' ? 1 : 0}`, mode === 'summary' ? `--set-secrets=GEMINI_API_KEY=${workspace.geminiSecret}:latest` : '--clear-secrets', '--quiet'] });
    for (const role of ['roles/run.jobsExecutor', 'roles/run.viewer']) plan.push({ args: ['run', 'jobs', 'add-iam-policy-binding', job, project, region,
      `--member=serviceAccount:${admin}`, `--role=${role}`, '--quiet'] });
    plan.push({ args: ['run', 'jobs', 'add-iam-policy-binding', job, project, region, `--member=serviceAccount:${dispatcher}`, '--role=roles/run.invoker', '--quiet'] });
    plan.push({ args: ['run', 'services', 'add-iam-policy-binding', 'whatsapp-registry', project, region, `--member=serviceAccount:${email}`, '--role=roles/run.invoker', '--quiet'] });
  }
  return plan;
}
