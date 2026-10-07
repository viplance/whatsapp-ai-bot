// Prefer word/line boundaries and never cut a UTF-16 surrogate pair in half.
export function splitText(text, limit) {
  if (!Number.isInteger(limit) || limit < 2) throw new Error('Text limit must be at least 2');
  const parts = [];
  while (text.length > limit) {
    let end = limit;
    const boundary = Math.max(text.lastIndexOf('\n', limit - 1), text.lastIndexOf(' ', limit - 1));
    if (boundary >= limit / 2) end = boundary + 1;
    const char = text.charCodeAt(end - 1);
    if (char >= 0xD800 && char <= 0xDBFF) end--;
    parts.push(text.slice(0, end));
    text = text.slice(end);
  }
  if (text) parts.push(text);
  return parts;
}
