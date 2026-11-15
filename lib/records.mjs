// The anchor log's leaves: canonical day records (the ORG backend's
// src/anchoring/day-record.ts, format org-anchor-day-v2). Only hashes,
// counts and times; this check is what keeps anything else, a name for
// instance, from ever being committed to this public repository.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const RECORD =
  /^org-anchor-day-v2\nday (\d{4}-\d{2}-\d{2})\ntree (none|org-anchor-merkle-v[1-9]\d*)\nroot (none|[0-9a-f]{64})\nleaves (0|[1-9]\d{0,15})\nleafset (none|[0-9a-f]{64})\nappended (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\n$/;

/** True for exactly one canonical day record. */
export function isDayRecord(text) {
  const m = typeof text === 'string' ? RECORD.exec(text) : null;
  if (!m) return false;
  const [, day, tree, root, leaves, leafset, appended] = m;
  const empty = tree === 'none';
  const at = Date.parse(appended);
  return (
    !Number.isNaN(Date.parse(`${day}T00:00:00.000Z`)) &&
    new Date(`${day}T00:00:00.000Z`).toISOString().startsWith(day) &&
    !Number.isNaN(at) &&
    new Date(at).toISOString() === appended &&
    empty === (root === 'none') &&
    empty === (leaves === '0') &&
    empty === (leafset === 'none')
  );
}

/** RFC 6962 leaf hash of a record. */
export const leafHashOf = (text) => createHash('sha256').update(Buffer.from([0])).update(Buffer.from(text, 'utf8')).digest();

const node = (l, r) => createHash('sha256').update(Buffer.from([1])).update(l).update(r).digest();

/** MTH over leaf hashes (RFC 6962 §2.1). */
export function treeRoot(leaves) {
  if (leaves.length === 0) return createHash('sha256').digest();
  if (leaves.length === 1) return leaves[0];
  let k = 1;
  while (k * 2 < leaves.length) k *= 2;
  return node(treeRoot(leaves.slice(0, k)), treeRoot(leaves.slice(k)));
}

export const entryName = (index) => `${String(index).padStart(8, '0')}.txt`;

/**
 * The entries kept in `<dir>/entries`, in order. Returns undefined when
 * they are not exactly 00000000.txt .. (n-1) with valid records.
 */
export function readEntries(dir) {
  const folder = path.join(dir, 'entries');
  if (!fs.existsSync(folder)) return [];
  const names = fs.readdirSync(folder).filter((n) => n.endsWith('.txt')).sort();
  const records = [];
  for (const [i, name] of names.entries()) {
    if (name !== entryName(i)) return undefined;
    const text = fs.readFileSync(path.join(folder, name), 'utf8');
    if (!isDayRecord(text)) return undefined;
    records.push(text);
  }
  return records;
}
