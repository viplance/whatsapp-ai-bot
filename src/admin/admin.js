const $ = (id) => document.getElementById(id);
let identity, current, configurations = [], operations = [], devices = [], selectedDeviceId, loading = false;
const editors = new Map();
const when = (date) => date ? new Date(date).toLocaleString() : '—';
const active = (record) => ['queued', 'running', 'cancelling'].includes(record?.status);
const periodLabel = (period) => ({ '15min': '15 minutes', '30min': '30 minutes', '1h': '1 hour', '4h': '4 hours', '8h': '8 hours', '24h': '24 hours' }[period] || period);
const scheduleApplied = (record = current) => record?.scheduleStatus === 'applied' && record.appliedScheduleRevision === record.scheduleRevision;
const profileDevice = (profile) => identity?.devicesEnabled ? devices.find((device) => device.id === profile.deviceId) : current;
const selectedDevice = () => identity?.devicesEnabled ? devices.find((device) => device.id === selectedDeviceId) : current;
const contextKey = (value) => `${value?.userId || value?.email || ''}:${value?.workspaceId || 'legacy'}`;
const preferenceKey = () => identity?.workspaceId ? `expanded-configurations:${contextKey(identity)}` : 'expanded-configurations';
function clearPrivateData() {
  current = undefined; configurations = []; operations = []; devices = []; selectedDeviceId = undefined;
  editors.clear(); expanded.clear(); $('configuration-list').replaceChildren(); $('runs').replaceChildren();
  $('qr').hidden = true; $('qr').removeAttribute('src'); $('device-picker').replaceChildren();
  $('account').textContent = ''; $('notice').textContent = ''; $('notice').hidden = true;
  $('configurations-status').textContent = ''; $('new-device-form').reset(); deviceCreationKey = crypto.randomUUID();
  for (const id of ['auth', 'verified', 'next', 'schedule', 'queue', 'oldest', 'pair-status', 'pair-detail', 'device-state']) $(id).textContent = '';
  for (const id of ['run-all', 'pair', 'cancel', 'add-configuration', 'add-device', 'remove-device']) $(id).disabled = true;
}
function acceptIdentity(value) {
  const changed = identity && contextKey(identity) !== contextKey(value);
  if (changed) clearPrivateData();
  const initial = !identity;
  identity = value;
  $('account').textContent = value.workspaceName ? `${value.email} · ${value.workspaceName}` : value.email;
  if (initial || changed) {
    try { expanded = new Set(JSON.parse(localStorage.getItem(preferenceKey()) || '[]')); } catch { expanded = new Set(); }
  }
  return changed;
}
let expanded = new Set();
try { expanded = new Set(JSON.parse(localStorage.getItem('expanded-configurations') || '[]')); } catch { /* Defaults work without storage. */ }
function notice(message, error = false) { $('notice').textContent = message; $('notice').className = error ? 'error' : ''; $('notice').hidden = false; }
function runDetail(row) {
  if (row.error || row.launchError) return row.error || row.launchError;
  if (row.mode !== 'summary' || row.status !== 'succeeded') return '';
  const summary = row.summary;
  if (!summary) return 'Completed. Delivery details are unavailable for this older run.';
  if (row.outcome === 'sent') return `${summary.processedMessages} messages summarized; ${summary.deliveredParts} report parts sent; ${summary.pendingMessages} messages waiting.`;
  if (row.outcome === 'waiting_for_inactivity') return `No report sent. ${summary.pendingMessages} messages are waiting for the chat quiet time.`;
  const collected = row.collection;
  if (collected?.decryptionErrors || collected?.messageErrors || collected?.appStateErrors) return 'No report sent. WhatsApp receive/sync errors occurred; inspect Cloud Logging.';
  if (collected?.filtered) return `No report sent. ${collected.filtered} messages did not match chat filters.`;
  return 'No report sent. No new messages matched the filters and history window.';
}
async function api(path, method = 'GET', body) {
  if (method !== 'GET' && identity) {
    const session = await fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' });
    if (!session.ok) { clearPrivateData(); throw new Error('Sign in again before making changes.'); }
    if (acceptIdentity(await session.json())) throw new Error('Your workspace changed. Review it before making changes.');
  }
  const requestContext = contextKey(identity);
  const response = await fetch(`/api/${path}`, { method, credentials: 'same-origin', cache: 'no-store',
    headers: { ...(identity?.workspaceId && path !== 'session' ? { 'X-Workspace-Id': identity.workspaceId } : {}),
      ...(method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': identity.csrf }) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const value = await response.json();
  if (path !== 'session' && requestContext !== contextKey(identity)) throw new Error('Your workspace changed. Refresh to continue.');
  if (!response.ok) {
    if (path === 'session' || [401, 403].includes(response.status)) clearPrivateData();
    throw new Error(value.error || 'Request failed.');
  }
  return value;
}
function route() {
  const aliases = { '#whatsapp': '#device-connection', '#settings': '#configurations' };
  if (aliases[location.hash]) history.replaceState(null, '', aliases[location.hash]);
  const page = location.hash.slice(1).split('/')[0];
  const id = ['overview', 'configurations', 'device-connection'].includes(page) ? page : 'overview';
  document.querySelectorAll('.view').forEach((el) => { el.hidden = el.id !== id; });
  document.querySelectorAll('nav a').forEach((el) => el.classList.toggle('active', el.hash === `#${id}`));
  if (identity?.devicesEnabled && current) renderDevices();
  openLinkedConfiguration(true);
  refresh().catch((error) => notice(error.message, true));
}
function openLinkedConfiguration(scroll = false) {
  const match = location.hash.match(/^#configurations\/([a-z0-9-]{1,60})$/);
  const editor = match && editors.get(match[1]);
  if (editor) {
    const opening = !editor.details.open;
    editor.details.open = true;
    if (scroll || opening) editor.article.scrollIntoView({ block: 'nearest' });
  } else if (match && current) notice('Configuration not found. It may have been removed.', true);
}
function fillForm(editor, profile) {
  editor.profile = profile;
  editor.version = profile.version;
  const fields = editor.form.elements;
  fields.name.value = profile.name;
  fields.enabled.checked = profile.enabled;
  fields.timezone.value = profile.timezone;
  editor.article.querySelector('.configuration-device').hidden = !identity?.devicesEnabled;
  fields.deviceId.replaceChildren(...devices.map((device) => new Option(device.name, device.id)));
  fields.deviceId.value = profile.deviceId || '';
  fields.deviceId.disabled = editor.id !== 'draft';
  for (const [key, value] of Object.entries(profile.settings)) {
    if (fields[key]) fields[key].value = Array.isArray(value) ? value.join('\n') : value;
  }
}
function scheduleState(profile) {
  const device = profileDevice(profile);
  if (device?.maintenance) return ['Paused for linking', 'Scheduled runs are paused while you link this device.'];
  if (device?.scheduleStatus === 'error') return ['Update failed', 'Schedule update failed. Retry schedule update to apply your saved changes.'];
  if (!scheduleApplied(device)) return ['Update pending', 'Saved schedule changes are not confirmed yet.'];
  if (!profile.enabled) return ['Paused', 'Scheduled runs are paused. Run now is still available.'];
  if (device?.authStatus !== 'linked') return ['Needs pairing', 'Link this device before enabling scheduled runs.'];
  return [`Every ${periodLabel(profile.settings.period)}`, `Scheduled runs are enabled (${profile.timezone}). Next run: ${when(profile.nextRunAt)}.`];
}
function renderEditor(editor, profile) {
  editor.profile = profile;
  const draft = editor.id === 'draft';
  const [label, savedDetail] = draft ? ['Not saved', 'Save this configuration before running it.'] : scheduleState(profile);
  editor.article.querySelector('.configuration-name').textContent = profile.name;
  const device = profileDevice(profile);
  editor.article.querySelector('.configuration-summary').textContent = `${device?.name ? `${device.name} · ` : ''}${profile.settings.filters.length ? profile.settings.filters.join(', ') : 'All chats'} · ${periodLabel(profile.settings.period)} · ${profile.timezone}`;
  editor.article.querySelector('.configuration-badge').textContent = label;
  let detail = savedDetail;
  if (!draft && editor.version !== profile.version) detail += ' This configuration changed elsewhere. Reload before saving.';
  if (editor.form.elements.enabled.checked !== profile.enabled) detail += ` Save configuration to ${editor.form.elements.enabled.checked ? 'enable' : 'pause'} scheduled runs.`;
  editor.article.querySelector('.configuration-schedule').textContent = detail;
  const busy = operations.some((row) => active(row) && (!identity?.devicesEnabled || row.deviceId === profile.deviceId)) || device?.maintenance;
  editor.article.querySelector('.run-configuration').disabled = draft || busy || device?.authStatus !== 'linked' || !scheduleApplied(device);
  editor.article.querySelector('.remove-configuration').disabled = !draft && busy;
  editor.article.querySelector('.reconcile-configuration').hidden = draft;
  editor.article.querySelector('.reload-configuration').hidden = draft;
  const row = operations.find((item) => item.mode === 'summary' && (item.configurationIds?.includes(editor.id) || (!item.configurationIds && editor.id === 'default')));
  const result = row?.configurationResults?.find((item) => item.configurationId === editor.id);
  editor.article.querySelector('.configuration-result').textContent = draft ? 'New configuration' : row
    ? `Last run: ${when(row.createdAt)} · ${result?.status || row.status}. ${result ? runDetail({ ...result, mode: 'summary' }) : runDetail(row)}`
    : `${profile.queueCount || 0} messages waiting. No runs yet.`;
}
function createEditor(profile, draft = false) {
  const id = draft ? 'draft' : profile.id;
  const article = $('configuration-template').content.firstElementChild.cloneNode(true);
  article.dataset.configurationId = id;
  const editor = { id, article, form: article.querySelector('form'), details: article.querySelector('details'), idempotencyKey: crypto.randomUUID() };
  editors.set(id, editor);
  editor.details.open = draft || expanded.has(id);
  const link = article.querySelector('.configuration-link');
  link.hidden = draft;
  link.href = `#configurations/${id}`;
  editor.details.addEventListener('toggle', () => {
    if (editor.details.open) expanded.add(id); else expanded.delete(id);
    try { localStorage.setItem(preferenceKey(), JSON.stringify([...expanded].filter((item) => item !== 'draft'))); } catch { /* Optional preference. */ }
    if (!editor.details.open && location.hash === `#configurations/${id}`) history.replaceState(null, '', '#configurations');
  });
  fillForm(editor, profile);
  editor.form.elements.deviceId.addEventListener('change', () => {
    if (draft) { editor.profile = { ...editor.profile, deviceId: editor.form.elements.deviceId.value }; renderEditor(editor, editor.profile); }
  });
  editor.form.elements.enabled.addEventListener('change', () => renderEditor(editor, editor.profile));
  editor.form.onsubmit = (event) => {
    event.preventDefault();
    action(editor.form.querySelector('button[type=submit]'), async () => {
      const fields = editor.form.elements, settings = { ...editor.profile.settings };
      for (const name of ['period', 'waitForNoActivity', 'model', 'systemInstruction']) settings[name] = fields[name].value;
      for (const name of ['filters', 'phones']) settings[name] = fields[name].value.split('\n').map((value) => value.trim()).filter(Boolean);
      for (const name of ['summaryConcurrency', 'defaultLookbackHours']) settings[name] = Number(fields[name].value);
      const body = { name: fields.name.value, enabled: fields.enabled.checked, timezone: fields.timezone.value, settings,
        ...(identity.devicesEnabled ? { deviceId: fields.deviceId.value } : {}),
        ...(!draft ? { baseVersion: editor.version } : { idempotencyKey: editor.idempotencyKey }) };
      const value = await api(draft ? 'configurations' : `configurations/${id}`, draft ? 'POST' : 'PUT', body);
      if (draft) { editor.article.remove(); editors.delete('draft'); }
      else editor.version = null;
      expanded.add(value.id);
      applyOverview(value);
      location.hash = `#configurations/${value.id}`;
      notice('Configuration saved.');
    });
  };
  article.querySelector('.reload-configuration').onclick = () => action(article.querySelector('.reload-configuration'), async () => {
    const value = await api('overview'); applyOverview(value);
    const latest = configurations.find((item) => item.id === id);
    if (latest) { fillForm(editor, latest); renderEditor(editor, latest); }
    notice('Configuration reloaded.');
  });
  article.querySelector('.reconcile-configuration').onclick = () => action(article.querySelector('.reconcile-configuration'), async () => { await api('reconcile', 'POST', {}); notice('Schedules updated.'); });
  article.querySelector('.run-configuration').onclick = () => action(article.querySelector('.run-configuration'), async () => {
    await api(`configurations/${id}/run`, 'POST', { idempotencyKey: crypto.randomUUID() });
    notice(`Run requested for ${editor.profile.name}. Track the result in Overview.`);
  });
  article.querySelector('.remove-configuration').textContent = draft ? 'Discard' : 'Remove';
  article.querySelector('.remove-configuration').onclick = () => action(article.querySelector('.remove-configuration'), async () => {
    if (draft) { article.remove(); editors.delete(id); $('configurations-empty').hidden = configurations.length > 0; return; }
    if (!confirm(`Remove “${editor.profile.name}”?`)) return;
    const value = await api(`configurations/${id}`, 'DELETE', { baseVersion: editor.version });
    applyOverview(value); expanded.delete(id);
    if (location.hash === `#configurations/${id}`) location.hash = '#configurations';
    notice('Configuration removed.');
  });
  $('configuration-list').append(article);
  renderEditor(editor, profile);
  return editor;
}
function renderDevices() {
  $('workspace-devices').hidden = false;
  const previous = selectedDeviceId;
  const link = location.hash.match(/^#device-connection\/([a-z0-9-]{1,60})$/);
  selectedDeviceId = link ? devices.find((device) => device.id === link[1])?.id
    : devices.some((device) => device.id === selectedDeviceId) ? selectedDeviceId : devices[0]?.id;
  if (previous !== selectedDeviceId || !selectedDeviceId) {
    $('qr').hidden = true; $('qr').removeAttribute('src'); $('pair-detail').textContent = '';
    $('pair-status').textContent = selectedDeviceId ? 'Ready to link' : 'Add or select a device';
    $('cancel').disabled = true;
  }
  if (link && !selectedDeviceId) notice('Device not found. Select one of your devices.', true);
  $('device-picker').replaceChildren(...devices.map((device) => new Option(device.name, device.id)));
  $('device-picker').value = selectedDeviceId || '';
  const device = selectedDevice();
  $('device-state').textContent = device ? `${device.authStatus === 'linked' ? 'Linked' : 'Needs pairing'} · Last verified: ${when(device.lastVerifiedAt)}` : 'Add your first device, then configure and link it.';
  $('add-device').disabled = devices.length >= 5;
  $('remove-device').disabled = !device?.removable;
}
function applyOverview(value) {
  current = value.config;
  configurations = value.configurations;
  operations = value.operations;
  devices = value.devices || [];
  if (identity?.devicesEnabled) renderDevices();
  $('auth').textContent = identity?.devicesEnabled ? `${devices.filter((device) => device.authStatus === 'linked').length}/${devices.length} devices linked` : current.authStatus === 'linked' ? 'Linked' : 'Needs pairing';
  $('verified').textContent = `Last verified: ${when(current.lastVerifiedAt)}`;
  $('next').textContent = `Next scheduled run: ${when(value.nextRunAt)}`;
  const enabled = configurations.filter((item) => item.enabled).length;
  $('schedule').textContent = current.maintenance ? 'Paused for linking' : current.scheduleStatus === 'error' ? 'Update failed'
    : !scheduleApplied() ? 'Update pending' : `${enabled} enabled · ${configurations.length} total`;
  $('queue').textContent = current.queueCount ?? '—';
  $('oldest').textContent = current.queueOldestAt ? `Oldest message: ${when(current.queueOldestAt)}` : 'Updated after runs. Each configuration keeps its own queue.';
  const device = selectedDevice();
  const busy = operations.some((row) => active(row) && (!identity?.devicesEnabled || row.deviceId === selectedDeviceId)) || device?.maintenance;
  $('run-all').disabled = !configurations.length || (!identity?.devicesEnabled && (busy || current.authStatus !== 'linked' || !scheduleApplied()));
  $('add-configuration').disabled = editors.has('draft') || (identity?.devicesEnabled ? !devices.some((item) => configurations.filter((profile) => profile.deviceId === item.id).length < 20) : configurations.length >= 20);
  $('pair').disabled = !device || busy;
  $('pair').textContent = device?.authStatus === 'linked' ? 'Re-link device' : 'Link device';
  $('configurations-status').textContent = 'Run all runs every saved configuration, including paused schedules. Unsaved edits are not used.';
  for (const [id, editor] of editors) if (id !== 'draft' && !configurations.some((item) => item.id === id)) { editor.article.remove(); editors.delete(id); }
  for (const profile of configurations) {
    const editor = editors.get(profile.id) || createEditor(profile);
    if (!editor.version) fillForm(editor, profile);
    renderEditor(editor, profile);
  }
  $('configurations-empty').hidden = configurations.length > 0 || editors.has('draft');
  $('runs').replaceChildren();
  for (const row of operations) {
    const names = row.configurationIds?.map((id) => row.configurationResults?.find((item) => item.configurationId === id)?.name || configurations.find((item) => item.id === id)?.name || 'Removed configuration');
    const tr = document.createElement('tr');
    const label = row.mode === 'pair' ? row.deviceName || 'Device' : `${row.deviceName ? `${row.deviceName} · ` : ''}${names?.join(', ') || 'Default configuration'}`;
    for (const text of [when(row.createdAt), row.mode === 'pair' ? 'Pairing' : 'Summary', label, row.status, runDetail(row)]) {
      const td = document.createElement('td'); td.textContent = text; tr.append(td);
    }
    $('runs').append(tr);
  }
  openLinkedConfiguration();
}
async function refresh() {
  if (loading || document.hidden) return;
  loading = true;
  try {
    acceptIdentity(await api('session'));
    applyOverview(await api('overview'));
    if ((location.hash.startsWith('#device-connection') || current.maintenance) && selectedDevice()) {
      const requestedDevice = selectedDeviceId;
      const pair = await api(identity.devicesEnabled ? `pairing?deviceId=${encodeURIComponent(selectedDeviceId)}` : 'pairing');
      if (requestedDevice !== selectedDeviceId || document.hidden) return;
      const syncing = pair?.status === 'running' && pair.stage === 'synchronize';
      $('pair-status').textContent = syncing ? 'Saving initial messages…' : pair ? ({ succeeded: 'Device linked', failed: 'Pairing failed', cancelled: 'Pairing cancelled', queued: 'Starting pairing…', running: 'Scan the QR code', cancelling: 'Cancelling…' }[pair.status] || pair.status) : 'Ready to link';
      $('pair-detail').textContent = pair?.error || pair?.launchError || (syncing ? 'The QR was scanned. Keep WhatsApp open while messages and session keys are saved.' : active(pair) ? 'The QR updates automatically. Pairing expires after five minutes.' : '');
      $('cancel').disabled = !active(pair) || pair.owner !== (identity.devicesEnabled ? identity.userId : identity.email);
      $('qr').hidden = !pair?.qrDataUrl;
      if (pair?.qrDataUrl) $('qr').src = pair.qrDataUrl; else $('qr').removeAttribute('src');
    }
  } finally { loading = false; }
}
async function action(button, work) {
  button.disabled = true;
  try { await work(); } catch (error) { notice(error.message, true); }
  finally { button.disabled = false; await refresh().catch((error) => notice(error.message, true)); }
}
$('add-configuration').onclick = () => {
  if (editors.has('draft') || !current) return;
  const base = configurations[0];
  const deviceId = identity.devicesEnabled ? devices.find((device) => configurations.filter((item) => item.deviceId === device.id).length < 20)?.id : undefined;
  if (identity.devicesEnabled && !deviceId) return;
  const editor = createEditor({ name: 'New configuration', enabled: false,
    ...(deviceId ? { deviceId } : {}),
    timezone: base?.timezone || 'Europe/Istanbul', settings: { ...(base?.settings || current.settings), systemInstruction: '' } }, true);
  $('add-configuration').disabled = true;
  $('configurations-empty').hidden = true;
  location.hash = '#configurations';
  editor.form.elements.name.focus(); editor.form.elements.name.select();
};
$('run-all').onclick = () => action($('run-all'), async () => {
  const result = await api('configurations/run-all', 'POST', { idempotencyKey: crypto.randomUUID() });
  const rejected = result.devices?.filter((device) => device.status === 'rejected') || [];
  notice(rejected.length ? `${result.devices.length - rejected.length} devices queued. ${rejected.length} could not start: ${rejected.map((item) => item.error).join(' ')}` : 'Run requested for all configurations. Track the results in Overview.', rejected.length > 0);
});
$('pair').onclick = () => action($('pair'), async () => {
  if (selectedDevice()?.authStatus === 'linked' && !confirm('Re-link this device? Scheduled runs will remain paused until you enable its configurations again. Pending messages are preserved.')) return;
  await api('pairing', 'POST', { idempotencyKey: crypto.randomUUID(), ...(identity.devicesEnabled ? { deviceId: selectedDeviceId } : {}) }); notice('Pairing requested. Waiting for the QR code.');
});
$('cancel').onclick = () => action($('cancel'), async () => { await api('pairing/cancel', 'POST', identity.devicesEnabled ? { deviceId: selectedDeviceId } : {}); notice('Pairing cancelled. Scheduled runs remain paused.'); });
$('device-picker').onchange = () => { location.hash = `#device-connection/${$('device-picker').value}`; };
let deviceCreationKey = crypto.randomUUID();
$('new-device-form').onsubmit = (event) => {
  event.preventDefault();
  action($('add-device'), async () => {
    const result = await api('devices', 'POST', { name: $('new-device-name').value, idempotencyKey: deviceCreationKey });
    deviceCreationKey = crypto.randomUUID(); $('new-device-form').reset();
    selectedDeviceId = result.id; applyOverview(result); location.hash = `#device-connection/${result.id}`;
    notice('Device added. Add a configuration and link this device.');
  });
};
$('remove-device').onclick = () => action($('remove-device'), async () => {
  const device = selectedDevice();
  if (!device || !confirm(`Remove unused device “${device.name}”?`)) return;
  const result = await api(`devices/${device.id}`, 'DELETE', { baseVersion: device.version });
  selectedDeviceId = undefined; location.hash = '#device-connection'; applyOverview(result); notice('Device removed.');
});
window.addEventListener('hashchange', route);
document.addEventListener('visibilitychange', () => { if (document.hidden) { $('qr').hidden = true; $('qr').removeAttribute('src'); } else refresh().catch((error) => notice(error.message, true)); });
async function initialize() {
  acceptIdentity(await api('session'));
  route();
  setInterval(() => refresh().catch((error) => notice(error.message, true)), 4000);
}
initialize().catch((error) => notice(error.message, true));
