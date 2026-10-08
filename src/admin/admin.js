const $ = (id) => document.getElementById(id);
let identity, current, formVersion, loading = false;
const when = (date) => date ? new Date(date).toLocaleString() : '—';
const active = (record) => ['queued', 'running', 'cancelling'].includes(record?.status);
function notice(message, error = false) { $('notice').textContent = message; $('notice').className = error ? 'error' : ''; $('notice').hidden = false; }
async function api(path, method = 'GET', body) {
  const response = await fetch(`/api/${path}`, { method, credentials: 'same-origin', cache: 'no-store',
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': identity.csrf },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const value = await response.json();
  if (!response.ok) {
    if (response.status === 403) identity = await fetch('/api/session', { cache: 'no-store' }).then((r) => r.json());
    throw new Error(value.error || 'Request failed.');
  }
  return value;
}
function route() {
  if (location.hash === '#whatsapp') history.replaceState(null, '', '#device-connection');
  const id = ['overview', 'settings', 'device-connection'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
  document.querySelectorAll('.view').forEach((el) => { el.hidden = el.id !== id; });
  document.querySelectorAll('nav a').forEach((el) => el.classList.toggle('active', el.hash === `#${id}`));
  refresh().catch((e) => notice(e.message, true));
}
function fillForm() {
  if (!current) return;
  const form = $('settings-form');
  formVersion = current.activeVersion;
  form.elements.enabled.checked = current.enabled;
  form.elements.timezone.value = current.timezone;
  for (const [key, value] of Object.entries(current.settings)) {
    const field = form.elements[key];
    if (field) field.value = Array.isArray(value) ? value.join('\n') : value;
  }
}
function renderSchedule() {
  if (!current) return;
  let label, detail;
  if (current.scheduleStatus === 'error') {
    label = 'Update failed';
    detail = 'Schedule update failed. Retry schedule update to apply your saved changes.';
  } else if (current.scheduleStatus !== 'applied' || current.appliedScheduleRevision !== current.scheduleRevision) {
    label = 'Update pending';
    detail = 'Schedule update pending. Your saved changes are not confirmed yet.';
  } else if (current.maintenance) {
    label = 'Paused for linking';
    detail = 'Scheduled runs are paused while you link a device.';
  } else if (!current.enabled) {
    label = 'Paused';
    detail = 'Scheduled runs are paused. No automatic runs.';
  } else {
    const period = { '30min': '30 minutes', '1h': 'hour', '4h': '4 hours' }[current.settings.period] || current.settings.period;
    label = `Every ${period}`;
    detail = `Scheduled runs are enabled: every ${period} (${current.timezone}).`;
  }
  const enabled = $('settings-form').elements.enabled.checked;
  if (enabled !== current.enabled) detail += ` Save settings to ${enabled ? 'enable' : 'pause'} scheduled runs.`;
  $('schedule').textContent = label;
  $('schedule-detail').textContent = detail;
}
async function refresh() {
  if (loading || document.hidden) return;
  loading = true;
  try {
    const value = await api('overview');
    current = value.config;
    const busy = value.operations.some(active);
    $('auth').textContent = current.authStatus === 'linked' ? 'Linked' : 'Needs pairing';
    $('verified').textContent = `Last verified: ${when(current.lastVerifiedAt)}`;
    $('next').textContent = `Next run: ${when(value.nextRunAt)}`;
    $('queue').textContent = current.queueCount ?? '—';
    $('oldest').textContent = current.queueOldestAt ? `Oldest message: ${when(current.queueOldestAt)}` : 'Updated after successful runs.';
    $('run').disabled = busy || !current.enabled || current.maintenance || current.authStatus !== 'linked' || current.scheduleStatus !== 'applied';
    $('pair').disabled = busy;
    $('pair').textContent = current.authStatus === 'linked' ? 'Re-link device' : 'Link device';
    $('runs').replaceChildren();
    for (const row of value.operations) {
      const tr = document.createElement('tr');
      for (const text of [when(row.createdAt), row.mode === 'pair' ? 'Pairing' : 'Summary', row.status, row.error || row.launchError || '']) {
        const td = document.createElement('td'); td.textContent = text; tr.append(td);
      }
      $('runs').append(tr);
    }
    if (!formVersion) fillForm();
    renderSchedule();
    if (location.hash === '#device-connection' || current.maintenance) {
      const pair = await api('pairing');
      $('pair-status').textContent = pair ? ({ succeeded: 'Device linked', failed: 'Pairing failed', cancelled: 'Pairing cancelled', queued: 'Starting pairing…', running: 'Scan the QR code', cancelling: 'Cancelling…' }[pair.status] || pair.status) : 'Ready to link';
      $('pair-detail').textContent = pair?.error || pair?.launchError || (active(pair) ? 'The QR updates automatically. Pairing expires after five minutes.' : '');
      $('cancel').disabled = !active(pair) || pair.owner !== identity.email;
      $('qr').hidden = !pair?.qrDataUrl;
      if (pair?.qrDataUrl) $('qr').src = pair.qrDataUrl;
      else $('qr').removeAttribute('src');
    }
  } finally { loading = false; }
}
async function action(button, work) {
  button.disabled = true;
  try { await work(); }
  catch (error) { notice(error.message, true); }
  finally { button.disabled = false; await refresh().catch((e) => notice(e.message, true)); }
}
$('run').onclick = () => action($('run'), async () => { await api('run', 'POST', { idempotencyKey: crypto.randomUUID() }); notice('Run requested. Track its result below.'); });
$('pair').onclick = () => action($('pair'), async () => {
  if (current.authStatus === 'linked' && !confirm('Re-link this device? Scheduled runs will remain paused until you enable them again. Pending messages are preserved.')) return;
  await api('pairing', 'POST', { idempotencyKey: crypto.randomUUID() }); notice('Pairing requested. Waiting for the QR code.');
});
$('cancel').onclick = () => action($('cancel'), async () => { await api('pairing/cancel', 'POST', {}); notice('Pairing cancelled. Scheduled runs remain paused.'); });
$('reconcile').onclick = () => action($('reconcile'), async () => { await api('reconcile', 'POST', {}); notice('Schedule updated.'); });
$('reload').onclick = () => action($('reload'), async () => { await refresh(); fillForm(); renderSchedule(); notice('Settings reloaded.'); });
$('settings-form').elements.enabled.addEventListener('change', renderSchedule);
$('settings-form').onsubmit = (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  action(form.querySelector('button[type=submit]'), async () => {
    const settings = { ...current.settings };
    for (const name of ['period', 'waitForNoActivity', 'model', 'systemInstruction']) settings[name] = form.elements[name].value;
    for (const name of ['filters', 'phones']) settings[name] = form.elements[name].value.split('\n').map((v) => v.trim()).filter(Boolean);
    for (const name of ['summaryConcurrency', 'defaultLookbackHours']) settings[name] = Number(form.elements[name].value);
    await api('settings', 'PUT', { baseVersion: formVersion, enabled: form.elements.enabled.checked, timezone: form.elements.timezone.value, settings });
    formVersion = null; notice('Settings saved.');
  });
};
window.addEventListener('hashchange', route);
document.addEventListener('visibilitychange', () => { if (document.hidden) { $('qr').hidden = true; $('qr').removeAttribute('src'); } else refresh().catch((e) => notice(e.message, true)); });
async function initialize() {
  identity = await api('session'); $('account').textContent = identity.email;
  route();
  setInterval(() => refresh().catch((e) => notice(e.message, true)), 4000);
}
initialize().catch((e) => notice(e.message, true));
