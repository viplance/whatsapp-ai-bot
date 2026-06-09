import { config } from './config.js';

// Pre-lowercased filter terms; empty array means "no filtering → process all".
const TERMS = (config.filters || [])
  .filter((f) => typeof f === 'string' && f.trim() !== '')
  .map((f) => f.toLowerCase());

export const filtersActive = TERMS.length > 0;

/**
 * True if any candidate string (e.g. group/channel name, sender name) contains
 * one of the configured filter terms (case-insensitive substring). When no
 * filters are configured, everything passes.
 */
export function matchesFilters(...candidates) {
  if (!filtersActive) return true;

  for (const candidate of candidates) {
    if (!candidate) continue;
    const hay = String(candidate).toLowerCase();
    if (TERMS.some((term) => hay.includes(term))) return true;
  }
  return false;
}
