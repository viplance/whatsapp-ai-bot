import { execFileSync } from 'node:child_process';
import dotenv from 'dotenv';
dotenv.config({ quiet: true });
const project = process.env.GOOGLE_CLOUD_PROJECT;
const secret = process.env.GEMINI_SECRET || 'whatsapp-gemini-api-key';
if (!project || !process.env.GEMINI_API_KEY) throw new Error('Project and local GEMINI_API_KEY are required');
const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
  headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY }, signal: AbortSignal.timeout(30000),
});
if (!response.ok) throw new Error(`Gemini rejected the key (HTTP ${response.status}); replace GEMINI_API_KEY locally before uploading.`);
execFileSync('gcloud', ['secrets', 'versions', 'add', secret, `--project=${project}`, '--data-file=-'], {
  input: process.env.GEMINI_API_KEY, stdio: ['pipe', 'pipe', 'pipe'],
});
console.log('Gemini key stored in Secret Manager; its value was not printed.');
