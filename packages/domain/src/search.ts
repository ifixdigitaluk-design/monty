/**
 * Builds a safe Postgres prefix tsquery ("desi:* & home:*") from free text.
 * Only letters/digits survive, so user input can never inject tsquery operators.
 */
export function toPrefixTsQuery(input: string, maxTerms = 8): string | null {
  const terms = (input.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, maxTerms);
  return terms.length ? terms.map((t) => `${t}:*`).join(' & ') : null;
}

/** Splits a ts_headline snippet that uses [[ ]] markers into plain/highlighted parts (rendered as text, never HTML). */
export function splitHighlights(snippet: string): { text: string; hit: boolean }[] {
  const parts: { text: string; hit: boolean }[] = [];
  const re = /\[\[(.*?)\]\]/g;
  let last = 0;
  for (const m of snippet.matchAll(re)) {
    if (m.index! > last) parts.push({ text: snippet.slice(last, m.index), hit: false });
    parts.push({ text: m[1]!, hit: true });
    last = m.index! + m[0].length;
  }
  if (last < snippet.length) parts.push({ text: snippet.slice(last), hit: false });
  return parts;
}
