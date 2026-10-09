import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { cliAuth, cliDatabase } from './cloud-client.js';
import { cloudEnvironment } from '../src/cloud/env.js';
import { acquireLease } from '../src/cloud/lease.js';
import { subjectKey, publishDueIndex } from '../src/cloud/workspaces.js';
import { workspaceDeploymentPlan, workspaceResources } from './lib/workspace-infrastructure.js';
import { copyTree, freezeAccount, migrationAccountId, migrationTransforms } from './lib/workspace-migration.js';
import { verifyWorkspaceIam, verifyWorkspaceIamWithRetry } from './lib/workspace-verification.js';

const keySecret = 'whatsapp-account-registry-key';
const iso = () => new Date().toISOString();
const gcloud = (args, input) => execFileSync('gcloud', args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 10 * 1024 * 1024 }).trim();
const exists = (args) => { try { gcloud(args); return true; } catch (error) {
  if (!/NOT_FOUND|not found|does not exist|was not found/i.test(String(error.stderr))) throw new Error('GCP resource lookup failed'); return false;
} };
const ensure = (check, args) => { if (!exists(check)) gcloud(args); };

export async function workspaceCli(args = process.argv.slice(2), variables = process.env) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    apply: { type: 'boolean', default: false }, 'owner-sub': { type: 'string' }, 'owner-email': { type: 'string' },
    name: { type: 'string' }, image: { type: 'string' }, 'registry-url': { type: 'string' },
    'gemini-key-file': { type: 'string' }, 'from-secret': { type: 'string' },
  } });
  const action = positionals[0], env = cloudEnvironment(variables);
  const project = `--project=${env.projectId}`, region = `--region=${env.region}`;
  const image = values.image || variables.IMAGE;
  const allowed = ['identity', 'deploy-shared', 'provision', 'migrate', 'verify', 'deploy-admin', 'retire-legacy'];
  if (!allowed.includes(action) || positionals.length !== 1) throw new Error(`Choose one action: ${allowed.join(', ')}`);
  if (!['identity', 'verify', 'retire-legacy'].includes(action) && !image) throw new Error('Set IMAGE or pass --image with the built container digest.');
  const workspace = ['provision', 'migrate', 'verify'].includes(action) ? workspaceResources({ projectId: env.projectId,
    ownerSubject: values['owner-sub'], name: values.name }) : null;
  if (['provision', 'migrate'].includes(action) && (!values['owner-email'] || !/^[^\s,]+@[^\s,]+\.[^\s,]+$/.test(values['owner-email']))) throw new Error('Pass the verified owner email for IAP admission.');
  if (values['from-secret'] && action !== 'migrate') throw new Error('Copying an existing Gemini secret is limited to the owner migration.');
  if (!values.apply) {
    const commands = workspace && action !== 'verify' ? workspaceDeploymentPlan({ env, workspace, image,
      registryUrl: values['registry-url'] || env.registryServiceUrl || 'https://registry.example.invalid' }).map((entry) => entry.args) : [];
    const steps = {
      identity: ['Read the authenticated Google subject and verified email; do not mutate resources.'],
      'deploy-shared': ['Enable required APIs; create registry database and shared service accounts.',
        'Grant database-scoped registry access; create an HMAC secret readable only by the registry service.',
        'Deploy private registry service and fixed dispatcher Job; register the service URL.',
        'Create a 30-minute UTC Scheduler trigger, initially paused; preserve an existing trigger state.'],
      provision: ['Register explicit owner membership with access closed during provisioning.',
        'Create a workspace Gemini secret; grant access only to its summary worker.',
        'Execute the database and fixed-Job commands below; register workload identities.',
        'Verify effective database, secret, Job and impersonation permissions before activation.',
        'Activate the workspace, publish dispatch hints and admit the owner through IAP.'],
      migrate: ['Provision isolated resources and verify effective IAM before moving data.',
        'Upgrade legacy Jobs/admin to understand migration freezes; pause the old Scheduler.',
        'Atomically save original configuration and freeze all legacy launch/edit paths.',
        'Acquire the device lease; copy session, queues, delivery progress and IDs; verify digests.',
        'Bind the existing WhatsApp account to its owner workspace; retain frozen source data.',
        'Activate the workspace and publish dispatch hints; admin cutover is a separate action.'],
      verify: ['Impersonate service accounts for read-only allow/deny checks.',
        'Verify workers cannot read foreign databases/secrets and launchers cannot override or impersonate workers.'],
      'deploy-admin': ['Require an active owner workspace; update the existing IAP service image.',
        'Enable membership-based workspace mode; preserve existing OAuth/IAP configuration.'],
      'retire-legacy': ['Require the admin already in workspace mode; pause the old Scheduler.',
        'Remove old Job launch/view grants and admin Scheduler/legacy service-account grants.',
        'Remove the admin legacy-database grant; resume the shared dispatcher trigger.'],
    }[action];
    console.log(JSON.stringify({ action, dryRun: true, workspaceId: workspace?.id, steps, commands,
      note: 'No GCP calls made. Add --apply after reviewing the rollout guide. Secrets and owner identity are omitted.' }, null, 2));
    return;
  }
  const databases = new Map();
  const database = (id, auth) => {
    if (auth) { const db = cliDatabase(env.projectId, id, auth); databases.set(Symbol(), db); return db; }
    if (!databases.has(id)) databases.set(id, cliDatabase(env.projectId, id)); return databases.get(id);
  };
  const registryDb = database(env.registryDatabase);
  const email = (name) => `${name}@${env.projectId}.iam.gserviceaccount.com`;
  const createAccount = (name) => ensure(['iam', 'service-accounts', 'describe', email(name), project], ['iam', 'service-accounts', 'create', name, project, '--quiet']);
  const createDatabase = (id) => ensure(['firestore', 'databases', 'describe', project, `--database=${id}`],
    ['firestore', 'databases', 'create', project, `--database=${id}`, `--location=${env.region}`, '--type=firestore-native', '--delete-protection', '--quiet']);
  const databaseGrant = (identity, id, title) => gcloud(['projects', 'add-iam-policy-binding', env.projectId, `--member=serviceAccount:${identity}`, '--role=roles/datastore.user',
    `--condition=title=${title},expression=resource.name=='projects/${env.projectId}/databases/${id}'`, '--quiet']);
  const secretReady = (name) => exists(['secrets', 'versions', 'access', 'latest', project, `--secret=${name}`]);
  const seedSecret = (name, content) => {
    ensure(['secrets', 'describe', name, project], ['secrets', 'create', name, project, '--replication-policy=automatic', '--quiet']);
    if (!secretReady(name)) {
      if (!content) throw new Error('The workspace Gemini secret needs a key file.');
      gcloud(['secrets', 'versions', 'add', name, project, '--data-file=-', '--quiet'], content);
    }
  };
  const accountKey = () => gcloud(['secrets', 'versions', 'access', 'latest', project, `--secret=${keySecret}`]);
  const runPlan = (plan) => { for (const entry of plan) entry.check ? ensure(entry.check, entry.args) : gcloud(entry.args); };
  async function registerWorkspace(status) {
    const ref = registryDb.doc(`workspaces/${workspace.id}`), memberRef = registryDb.doc(`members/${subjectKey(workspace.ownerSubject)}`);
    await registryDb.runTransaction(async (tx) => {
      const old = (await tx.get(ref)).data(), member = (await tx.get(memberRef)).data();
      if ((old && old.ownerSubject !== workspace.ownerSubject) || (member && member.workspaceId !== workspace.id)) throw new Error('Owner is already assigned to a different workspace');
      if (old && ['id', 'controlDatabase', 'runtimeDatabase', 'summaryJob', 'pairingJob', 'summaryAccount', 'pairingAccount', 'geminiSecret']
        .some((field) => old[field] !== workspace[field])) throw new Error('Workspace resource registration has changed; review it before provisioning');
      tx.set(ref, { ...workspace, ...(old || {}), status: old?.status === 'active' ? 'active' : status, updatedAt: iso() });
      tx.set(memberRef, { subject: workspace.ownerSubject, workspaceId: workspace.id, role: 'owner', status: 'active' });
    });
  }
  async function provision(migrating) {
    // Create databases before writing registration; keep the workspace closed until IAM verification.
    for (const id of [workspace.controlDatabase, workspace.runtimeDatabase]) createDatabase(id);
    await registerWorkspace(migrating ? 'migrating' : 'provisioning');
    const secret = values['gemini-key-file'] ? readFileSync(values['gemini-key-file'])
      : values['from-secret'] ? gcloud(['secrets', 'versions', 'access', 'latest', project, `--secret=${values['from-secret']}`]) : undefined;
    seedSecret(workspace.geminiSecret, secret);
    gcloud(['secrets', 'add-iam-policy-binding', workspace.geminiSecret, project, `--member=serviceAccount:${workspace.summaryAccount}`, '--role=roles/secretmanager.secretAccessor', '--quiet']);
  }
  try {
    if (action === 'identity') {
      const info = (await (await cliAuth().getClient()).request({ url: 'https://www.googleapis.com/oauth2/v3/userinfo', timeout: 30000, retry: false })).data;
      if (!info.sub || !info.email || info.email_verified !== true) throw new Error('A verified Google identity is required');
      console.log(JSON.stringify({ ownerSubject: `accounts.google.com:${info.sub}`, ownerEmail: info.email }));
    } else if (action === 'deploy-shared') {
      gcloud(['services', 'enable', 'run.googleapis.com', 'firestore.googleapis.com', 'cloudscheduler.googleapis.com', 'iap.googleapis.com',
        'iam.googleapis.com', 'iamcredentials.googleapis.com', 'secretmanager.googleapis.com', project, '--quiet']);
      createDatabase(env.registryDatabase);
      for (const name of ['whatsapp-admin', 'whatsapp-registry', 'whatsapp-dispatcher', 'whatsapp-clock']) createAccount(name);
      for (const name of ['whatsapp-admin', 'whatsapp-registry', 'whatsapp-dispatcher']) databaseGrant(email(name), env.registryDatabase, `${name}-registry`);
      if (exists(['secrets', 'describe', keySecret, project])) {
        if (!secretReady(keySecret)) throw new Error('Restore the original registry key version; do not replace an existing account registry key');
      } else seedSecret(keySecret, randomBytes(32).toString('hex'));
      gcloud(['secrets', 'add-iam-policy-binding', keySecret, project, `--member=serviceAccount:${email('whatsapp-registry')}`, '--role=roles/secretmanager.secretAccessor', '--quiet']);
      const sharedEnv = `GOOGLE_CLOUD_PROJECT=${env.projectId},GCP_REGION=${env.region},REGISTRY_DATABASE=${env.registryDatabase}`;
      gcloud(['run', 'deploy', 'whatsapp-registry', project, region, `--image=${image}`, `--service-account=${email('whatsapp-registry')}`,
        '--command=node', '--args=src/cloud/registry-service.js', `--set-env-vars=${sharedEnv},REGISTRY_SERVICE_URL=https://bootstrap.invalid`,
        `--set-secrets=ACCOUNT_REGISTRY_KEY=${keySecret}:latest`, '--cpu=1', '--memory=256Mi', '--min-instances=0', '--max-instances=2', '--no-allow-unauthenticated', '--quiet']);
      const url = gcloud(['run', 'services', 'describe', 'whatsapp-registry', project, region, '--format=value(status.url)']);
      gcloud(['run', 'services', 'update', 'whatsapp-registry', project, region, `--update-env-vars=REGISTRY_SERVICE_URL=${url}`, '--quiet']);
      await registryDb.doc('platform/settings').set({ registryServiceUrl: url, image }, { merge: true });
      gcloud(['run', 'jobs', 'deploy', 'whatsapp-dispatcher', project, region, `--image=${image}`, `--service-account=${email('whatsapp-dispatcher')}`,
        '--command=node', '--args=src/cloud/dispatcher.js', `--set-env-vars=${sharedEnv}`, '--cpu=1', '--memory=512Mi', '--tasks=1', '--parallelism=1', '--task-timeout=600s', '--max-retries=1', '--clear-secrets', '--quiet']);
      gcloud(['run', 'jobs', 'add-iam-policy-binding', 'whatsapp-dispatcher', project, region, `--member=serviceAccount:${email('whatsapp-clock')}`, '--role=roles/run.invoker', '--quiet']);
      const hasClock = exists(['scheduler', 'jobs', 'describe', 'whatsapp-dispatch', project, `--location=${env.region}`]);
      gcloud(['scheduler', 'jobs', hasClock ? 'update' : 'create', 'http', 'whatsapp-dispatch', project, `--location=${env.region}`, '--schedule=*/30 * * * *', '--time-zone=UTC',
        `--uri=https://run.googleapis.com/v2/projects/${env.projectId}/locations/${env.region}/jobs/whatsapp-dispatcher:run`, '--http-method=POST',
        '--headers=Content-Type=application/json', '--message-body={}', `--oauth-service-account-email=${email('whatsapp-clock')}`, '--quiet']);
      if (!hasClock) gcloud(['scheduler', 'jobs', 'pause', 'whatsapp-dispatch', project, `--location=${env.region}`, '--quiet']);
      console.log('Shared resources ready. The new clock starts paused; the existing admin and schedule are unchanged.');
    } else if (['provision', 'migrate'].includes(action)) {
      if (action === 'migrate' && (await registryDb.doc(`workspaces/${workspace.id}`).get()).data()?.status === 'active') throw new Error('Workspace is already active; migration will not overwrite it');
      createAccount(workspace.summaryAccount.split('@')[0]); createAccount(workspace.pairingAccount.split('@')[0]);
      await provision(action === 'migrate');
      const url = values['registry-url'] || env.registryServiceUrl || (await registryDb.doc('platform/settings').get()).data()?.registryServiceUrl;
      runPlan(workspaceDeploymentPlan({ env, workspace, image, registryUrl: url }));
      const db = database(workspace.controlDatabase), runtimeDb = database(workspace.runtimeDatabase);
      const metaRef = db.doc('workspace/meta');
      if (!(await metaRef.get()).exists) await metaRef.set({ id: workspace.id, name: workspace.name, status: action === 'migrate' ? 'migrating' : 'active', deviceCount: 0 });
      const key = accountKey();
      for (const [mode, identity] of [['summary', workspace.summaryAccount], ['pair', workspace.pairingAccount]]) await registryDb.doc(`workloads/${createHmac('sha256', key).update(identity).digest('hex')}`).set({ workspaceId: workspace.id, email: identity, mode });
      await verifyWorkspaceIamWithRetry({ env, workspace, registryDb, database });
      if (action === 'migrate') {
        const sourceControl = database(env.controlDatabase), sourceRuntime = database(env.runtimeDatabase), sourceRef = sourceControl.doc(`configs/${env.configId}`);
        const current = (await sourceRef.get()).data();
        if (!current || current.activeOperation) throw new Error('Finish active operations before migration');
        // Upgrade legacy endpoints first so every launch path honors the freeze marker.
        for (const job of [env.summaryJob, env.pairingJob]) gcloud(['run', 'jobs', 'update', job, project, region, `--image=${image}`, '--quiet']);
        gcloud(['run', 'services', 'update', 'whatsapp-admin', project, region, `--image=${image}`, '--quiet']);
        gcloud(['scheduler', 'jobs', 'pause', env.schedulerJob, project, `--location=${env.region}`, '--quiet']);
        const original = await freezeAccount({ sourceDb: sourceControl, deviceId: env.configId, workspaceId: workspace.id, ownerSubject: workspace.ownerSubject });
        const lease = await acquireLease({ db: sourceRuntime, configId: env.configId, owner: `migration-${workspace.id}`, ttlMs: 300000 });
        if (!lease) throw new Error('Another process holds the device lease; source stays paused');
        try {
          const account = (await sourceRuntime.doc(`accounts/${env.configId}`).get()).data();
          const creds = account?.activeGeneration ? (await sourceRuntime.doc(`accounts/${env.configId}/sessions/${account.activeGeneration}`).get()).data()?.creds : null;
          const roots = [sourceRuntime.doc(`accounts/${env.configId}`), ...(original.configurations || [])
            .filter((profile) => profile.id !== 'default').map((profile) => sourceRuntime.doc(`accounts/${env.configId}/configurations/${profile.id}`))];
          const pending = await Promise.all(roots.flatMap((root) => ['messages', 'reports'].map((collection) => root.collection(collection).limit(1).get())));
          await lease.renew();
          const accountId = migrationAccountId({ original, account, creds, hasPendingWork: pending.some((result) => result.docs.length) });
          const fingerprint = accountId ? createHmac('sha256', key).update(accountId).digest('hex') : null;
          if (fingerprint) await registryDb.runTransaction(async (tx) => {
            const ownershipRef = registryDb.doc(`accounts/${fingerprint}`), deviceRef = registryDb.doc(`deviceAccounts/${workspace.id}--${env.configId}`);
            const existing = (await tx.get(ownershipRef)).data(), bound = (await tx.get(deviceRef)).data();
            if ((existing && (existing.workspaceId !== workspace.id || existing.deviceId !== env.configId)) || (bound && bound.fingerprint !== fingerprint)) throw new Error('WhatsApp account is already assigned elsewhere');
            tx.set(ownershipRef, { workspaceId: workspace.id, deviceId: env.configId }); tx.set(deviceRef, { fingerprint });
          });
          const transforms = migrationTransforms({ original, workspaceId: workspace.id, deviceId: env.configId,
            ownerSubject: workspace.ownerSubject, ownerEmail: values['owner-email'], accountFingerprint: fingerprint });
          const control = await copyTree({ source: sourceRef, destination: db, transform: transforms.control, checkpoint: () => lease.renew() });
          const runtime = await copyTree({ source: sourceRuntime.doc(`accounts/${env.configId}`), destination: runtimeDb, transform: transforms.runtime, checkpoint: () => lease.renew() });
          await db.doc(`configs/${env.configId}/versions/${transforms.device.activeVersion}`).set(transforms.snapshot);
          await metaRef.update({ status: 'active', deviceCount: 1 });
          await db.doc('migration/result').set({ control, runtime, sourceConfigId: env.configId, completedAt: iso() });
        } finally { await lease.release(); }
      }
      await registryDb.doc(`workspaces/${workspace.id}`).update({ status: 'active' });
      await publishDueIndex({ registryDb, controlDb: db, workspaceId: workspace.id });
      gcloud(['iap', 'web', 'add-iam-policy-binding', project, region, '--resource-type=cloud-run', '--service=whatsapp-admin',
        `--member=user:${values['owner-email']}`, '--role=roles/iap.httpsResourceAccessor', '--quiet']);
      console.log('Workspace resources and IAM checks passed. Data access is bound to the specified owner subject.');
    } else if (action === 'verify') {
      const registered = (await registryDb.doc(`workspaces/${workspace.id}`).get()).data();
      if (!registered) throw new Error('Workspace is not registered');
      await verifyWorkspaceIam({ env, workspace: registered, registryDb, database });
      console.log('Workspace IAM checks passed; no WhatsApp connection or message send was performed.');
    } else if (action === 'deploy-admin') {
      const active = (await registryDb.collection('workspaces').get()).docs.filter((doc) => doc.data().status === 'active');
      if (!active.length) throw new Error('Provision or migrate an owner workspace first');
      // Preserve the existing IAP/OAuth setup; switch only image and workspace mode.
      gcloud(['run', 'services', 'update', 'whatsapp-admin', project, region, `--image=${image}`,
        `--update-env-vars=WORKSPACE_MODE=true,REGISTRY_DATABASE=${env.registryDatabase}`, '--quiet']);
      console.log('Workspace admin deployed. Verify sign-in before retiring the old trigger.');
    } else if (action === 'retire-legacy') {
      const adminMode = gcloud(['run', 'services', 'describe', 'whatsapp-admin', project, region, '--format=json(spec.template.spec.containers[0].env)']);
      if (!JSON.parse(adminMode).spec.template.spec.containers[0].env.some((item) => item.name === 'WORKSPACE_MODE' && item.value === 'true')) throw new Error('Deploy and verify workspace admin before cutover');
      gcloud(['scheduler', 'jobs', 'pause', env.schedulerJob, project, `--location=${env.region}`, '--quiet']);
      for (const principal of [email('whatsapp-admin'), env.schedulerAccount]) for (const job of [env.summaryJob, env.pairingJob]) {
        const policy = JSON.parse(gcloud(['run', 'jobs', 'get-iam-policy', job, project, region, '--format=json']));
        for (const role of ['roles/run.jobsExecutorWithOverrides', 'roles/run.viewer']) if (policy.bindings?.some((item) => item.role === role && item.members.includes(`serviceAccount:${principal}`)))
          gcloud(['run', 'jobs', 'remove-iam-policy-binding', job, project, region, `--member=serviceAccount:${principal}`, `--role=${role}`, '--quiet']);
      }
      const policy = JSON.parse(gcloud(['projects', 'get-iam-policy', env.projectId, '--format=json']));
      const role = `projects/${env.projectId}/roles/whatsappScheduleEditor`;
      if (policy.bindings?.some((item) => item.role === role && item.members.includes(`serviceAccount:${email('whatsapp-admin')}`)))
        gcloud(['projects', 'remove-iam-policy-binding', env.projectId, `--member=serviceAccount:${email('whatsapp-admin')}`, `--role=${role}`, '--condition=None', '--quiet']);
      const legacyDatabaseGrant = policy.bindings?.find((item) => item.role === 'roles/datastore.user'
        && item.condition?.title === 'whatsapp-admin-databases' && item.members.includes(`serviceAccount:${email('whatsapp-admin')}`));
      if (legacyDatabaseGrant) gcloud(['projects', 'remove-iam-policy-binding', env.projectId,
        `--member=serviceAccount:${email('whatsapp-admin')}`, '--role=roles/datastore.user',
        `--condition=title=${legacyDatabaseGrant.condition.title},expression=${legacyDatabaseGrant.condition.expression}`, '--quiet']);
      const schedulerPolicy = JSON.parse(gcloud(['iam', 'service-accounts', 'get-iam-policy', env.schedulerAccount, project, '--format=json']));
      if (schedulerPolicy.bindings?.some((item) => item.role === 'roles/iam.serviceAccountUser' && item.members.includes(`serviceAccount:${email('whatsapp-admin')}`)))
        gcloud(['iam', 'service-accounts', 'remove-iam-policy-binding', env.schedulerAccount, project,
          `--member=serviceAccount:${email('whatsapp-admin')}`, '--role=roles/iam.serviceAccountUser', '--quiet']);
      gcloud(['scheduler', 'jobs', 'resume', 'whatsapp-dispatch', project, `--location=${env.region}`, '--quiet']);
      console.log('Old clock paused and obsolete launch/Scheduler grants removed. Shared workspace dispatch enabled.');
    }
  } finally { await Promise.all([...databases.values()].map((db) => db.terminate())); }
}

if (process.argv[1]?.endsWith('/workspace-gcp.js')) {
  try { await workspaceCli(); } catch (error) { console.error(`Workspace command failed (${error.name}). ${error.name === 'TypeError' ? 'Check CLI arguments.' : 'Review prerequisites and GCP permissions; no provider error or secret is printed.'}`); process.exitCode = 1; }
}
