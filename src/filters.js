// Turkish names may use I, İ, or ı. Lowercasing İ leaves a combining dot;
// fold these variants consistently without stripping other name accents.
const normalizeName = (value) => String(value).normalize('NFC').toLowerCase().replace(/i\u0307|ı/g, 'i');

export function createFilters(filters) {
  const terms = filters.map((f) => normalizeName(f.trim())).filter(Boolean);
  return {
    active: terms.length > 0,
    matches: (...candidates) => !terms.length || candidates.some((candidate) =>
      candidate && terms.some((term) => normalizeName(candidate).includes(term))),
  };
}
