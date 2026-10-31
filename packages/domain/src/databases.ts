/**
 * Notion-style databases: field types, cell validation, and view evaluation (filter → sort → group).
 * Shared by the API (validation on write) and the web app (rendering views), so both agree exactly.
 */

export const FIELD_TYPES = ['text', 'number', 'select', 'multi_select', 'date', 'checkbox', 'person', 'url'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export interface Choice {
  id: string;
  label: string;
  color: string;
}
export interface FieldLike {
  id: string;
  name: string;
  type: FieldType | string;
  options: { choices?: Choice[] };
}
export interface RowLike {
  id: string;
  title: string;
  values: Record<string, unknown>;
  position: number;
  createdAt?: string;
  updatedAt?: string;
}

/** Pseudo field id for the row title in filters and sorts. */
export const TITLE_FIELD = '__title';

export const CHOICE_COLORS = ['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const URL_RE = /^(https?:\/\/|mailto:)\S+$/i;

export type CellResult = { ok: true; value: unknown } | { ok: false; message: string };

/**
 * Validates and normalises a cell value for a field. `null`/empty clears the cell.
 * `isMember` checks person ids (the caller supplies workspace membership).
 */
export function normaliseCell(field: FieldLike, raw: unknown, isMember: (userId: string) => boolean = () => true): CellResult {
  if (raw === null || raw === undefined || raw === '') return { ok: true, value: null };
  const choices = field.options.choices ?? [];
  switch (field.type) {
    case 'text': {
      if (typeof raw !== 'string') return { ok: false, message: 'Must be text' };
      if (raw.length > 10_000) return { ok: false, message: 'Text is too long (10,000 characters max)' };
      return { ok: true, value: raw };
    }
    case 'number': {
      const n = typeof raw === 'string' ? Number(raw.trim()) : raw;
      if (typeof n !== 'number' || !Number.isFinite(n)) return { ok: false, message: 'Must be a number' };
      return { ok: true, value: n };
    }
    case 'checkbox':
      if (typeof raw !== 'boolean') return { ok: false, message: 'Must be true or false' };
      return { ok: true, value: raw ? true : null };
    case 'date': {
      if (typeof raw !== 'string' || !DATE_RE.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) return { ok: false, message: 'Must be a date (YYYY-MM-DD)' };
      // Reject impossible dates such as 2026-02-30 (Date.parse rolls them over).
      if (new Date(`${raw}T00:00:00Z`).toISOString().slice(0, 10) !== raw) return { ok: false, message: 'Not a real date' };
      return { ok: true, value: raw };
    }
    case 'url':
      if (typeof raw !== 'string' || raw.length > 2000 || !URL_RE.test(raw.trim())) return { ok: false, message: 'Must be a link starting with http://, https:// or mailto:' };
      return { ok: true, value: raw.trim() };
    case 'select':
      if (typeof raw !== 'string' || !choices.some((c) => c.id === raw)) return { ok: false, message: 'Not one of the options' };
      return { ok: true, value: raw };
    case 'multi_select': {
      if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string' || !choices.some((c) => c.id === v))) return { ok: false, message: 'Not one of the options' };
      const unique = [...new Set(raw as string[])];
      return { ok: true, value: unique.length ? unique : null };
    }
    case 'person': {
      if (!Array.isArray(raw) || raw.length > 50 || raw.some((v) => typeof v !== 'string')) return { ok: false, message: 'Must be a list of people' };
      const unique = [...new Set(raw as string[])];
      if (unique.some((id) => !isMember(id))) return { ok: false, message: 'Everyone must be a member of this workspace' };
      return { ok: true, value: unique.length ? unique : null };
    }
    default:
      return { ok: false, message: 'Unknown field type' };
  }
}

/** Converts imported text (CSV cell) into a raw value for `normaliseCell`. Unmappable text becomes empty. */
export function cellFromText(field: FieldLike, text: string): unknown {
  const t = text.trim();
  if (!t) return null;
  const choices = field.options.choices ?? [];
  const byLabel = (label: string) => choices.find((c) => c.label.toLowerCase() === label.toLowerCase())?.id;
  switch (field.type) {
    case 'number': {
      const n = Number(t.replace(/,/g, ''));
      return Number.isFinite(n) ? n : null;
    }
    case 'checkbox':
      return ['yes', 'true', '1', 'x', '✓'].includes(t.toLowerCase());
    case 'date':
      return parseLooseDate(t);
    case 'select':
      return byLabel(t) ?? null;
    case 'multi_select':
      return t.split(',').map((p) => byLabel(p.trim())).filter((x): x is string => !!x);
    case 'person':
      return null;
    default:
      return t;
  }
}

// ---------- Views ----------

export const FILTER_OPS = ['contains', 'not_contains', 'is', 'is_not', 'is_empty', 'is_not_empty', 'gt', 'lt', 'before', 'after', 'checked', 'unchecked', 'has'] as const;
export type FilterOp = (typeof FILTER_OPS)[number];
export interface ViewFilter {
  fieldId: string;
  op: FilterOp;
  value?: unknown;
}
export interface ViewSort {
  fieldId: string;
  dir: 'asc' | 'desc';
}
export interface ViewConfig {
  filters?: ViewFilter[];
  /** How filters combine. Default: all must match. */
  match?: 'all' | 'any';
  sorts?: ViewSort[];
  /** Board layout: the select field whose options become columns. */
  groupBy?: string | null;
  hiddenFieldIds?: string[];
  /** Plain-text quick search over title and text cells. */
  search?: string;
}

/** Which operators make sense for a field type (for the filter builder and validation). */
export function opsFor(type: string): FilterOp[] {
  switch (type) {
    case 'text':
    case 'url':
    case TITLE_FIELD:
      return ['contains', 'not_contains', 'is', 'is_not', 'is_empty', 'is_not_empty'];
    case 'number':
      return ['is', 'is_not', 'gt', 'lt', 'is_empty', 'is_not_empty'];
    case 'date':
      return ['is', 'before', 'after', 'is_empty', 'is_not_empty'];
    case 'checkbox':
      return ['checked', 'unchecked'];
    case 'select':
      return ['is', 'is_not', 'is_empty', 'is_not_empty'];
    case 'multi_select':
    case 'person':
      return ['has', 'is_empty', 'is_not_empty'];
    default:
      return [];
  }
}

const cell = (row: RowLike, fieldId: string): unknown => (fieldId === TITLE_FIELD ? row.title || null : row.values[fieldId] ?? null);
const isEmpty = (v: unknown) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

function matches(row: RowLike, f: ViewFilter, type: string): boolean {
  const v = cell(row, f.fieldId);
  switch (f.op) {
    case 'is_empty':
      return isEmpty(v);
    case 'is_not_empty':
      return !isEmpty(v);
    case 'checked':
      return v === true;
    case 'unchecked':
      return v !== true;
    case 'has':
      return Array.isArray(v) && v.includes(f.value);
    default:
      break;
  }
  if (f.value === undefined || f.value === null || f.value === '') return true; // Incomplete filter: ignore it.
  if (type === 'number') {
    const target = Number(f.value);
    if (typeof v !== 'number') return f.op === 'is_not';
    if (f.op === 'is') return v === target;
    if (f.op === 'is_not') return v !== target;
    if (f.op === 'gt') return v > target;
    if (f.op === 'lt') return v < target;
    return true;
  }
  if (type === 'date') {
    if (typeof v !== 'string') return false;
    const t = String(f.value);
    if (f.op === 'is') return v === t;
    if (f.op === 'before') return v < t;
    if (f.op === 'after') return v > t;
    return true;
  }
  const s = typeof v === 'string' ? v.toLowerCase() : '';
  const t = String(f.value).toLowerCase();
  if (f.op === 'contains') return s.includes(t);
  if (f.op === 'not_contains') return !s.includes(t);
  if (f.op === 'is') return type === 'select' ? v === f.value : s === t;
  if (f.op === 'is_not') return type === 'select' ? v !== f.value : s !== t;
  return true;
}

function compare(a: unknown, b: unknown, field: FieldLike | undefined): number {
  // Empty values always sort last, whatever the direction (handled by caller).
  if (field?.type === 'select') {
    const order = (field.options.choices ?? []).map((c) => c.id);
    return order.indexOf(a as string) - order.indexOf(b as string);
  }
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' || typeof b === 'boolean') return Number(a === true) - Number(b === true);
  const sa = Array.isArray(a) ? a.join(',') : String(a);
  const sb = Array.isArray(b) ? b.join(',') : String(b);
  return sa.localeCompare(sb, undefined, { numeric: true, sensitivity: 'base' });
}

/** Applies a view's search, filters and sorts. Unknown fields in the config are ignored (a field may have been deleted). */
export function applyView<R extends RowLike>(rows: R[], fields: FieldLike[], config: ViewConfig): R[] {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const typeOf = (id: string) => (id === TITLE_FIELD ? 'text' : byId.get(id)?.type);
  const filters = (config.filters ?? []).filter((f) => typeOf(f.fieldId) && opsFor(f.fieldId === TITLE_FIELD ? TITLE_FIELD : typeOf(f.fieldId)!).includes(f.op));
  const q = config.search?.trim().toLowerCase();
  const textFields = fields.filter((f) => f.type === 'text' || f.type === 'url');
  let out = rows.filter((r) => {
    if (q && !(r.title.toLowerCase().includes(q) || textFields.some((f) => typeof r.values[f.id] === 'string' && (r.values[f.id] as string).toLowerCase().includes(q)))) return false;
    if (!filters.length) return true;
    const results = filters.map((f) => matches(r, f, typeOf(f.fieldId)!));
    return config.match === 'any' ? results.some(Boolean) : results.every(Boolean);
  });
  const sorts = (config.sorts ?? []).filter((s) => typeOf(s.fieldId));
  out = [...out].sort((a, b) => {
    for (const s of sorts) {
      const va = cell(a, s.fieldId);
      const vb = cell(b, s.fieldId);
      if (isEmpty(va) && isEmpty(vb)) continue;
      if (isEmpty(va)) return 1;
      if (isEmpty(vb)) return -1;
      const c = compare(va, vb, byId.get(s.fieldId));
      if (c !== 0) return s.dir === 'desc' ? -c : c;
    }
    return a.position - b.position;
  });
  return out;
}

/** Board columns: one per option of the group-by select field, plus "No value". Rows keep the view's order. */
export function groupRows<R extends RowLike>(rows: R[], field: FieldLike): { key: string | null; label: string; color: string; rows: R[] }[] {
  const choices = field.options.choices ?? [];
  const groups = [
    { key: null as string | null, label: `No ${field.name}`, color: 'gray', rows: [] as R[] },
    ...choices.map((c) => ({ key: c.id as string | null, label: c.label, color: c.color, rows: [] as R[] })),
  ];
  for (const r of rows) {
    const v = r.values[field.id];
    (groups.find((g) => g.key === v) ?? groups[0]!).rows.push(r);
  }
  return groups;
}

/** A position between two neighbours, for drag-and-drop ordering without renumbering everything. */
export function positionBetween(before: number | null, after: number | null): number {
  if (before === null && after === null) return 1024;
  if (before === null) return after! - 1024;
  if (after === null) return before + 1024;
  return (before + after) / 2;
}

// ---------- CSV (import Notion / spreadsheet exports, export views) ----------

/** RFC 4180 CSV parser: quoted fields, escaped quotes, CRLF/LF, a leading BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const csvCell = (v: string) => {
  // Neutralise spreadsheet formula injection when the file is opened in Excel/Sheets.
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
export function toCsv(rows: string[][]): string {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** Guesses a field type from sample values in an imported column. */
export function inferFieldType(values: string[]): { type: FieldType; choices?: string[] } {
  const v = values.map((x) => x.trim()).filter(Boolean);
  if (!v.length) return { type: 'text' };
  const lower = v.map((x) => x.toLowerCase());
  if (lower.every((x) => ['yes', 'no', 'true', 'false'].includes(x))) return { type: 'checkbox' };
  if (v.every((x) => /^-?\d+(\.\d+)?$/.test(x.replace(/,/g, '')))) return { type: 'number' };
  if (v.every((x) => parseLooseDate(x) !== null)) return { type: 'date' };
  if (v.every((x) => URL_RE.test(x))) return { type: 'url' };
  const distinct = [...new Set(v)];
  if (v.some((x) => x.includes(', ')) && distinct.length > 1) {
    const parts = [...new Set(v.flatMap((x) => x.split(', ').map((p) => p.trim())))];
    if (parts.length <= 30 && v.length >= 3) return { type: 'multi_select', choices: parts };
  }
  if (distinct.length <= 12 && distinct.length < v.length && distinct.every((x) => x.length <= 40)) return { type: 'select', choices: distinct };
  return { type: 'text' };
}

/** Accepts YYYY-MM-DD and long-form dates as Notion exports them ("March 4, 2026"); returns an ISO date string. */
export function parseLooseDate(x: string): string | null {
  if (DATE_RE.test(x)) return x;
  const m = /^([A-Za-z]+) (\d{1,2}), (\d{4})/.exec(x.trim());
  if (!m) return null;
  const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const mi = months.indexOf(m[1]!.toLowerCase());
  if (mi < 0) return null;
  const iso = `${m[3]}-${String(mi + 1).padStart(2, '0')}-${m[2]!.padStart(2, '0')}`;
  return new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) === iso ? iso : null;
}
