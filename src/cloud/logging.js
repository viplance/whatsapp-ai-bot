// libsignal prints complete session objects directly through console, bypassing
// the Baileys logger. Each Job owns its process; suppress dependency console
// output for its lifetime and write our small structured events separately.
export function silenceDependencyConsole() {
  const saved = new Map(['log', 'info', 'warn', 'error', 'debug', 'dir', 'dirxml', 'trace', 'table'].map((name) => [name, console[name]]));
  for (const name of saved.keys()) console[name] = () => {};
  return () => { for (const [name, method] of saved) console[name] = method; };
}

export function logWorkerEvent(event) {
  process.stderr.write(`${JSON.stringify(event)}\n`);
}
