import { GoogleAuth } from 'google-auth-library';

export function createRegistryClient({ env, auth = new GoogleAuth() }) {
  if (!env.registryServiceUrl) throw new Error('REGISTRY_SERVICE_URL is required');
  const url = new URL(env.registryServiceUrl);
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('Invalid registry service URL');
  let client;
  async function request(path, data) {
    client ||= await auth.getIdTokenClient(url.origin);
    await client.request({ url: `${url.origin}/${path}`, method: 'POST', data, timeout: 30000, retry: false });
  }
  return { sync: () => request('sync', {}),
    verifyAccount: (deviceId, operationId, accountId, pairing) => request(pairing ? 'claim' : 'verify', { deviceId, operationId, accountId }) };
}
