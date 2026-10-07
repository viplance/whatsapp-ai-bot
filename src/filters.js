export function createFilters(filters) {
  const terms = filters.map((f) => f.trim().toLowerCase()).filter(Boolean);
  return {
    active: terms.length > 0,
    matches: (...candidates) => !terms.length || candidates.some((candidate) =>
      candidate && terms.some((term) => String(candidate).toLowerCase().includes(term))),
  };
}
