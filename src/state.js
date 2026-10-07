import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const RETENTION_MS = 30 * 24 * 3_600_000;
const validDate = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const nonemptyString = (value) => typeof value === 'string' && value.length > 0;
const validMessage = (m) => m && nonemptyString(m.id) && nonemptyString(m.jid)
  && typeof m.sender === 'string' && nonemptyString(m.text) && validDate(m.time);
const validReport = (r) => r && nonemptyString(r.id)
  && Array.isArray(r.messageIds) && r.messageIds.length > 0 && r.messageIds.every(nonemptyString)
  && Array.isArray(r.parts) && r.parts.length > 0 && r.parts.every(nonemptyString)
  && Array.isArray(r.recipients) && r.recipients.length > 0
  && r.recipients.every((p) => p && nonemptyString(p.jid) && Number.isInteger(p.nextPart)
    && p.nextPart >= 0 && p.nextPart <= r.parts.length)
  && new Set(r.recipients.map((p) => p.jid)).size === r.recipients.length;

// One atomic checkpoint covers the queue, reports, delivery progress and cursor.
// Legacy { lastScanTime } checkpoints are upgraded on the first write.
export function createStateStore({ file, defaultLookbackMs, now = Date.now }) {
  let loaded = {};
  try {
    loaded = JSON.parse(readFileSync(file, 'utf8'));
    if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) throw new Error('Expected an object');
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`Cannot read state file ${file}; preserve it and repair it before restarting.`, { cause: err });
  }
  const fallback = new Date(now() - defaultLookbackMs).toISOString();
  let state = {
    version: 1,
    lastScanTime: validDate(loaded.lastScanTime) ? loaded.lastScanTime : fallback,
    historySince: validDate(loaded.historySince) ? loaded.historySince : (validDate(loaded.lastScanTime) ? loaded.lastScanTime : fallback),
    messages: loaded.messages === undefined ? [] : loaded.messages,
    seen: loaded.seen === undefined ? {} : loaded.seen,
    reports: loaded.reports === undefined ? [] : loaded.reports,
  };
  if ((loaded.version !== undefined && loaded.version !== 1)
    || !Array.isArray(state.messages) || !Array.isArray(state.reports)
    || !state.seen || typeof state.seen !== 'object' || Array.isArray(state.seen)
    || !Object.values(state.seen).every(validDate)
    || !state.messages.every(validMessage) || !state.reports.every(validReport)
    || (loaded.version === 1 && ['messages', 'seen', 'reports'].some((key) => loaded[key] === undefined))) {
    throw new Error(`Invalid queue or report data in ${file}; refusing to discard pending work.`);
  }
  const queuedIds = new Set(state.messages.map((m) => m.id));
  const reportedIds = state.reports.flatMap((r) => r.messageIds);
  if (queuedIds.size !== state.messages.length
    || new Set(state.reports.map((r) => r.id)).size !== state.reports.length
    || new Set(reportedIds).size !== reportedIds.length
    || reportedIds.some((id) => !queuedIds.has(id))
    || (loaded.version === 1 && state.messages.some((m) => !Object.hasOwn(state.seen, m.id)))) {
    throw new Error(`Inconsistent queue or report IDs in ${file}; refusing to discard pending work.`);
  }
  // Reconnects in this process can still replay from the initial history floor.
  let replayFloor = Date.parse(state.historySince);

  function update(change) {
    const next = structuredClone(state);
    change(next);
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(next), { encoding: 'utf8', mode: 0o600, flush: true });
      renameSync(temp, file);
    } catch (err) {
      try { unlinkSync(temp); } catch { /* no temporary file left */ }
      throw err;
    }
    state = next;
  }

  return {
    getLastScanTime: () => new Date(state.lastScanTime),
    getHistorySince: () => new Date(state.historySince),
    messages: () => state.messages.map((m) => ({ ...m, time: new Date(m.time) })),
    reports: () => structuredClone(state.reports),
    addMessages(entries) {
      const existing = new Set([...Object.keys(state.seen), ...state.messages.map((m) => m.id)]);
      const fresh = entries.filter((m) => {
        if (!nonemptyString(m.id) || !nonemptyString(m.jid) || !nonemptyString(m.text)
          || typeof m.sender !== 'string' || !(m.time instanceof Date)
          || !Number.isFinite(m.time.getTime()) || existing.has(m.id)) return false;
        existing.add(m.id);
        return true;
      });
      if (!fresh.length) return 0;
      update((next) => {
        for (const m of fresh) {
          next.messages.push({ ...m, time: m.time.toISOString() });
          next.seen[m.id] = m.time.toISOString();
        }
      });
      return fresh.length;
    },
    enqueueReport(report) {
      update((next) => { next.reports.push(structuredClone(report)); });
    },
    recordDelivery(reportId, jid, nextPart) {
      update((next) => {
        const report = next.reports.find((r) => r.id === reportId);
        const recipient = report?.recipients.find((r) => r.jid === jid);
        if (!recipient) throw new Error('Unknown report recipient');
        recipient.nextPart = nextPart;
      });
    },
    acknowledgeReport(reportId) {
      update((next) => {
        const report = next.reports.find((r) => r.id === reportId);
        if (!report || report.recipients.some((r) => r.nextPart < report.parts.length)) throw new Error('Report has undelivered parts');
        const ids = new Set(report.messageIds);
        next.messages = next.messages.filter((m) => !ids.has(m.id));
        next.reports = next.reports.filter((r) => r.id !== reportId);
      });
    },
    finishScan(date) {
      update((next) => {
        next.lastScanTime = date.toISOString();
        const cutoff = Math.min(now() - RETENTION_MS, replayFloor);
        const pending = new Set(next.messages.map((m) => m.id));
        for (const [id, time] of Object.entries(next.seen)) {
          if (!pending.has(id) && Date.parse(time) < cutoff) delete next.seen[id];
        }
      });
    },
    completeHistory(date) {
      update((next) => {
        if (date > new Date(next.historySince)) next.historySince = date.toISOString();
      });
    },
    overrideLastScanTime(date) {
      if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new Error('Invalid scan date');
      update((next) => {
        next.lastScanTime = date.toISOString();
        next.historySince = date.toISOString();
        const pending = new Set(next.messages.map((m) => m.id));
        for (const [id, time] of Object.entries(next.seen)) {
          if (!pending.has(id) && Date.parse(time) > date.getTime()) delete next.seen[id];
        }
      });
      replayFloor = date.getTime();
    },
  };
}
