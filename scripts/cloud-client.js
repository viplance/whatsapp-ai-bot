import { execFileSync } from 'node:child_process';
import { Firestore } from '@google-cloud/firestore';
import { GoogleAuth, OAuth2Client } from 'google-auth-library';

// Deployment helpers use the existing gcloud login; no persistent ADC file or
// exported service-account key is needed. Never print the access token.
export function cliAuth(impersonate) {
  const token = execFileSync('gcloud', ['auth', 'print-access-token', ...(impersonate ? [`--impersonate-service-account=${impersonate}`] : [])], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const client = new OAuth2Client();
  client.setCredentials({ access_token: token, expiry_date: Date.now() + 50 * 60000 });
  return new GoogleAuth({ authClient: client });
}

export function cliDatabase(projectId, databaseId, auth = cliAuth()) {
  return new Firestore({ projectId, databaseId, auth, preferRest: true });
}
