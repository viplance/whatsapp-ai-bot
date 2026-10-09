import { GoogleAuth } from 'google-auth-library';
import { scheduleFor } from './settings.js';

export function createGoogleApi({ env, auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] }) }) {
  const jobPath = (mode) => `projects/${env.projectId}/locations/${env.region}/jobs/${mode === 'pair' ? env.pairingJob : env.summaryJob}`;
  const schedulerPath = `projects/${env.projectId}/locations/${env.region}/jobs/${env.schedulerJob}`;
  async function request(url, method = 'GET', data) {
    const client = await auth.getClient();
    return (await client.request({ url, method, data, timeout: 30000, retry: false })).data;
  }
  return {
    async start(mode, values) {
      const data = { overrides: { containerOverrides: [{ env: Object.entries(values).map(([name, value]) => ({ name, value: String(value) })) }] } };
      const operation = await request(`https://run.googleapis.com/v2/${jobPath(mode)}:run`, 'POST', data);
      return { operation: operation.name, execution: operation.metadata?.name || operation.response?.name || null };
    },
    async execution(record) {
      let name = record.execution;
      if (!name && record.operation) {
        const op = await request(`https://run.googleapis.com/v2/${record.operation}`);
        name = op.metadata?.name || op.response?.name;
      }
      if (!name) return null;
      return request(`https://run.googleapis.com/v2/${name}`);
    },
    async cancel(record) {
      const execution = await this.execution(record);
      if (execution?.name) await request(`https://run.googleapis.com/v2/${execution.name}:cancel`, 'POST', {});
      return Boolean(execution?.name);
    },
    async reconcile(config) {
      const body = { name: schedulerPath, schedule: scheduleFor(config.settings.period), timeZone: config.timezone,
        attemptDeadline: '30s', retryConfig: { retryCount: 1, minBackoffDuration: '10s', maxBackoffDuration: '60s' },
        httpTarget: { uri: `https://run.googleapis.com/v2/${jobPath('summary')}:run`, httpMethod: 'POST',
          headers: { 'Content-Type': 'application/json' }, oauthToken: { serviceAccountEmail: env.schedulerAccount },
          body: Buffer.from(JSON.stringify({ overrides: { containerOverrides: [{ env: [
            { name: 'CONFIG_ID', value: env.configId }, { name: 'SCHEDULE_REVISION', value: String(config.scheduleRevision) },
            { name: 'REQUEST_ID', value: '' },
            { name: 'CONFIGURATION_IDS', value: '' },
          ] }] } })).toString('base64') } };
      const base = 'https://cloudscheduler.googleapis.com/v1/';
      try {
        await request(`${base}${schedulerPath}?updateMask=schedule,timeZone,httpTarget,attemptDeadline,retryConfig`, 'PATCH', body);
      } catch (error) {
        if (Number(error.response?.status || error.code) !== 404) throw error;
        await request(`${base}projects/${env.projectId}/locations/${env.region}/jobs`, 'POST', body);
      }
      await request(`${base}${schedulerPath}:${config.enabled && !config.maintenance ? 'resume' : 'pause'}`, 'POST', {});
    },
  };
}
