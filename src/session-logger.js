import pino from 'pino';

const events = new Map([
  ['failed to decrypt message', 'whatsapp_decryption_failed'],
  ['error in handling message', 'whatsapp_message_failed'],
  ['got history notification', 'whatsapp_history_notification'],
  ['failed to sync state from version', 'whatsapp_app_state_sync_failed'],
  ['failed to sync state from version, removing and trying from scratch', 'whatsapp_app_state_sync_failed'],
  ['Timeout in AwaitingInitialSync, forcing state to Online and flushing buffer', 'whatsapp_sync_timeout'],
]);

// Intercept log calls before Pino serializes arguments. Provider objects and free-form
// strings are discarded, including when a child logger is used.
export function createSessionLogger(onDiagnostic) {
  return pino({ level: 'info', hooks: { logMethod(args) {
    const event = events.get(args.at(-1));
    if (event) onDiagnostic({ event });
  } } });
}
