// After a key rotation (README, "Key rotation"): does the new log hold
// every day of the frozen old one, unchanged but for its append time?
// Each repository is first checked on its own: latest.txt signed by its
// log.vkey, and its entries giving latest.txt's root. Offline, no server.
import fs from 'node:fs';
import path from 'node:path';
import { openNote, parseCheckpoint, parseVerifier } from './note.mjs';
import { leafHashOf, readEntries, repeatedDays, treeRoot } from './records.mjs';

/** A repository's entries, if it holds together; else the problem. */
function load(dir) {
  const name = path.basename(dir);
  let verifier;
  let origin;
  try {
    verifier = parseVerifier(fs.readFileSync(path.join(dir, 'log.vkey'), 'utf8'));
    origin = JSON.parse(fs.readFileSync(path.join(dir, 'log.json'), 'utf8')).origin;
  } catch {
    return { problem: `${name}: no usable log.vkey or log.json` };
  }
  const opened = openNote(fs.readFileSync(path.join(dir, 'latest.txt'), 'utf8'), verifier);
  const body = opened.ok ? parseCheckpoint(opened.text) : undefined;
  if (!body || body.origin !== origin || verifier.name !== origin) {
    return { problem: `${name}: latest.txt is not signed by its log.vkey for ${origin}` };
  }
  const records = readEntries(dir);
  if (!records || records.length !== body.size || !treeRoot(records.map(leafHashOf)).equals(body.root)) {
    return { problem: `${name}: its entries do not give its latest.txt` };
  }
  return { records };
}

/** The record without its append time: what must survive a rotation. */
const fixed = (text) => text.replace(/^org-anchor-day-v\d+\n/, '').replace(/appended .*\n$/, '');
const dayOf = (text) => /\nday (\S+)\n/.exec(text)[1];

/** @returns { ok: true, days } or { ok: false, problems } */
export function compareLogs(oldDir, newDir) {
  const before = load(oldDir);
  const after = load(newDir);
  const problems = [before.problem, after.problem].filter(Boolean);
  if (problems.length > 0) return { ok: false, problems };
  problems.push(...compareRecords(before.records, after.records));
  return problems.length > 0 ? { ok: false, problems } : { ok: true, days: before.records.length };
}

/** Every old day in the new records, unchanged but for its append time. */
export function compareRecords(oldRecords, newRecords) {
  // A day twice in either list is refused outright (review round 3, L2):
  // otherwise one faithful copy would hide an altered one.
  const problems = [
    ...repeatedDays(oldRecords).map((day) => `the previous log holds ${day} twice`),
    ...repeatedDays(newRecords).map((day) => `the new log holds ${day} twice`),
  ];
  if (problems.length > 0) return problems;
  const kept = new Map(newRecords.map((text) => [dayOf(text), fixed(text)]));
  for (const text of oldRecords) {
    const day = dayOf(text);
    if (!kept.has(day)) problems.push(`${day} is missing from the new log`);
    else if (kept.get(day) !== fixed(text)) problems.push(`${day} differs in the new log`);
  }
  return problems;
}

/**
 * The gate for a rotated log (review round 2, M4): the frozen previous log
 * is vendored in `<dir>/previous/` (its latest.txt and entries/) and pinned
 * in log.json (`previous`: origin, vkey, size, base64 root). It must be
 * exactly the pinned log, signed by its key, and every one of its days must
 * be in `newRecords` unchanged but for the append time.
 * @returns the problems; empty when the gate passes
 */
export function checkPrevious(dir, previous, newRecords) {
  const base = path.join(dir, 'previous');
  let verifier;
  try {
    verifier = parseVerifier(previous.vkey);
  } catch {
    return ['the previous log: log.json has no usable previous.vkey'];
  }
  const latest = path.join(base, 'latest.txt');
  const opened = fs.existsSync(latest) ? openNote(fs.readFileSync(latest, 'utf8'), verifier) : { ok: false };
  const body = opened.ok ? parseCheckpoint(opened.text) : undefined;
  if (!body || body.origin !== previous.origin || verifier.name !== previous.origin) {
    return ['the previous log: previous/latest.txt is not signed by previous.vkey for previous.origin'];
  }
  if (body.size !== previous.size || body.root.toString('base64') !== previous.root) {
    return ['the previous log in previous/ is not the pinned one (size and root in log.json)'];
  }
  const records = readEntries(base);
  if (!records || records.length !== body.size || !treeRoot(records.map(leafHashOf)).equals(body.root)) {
    return ['the previous log: previous/entries do not give its latest.txt'];
  }
  return compareRecords(records, newRecords);
}
