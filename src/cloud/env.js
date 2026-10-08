export function cloudEnvironment(env = process.env) {
  const required = (name) => {
    if (!env[name]) throw new Error(`Missing ${name}`);
    return env[name];
  };
  const projectId = required('GOOGLE_CLOUD_PROJECT');
  const region = required('GCP_REGION');
  const configId = env.CONFIG_ID || 'whatsapp-main';
  if (!/^[a-z0-9-]{1,60}$/.test(configId)) throw new Error('Invalid CONFIG_ID');
  return { projectId, region, configId,
    controlDatabase: env.CONTROL_DATABASE || 'whatsapp-control',
    runtimeDatabase: env.RUNTIME_DATABASE || 'whatsapp-runtime',
    summaryJob: env.SUMMARY_JOB || 'whatsapp-summary', pairingJob: env.PAIRING_JOB || 'whatsapp-pairing',
    schedulerJob: env.SCHEDULER_JOB || 'whatsapp-summary',
    schedulerAccount: env.SCHEDULER_ACCOUNT || `whatsapp-scheduler@${projectId}.iam.gserviceaccount.com`,
    adminEmails: (env.ADMIN_EMAILS || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean),
    iapAudience: env.IAP_AUDIENCE, port: Number(env.PORT || 8080) };
}
