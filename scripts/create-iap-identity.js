import { cliAuth } from './cloud-client.js';
const client = await cliAuth().getClient();
await client.request({
  url: `https://serviceusage.googleapis.com/v1beta1/projects/${process.env.GOOGLE_CLOUD_PROJECT}/services/iap.googleapis.com:generateServiceIdentity`,
  method: 'POST', data: {},
});
console.log('IAP service identity ready.');
