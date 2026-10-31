'use client';

import { inferFieldType, parseCsv, type FieldType } from '@monty/domain';
import type { DatabaseDto } from '@monty/validation';
import { ChangeEvent, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { Button, Field, Input, Modal, Select } from '../ui';
import { FIELD_TYPE_LABEL } from './Cell';

const BATCH = 300; // keeps each request well under the API's 1 MB body limit
const MAX_COLUMNS = 50;

interface Column {
  name: string;
  type: FieldType;
  choices?: string[];
  include: boolean;
}

/**
 * Import a CSV (e.g. Notion's "Export → Markdown & CSV", or a spreadsheet saved as CSV) as a new database.
 * Column types are guessed from the data and can be changed before importing.
 */
export function ImportDialog({ workspaceId, onClose, onImported }: { workspaceId: string; onClose: () => void; onImported: (db: DatabaseDto) => void }) {
  const [name, setName] = useState('');
  const [rows, setRows] = useState<string[][] | null>(null);
  const [titleCol, setTitleCol] = useState(0);
  const [columns, setColumns] = useState<Column[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

  async function pick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    if (file.size > 20 * 1024 * 1024) return setError('That file is larger than 20 MB.');
    const parsed = parseCsv(await file.text());
    if (parsed.length < 1 || !parsed[0]?.length) return setError('That file has no rows.');
    const header = parsed[0].map((h, i) => h.trim() || `Column ${i + 1}`);
    const body = parsed.slice(1);
    const nameIdx = Math.max(0, header.findIndex((h) => /^(name|title)$/i.test(h)));
    setName(file.name.replace(/\.csv$/i, '').replace(/ [0-9a-f]{32}$/i, '')); // Notion appends an id to file names
    setTitleCol(nameIdx);
    setRows(body);
    setColumns(
      header.map((h, i) => {
        const guess = inferFieldType(body.slice(0, 500).map((r) => r[i] ?? ''));
        return { name: h.slice(0, 100), type: guess.type, choices: guess.choices, include: i !== nameIdx && i < MAX_COLUMNS + 1 };
      }),
    );
  }

  async function run() {
    if (!rows) return;
    const picked = columns.map((c, i) => ({ ...c, index: i })).filter((c) => c.include && c.index !== titleCol).slice(0, MAX_COLUMNS);
    const fields = picked.map((c) => {
      const values = rows.map((r) => r[c.index] ?? '');
      const choices =
        c.type === 'select'
          ? [...new Set(values.map((v) => v.trim()).filter(Boolean))]
          : c.type === 'multi_select'
            ? [...new Set(values.flatMap((v) => v.split(',').map((p) => p.trim())).filter(Boolean))]
            : undefined;
      return { name: c.name, type: c.type, ...(choices ? { choices: choices.slice(0, 100) } : {}) };
    });
    const toRow = (r: string[]) => ({ title: (r[titleCol] ?? '').slice(0, 500), cells: picked.map((c) => (r[c.index] ?? '').slice(0, 10_000)) });
    try {
      setProgress(`Importing 0 of ${rows.length}…`);
      const { database } = await api.databases.create(workspaceId, { id: crypto.randomUUID(), name: name.trim() || 'Imported', import: { fields, rows: rows.slice(0, BATCH).map(toRow) } });
      for (let i = BATCH; i < rows.length; i += BATCH) {
        setProgress(`Importing ${i} of ${rows.length}…`);
        await api.databases.importRows(database.id, { rows: rows.slice(i, i + BATCH).map(toRow) });
      }
      onImported(database);
    } catch (err) {
      setError(errorMessage(err));
      setProgress(null);
    }
  }

  return (
    <Modal open onClose={onClose} title="Import CSV">
      <div className="space-y-3">
        <p className="text-[13px] text-muted">
          From Notion: open the database → ••• → Export → “Markdown &amp; CSV”, unzip, and choose the .csv file. From a spreadsheet: save as CSV.
        </p>
        <Field label="CSV file" htmlFor="import-file">
          <input id="import-file" type="file" accept=".csv,text/csv" onChange={(e) => void pick(e)} className="text-[13px]" />
        </Field>
        {error ? <p role="alert" className="text-[13px] text-danger">{error}</p> : null}
        {rows ? (
          <>
            <Field label="Database name" htmlFor="import-name">
              <Input id="import-name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Name column" htmlFor="import-title">
              <Select id="import-title" className="w-full" value={titleCol} onChange={(e) => setTitleCol(Number(e.target.value))}>
                {columns.map((c, i) => (
                  <option key={i} value={i}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="max-h-60 overflow-y-auto">
              <table className="w-full text-[13px]">
                <caption className="sr-only">Columns to import</caption>
                <thead>
                  <tr className="text-left text-muted">
                    <th scope="col">Import</th>
                    <th scope="col">Column</th>
                    <th scope="col">Type</th>
                  </tr>
                </thead>
                <tbody>
                  {columns.map((c, i) =>
                    i === titleCol ? null : (
                      <tr key={i}>
                        <td>
                          <input type="checkbox" aria-label={`Import column ${c.name}`} checked={c.include} onChange={(e) => setColumns(columns.map((x, j) => (j === i ? { ...x, include: e.target.checked } : x)))} />
                        </td>
                        <td className="truncate pr-2">{c.name}</td>
                        <td>
                          <Select aria-label={`Type of ${c.name}`} value={c.type} onChange={(e) => setColumns(columns.map((x, j) => (j === i ? { ...x, type: e.target.value as FieldType } : x)))}>
                            {Object.entries(FIELD_TYPE_LABEL)
                              .filter(([k]) => k !== 'person')
                              .map(([k, v]) => (
                                <option key={k} value={k}>
                                  {v}
                                </option>
                              ))}
                          </Select>
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            </div>
            <p className="text-[13px] text-muted">
              {rows.length} rows. Values that don’t fit a column’s type are left empty. People columns can’t be imported — add a Person field afterwards.
            </p>
            {rows.length > 10_000 ? <p className="text-[13px] text-danger">A database can hold at most 10,000 rows.</p> : null}
          </>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={progress !== null} disabled={!rows || rows.length > 10_000} onClick={() => void run()}>
            {progress ?? 'Import'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
