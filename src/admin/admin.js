const $ = (id) => document.getElementById(id);
let identity, current, configurations = [], operations = [], loading = false;
const editors = new Map();
const when = (date) => date ? new Date(date).toLocaleString() : '—';
const active = (record) => ['queued', 'running', 'cancelling'].includes(record?.status);
const periodLabel = (period) => ({ '30min': '30 minutes', '1h': '1 hour', '4h': '4 hours' }[period] || period);
const scheduleApplied = () => current?.scheduleStatus === 'applied' && current.appliedScheduleRevision === current.scheduleRevision;
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
  const aliases = { '#whatsapp': '#device-connection', '#settings': '#configurations' };
  if (aliases[location.hash]) history.replaceState(null, '', aliases[location.hash]);
  const page = location.hash.slice(1).split('/')[0];
  const id = ['overview', 'configurations', 'device-connection'].includes(page) ? page : 'overview';
  document.querySelectorAll('.view').forEach((el) => { el.hidden = el.id !== id; });
  document.querySelectorAll('nav a').forEach((el) => el.classList.toggle('active', el.hash === `#${id}`));
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
  for (const [key, value] of Object.entries(profile.settings)) {
    if (fields[key]) fields[key].value = Array.isArray(value) ? value.join('\n') : value;
  }
}
function scheduleState(profile) {
  if (current.maintenance) return ['Paused for linking', 'Scheduled runs are paused while you link a device.'];
  if (current.scheduleStatus === 'error') return ['Update failed', 'Schedule update failed. Retry schedule update to apply your saved changes.'];
  if (current.scheduleStatus !== 'applied' || current.appliedScheduleRevision !== current.scheduleRevision) return ['Update pending', 'Saved schedule changes are not confirmed yet.'];
  if (!profile.enabled) return ['Paused', 'Scheduled runs are paused. Run now is still available.'];
  if (current.authStatus !== 'linked') return ['Needs pairing', 'Link your device before enabling scheduled runs.'];
  return [`Every ${periodLabel(profile.settings.period)}`, `Scheduled runs are enabled (${profile.timezone}). Next run: ${when(profile.nextRunAt)}.`];
}
function renderEditor(editor, profile) {
  editor.profile = profile;
  const draft = editor.id === 'draft';
  const [label, savedDetail] = draft ? ['Not saved', 'Save this configuration before running it.'] : scheduleState(profile);
  editor.article.querySelector('.configuration-name').textContent = profile.name;
  editor.article.querySelector('.configuration-summary').textContent = `${profile.settings.filters.length ? profile.settings.filters.join(', ') : 'All chats'} · ${periodLabel(profile.settings.period)} · ${profile.timezone}`;
  editor.article.querySelector('.configuration-badge').textContent = label;
  let detail = savedDetail;
  if (!draft && editor.version !== profile.version) detail += ' This configuration changed elsewhere. Reload before saving.';
  if (editor.form.elements.enabled.checked !== profile.enabled) detail += ` Save configuration to ${editor.form.elements.enabled.checked ? 'enable' : 'pause'} scheduled runs.`;
  editor.article.querySelector('.configuration-schedule').textContent = detail;
  const busy = operations.some(active) || current.maintenance;
  editor.article.querySelector('.run-configuration').disabled = draft || busy || current.authStatus !== 'linked' || !scheduleApplied();
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
    try { localStorage.setItem('expanded-configurations', JSON.stringify([...expanded].filter((item) => item !== 'draft'))); } catch { /* Optional preference. */ }
    if (!editor.details.open && location.hash === `#configurations/${id}`) history.replaceState(null, '', '#configurations');
  });
  fillForm(editor, profile);
  editor.form.elements.enabled.addEventListener('change', () => renderEditor(editor, editor.profile));
  editor.form.onsubmit = (event) => {
    event.preventDefault();
    action(editor.form.querySelector('button[type=submit]'), async () => {
      const fields = editor.form.elements, settings = { ...editor.profile.settings };
      for (const name of ['period', 'waitForNoActivity', 'model', 'systemInstruction']) settings[name] = fields[name].value;
      for (const name of ['filters', 'phones']) settings[name] = fields[name].value.split('\n').map((value) => value.trim()).filter(Boolean);
      for (const name of ['summaryConcurrency', 'defaultLookbackHours']) settings[name] = Number(fields[name].value);
      const body = { name: fields.name.value, enabled: fields.enabled.checked, timezone: fields.timezone.value, settings,
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
function applyOverview(value) {
  current = value.config;
  configurations = value.configurations;
  operations = value.operations;
  $('auth').textContent = current.authStatus === 'linked' ? 'Linked' : 'Needs pairing';
  $('verified').textContent = `Last verified: ${when(current.lastVerifiedAt)}`;
  $('next').textContent = `Next scheduled run: ${when(value.nextRunAt)}`;
  const enabled = configurations.filter((item) => item.enabled).length;
  $('schedule').textContent = current.maintenance ? 'Paused for linking' : current.scheduleStatus === 'error' ? 'Update failed'
    : !scheduleApplied() ? 'Update pending' : `${enabled} enabled · ${configurations.length} total`;
  $('queue').textContent = current.queueCount ?? '—';
  $('oldest').textContent = current.queueOldestAt ? `Oldest message: ${when(current.queueOldestAt)}` : 'Updated after runs. Each configuration keeps its own queue.';
  const busy = operations.some(active) || current.maintenance;
  $('run-all').disabled = !configurations.length || busy || current.authStatus !== 'linked' || !scheduleApplied();
  $('add-configuration').disabled = configurations.length >= 20 || editors.has('draft');
  $('pair').disabled = busy;
  $('pair').textContent = current.authStatus === 'linked' ? 'Re-link device' : 'Link device';
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
    for (const text of [when(row.createdAt), row.mode === 'pair' ? 'Pairing' : 'Summary', row.mode === 'pair' ? 'Device' : names?.join(', ') || 'Default configuration', row.status, runDetail(row)]) {
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
    applyOverview(await api('overview'));
    if (location.hash === '#device-connection' || current.maintenance) {
      const pair = await api('pairing');
      const syncing = pair?.status === 'running' && pair.stage === 'synchronize';
      $('pair-status').textContent = syncing ? 'Saving initial messages…' : pair ? ({ succeeded: 'Device linked', failed: 'Pairing failed', cancelled: 'Pairing cancelled', queued: 'Starting pairing…', running: 'Scan the QR code', cancelling: 'Cancelling…' }[pair.status] || pair.status) : 'Ready to link';
      $('pair-detail').textContent = pair?.error || pair?.launchError || (syncing ? 'The QR was scanned. Keep WhatsApp open while messages and session keys are saved.' : active(pair) ? 'The QR updates automatically. Pairing expires after five minutes.' : '');
      $('cancel').disabled = !active(pair) || pair.owner !== identity.email;
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
  const editor = createEditor({ name: 'New configuration', enabled: false,
    timezone: base?.timezone || 'Europe/Istanbul', settings: base?.settings || current.settings }, true);
  $('add-configuration').disabled = true;
  $('configurations-empty').hidden = true;
  location.hash = '#configurations';
  editor.form.elements.name.focus(); editor.form.elements.name.select();
};
$('run-all').onclick = () => action($('run-all'), async () => {
  await api('configurations/run-all', 'POST', { idempotencyKey: crypto.randomUUID() });
  notice('Run requested for all configurations. Track the results in Overview.');
});
$('pair').onclick = () => action($('pair'), async () => {
  if (current.authStatus === 'linked' && !confirm('Re-link this device? Scheduled runs will remain paused until you enable your configurations again. Pending messages are preserved.')) return;
  await api('pairing', 'POST', { idempotencyKey: crypto.randomUUID() }); notice('Pairing requested. Waiting for the QR code.');
});
$('cancel').onclick = () => action($('cancel'), async () => { await api('pairing/cancel', 'POST', {}); notice('Pairing cancelled. Scheduled runs remain paused.'); });
window.addEventListener('hashchange', route);
document.addEventListener('visibilitychange', () => { if (document.hidden) { $('qr').hidden = true; $('qr').removeAttribute('src'); } else refresh().catch((error) => notice(error.message, true)); });
async function initialize() {
  identity = await api('session'); $('account').textContent = identity.email;
  route();
  setInterval(() => refresh().catch((error) => notice(error.message, true)), 4000);
}
initialize().catch((error) => notice(error.message, true));
