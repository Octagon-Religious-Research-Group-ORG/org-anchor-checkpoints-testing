import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { compareLogs } from '../lib/rotation.mjs';
import { checkpoint, days, leafOf, newKey, record } from './helpers.mjs';

// Review round 1, M2c: a key rotation starts a new log (…/anchors/v2) that
// re-appends every day, and freezes v1. compare-logs.mjs proves the new
// log did not rewrite history: every v1 day is in v2 with the same tree,
// root, count and leaf set (only its append time is new).
const V1 = 'orgspirituality.org/anchors/v1';
const V2 = 'orgspirituality.org/anchors/v2';

/** A published repository: entries, log.vkey, and a latest.txt over them. */
function published(signer, records, origin, vkeyOf = signer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rot-'));
  fs.writeFileSync(path.join(dir, 'log.json'), JSON.stringify({ origin, server: 'https://x/api/v1' }));
  fs.writeFileSync(path.join(dir, 'log.vkey'), `${vkeyOf.vkey}\n`);
  fs.mkdirSync(path.join(dir, 'entries'));
  records.forEach((text, i) => fs.writeFileSync(path.join(dir, 'entries', `${String(i).padStart(8, '0')}.txt`), text));
  fs.writeFileSync(path.join(dir, 'latest.txt'), checkpoint(signer, records.length, records.map(leafOf), origin));
  return dir;
}

const reappended = (text) => text.replace(/appended .*\n$/, 'appended 2027-01-01T04:00:00.000Z\n');

test('M2c: a faithful v2 holds every v1 day unchanged but its append time', () => {
  const v1 = days(3).records;
  const v2 = [...v1.map(reappended), record(3)];
  assert.deepEqual(compareLogs(published(newKey(), v1, V1), published(newKey(V2), v2, V2)), { ok: true, days: 3 });
});

test('M2c: FAILS when v2 changed a v1 day, or left one out', () => {
  const v1 = days(3).records;
  const a = published(newKey(), v1, V1);
  const changed = [v1[0], record(1, ' rewritten'), v1[2]].map(reappended);
  const result = compareLogs(a, published(newKey(V2), changed, V2));
  assert.equal(result.ok, false);
  assert.match(result.problems.join(), /2026-01-02 differs/);
  const missing = v1.slice(0, 2).map(reappended);
  assert.match(compareLogs(a, published(newKey(V2), missing, V2)).problems.join(), /2026-01-03 is missing/);
});

test('M2c: FAILS a repository that does not hold together on its own', () => {
  const v1 = days(2).records;
  const a = published(newKey(), v1, V1);
  fs.writeFileSync(path.join(a, 'entries', '00000001.txt'), record(1, ' edited'));
  const result = compareLogs(a, a);
  assert.equal(result.ok, false);
  assert.match(result.problems.join(), /entries do not give its latest\.txt/);
  const b = published(newKey(), v1, V1, newKey());
  assert.match(compareLogs(b, b).problems.join(), /not signed by its log\.vkey/);
});
