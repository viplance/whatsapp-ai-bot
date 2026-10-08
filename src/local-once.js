import { useMultiFileAuthState } from 'baileys';
import qrcode from 'qrcode-terminal';
import { config, AUTH_FOLDER } from './config.js';
import { store, scanner } from './runtime.js';
import { connectSession } from './once.js';

export async function runLocalOnce() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Worker deadline exceeded')), 570000);
  const stop = () => controller.abort(new Error('Shutdown requested'));
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const onQr = async (qr) => qrcode.generate(qr, { small: true });
  onQr.allowLocal = true;
  let session;
  try {
    const auth = await useMultiFileAuthState(AUTH_FOLDER);
    session = connectSession({ auth, config, store, signal: controller.signal, onQr });
    const socket = await session.ready();
    await session.collect();
    const result = await scanner.runScan(socket, { signal: session.signal });
    if (result.failed || result.pendingReports) throw new Error('Some work failed; it remains queued');
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    await session?.stop();
  }
}
