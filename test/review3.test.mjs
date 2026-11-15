import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { compareRecords } from '../lib/rotation.mjs';
import { isDayRecord } from '../lib/records.mjs';
import { main } from '../verify.mjs';
import { checkpoint, days, leafOf, newKey, record, repo, root, server } from './helpers.mjs';

// Chunk 16b review round 3. Each test was written to fail on the code
// before its fix.
const V1 = 'orgspirituality.org/anchors/v1';
const V2 = 'orgspirituality.org/anchors/v2';
const k1 = newKey(V1);
const k2 = newKey(V2);
const reappended = (text) => text.replace(/appended .*\n$/, 'appended 2027-01-01T04:00:00.000Z\n');

/** A v2 repository with the frozen v1 vendored and pinned. */
function v2Repo(v1Records) {
  const dir = repo(k2);
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'log.json'), 'utf8'));
  config.origin = V2;
  const v1Leaves = v1Records.map(leafOf);
  config.previous = { origin: V1, vkey: k1.vkey, size: v1Records.length, root: root(v1Leaves).toString('base64') };
  fs.writeFileSync(path.join(dir, 'log.json'), JSON.stringify(config));
  fs.mkdirSync(path.join(dir, 'previous', 'entries'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'previous', 'latest.txt'), checkpoint(k1, v1Records.length, v1Leaves, V1));
  v1Records.forEach((text, i) => fs.writeFileSync(path.join(dir, 'previous', 'entries', `${String(i).padStart(8, '0')}.txt`), text));
  return dir;
}

function v2State(records) {
  const leaves = records.map(leafOf);
  leaves.records = records;
  return { note: checkpoint(k2, records.length, leaves, V2), leaves };
}

const refused = (dir, state, pattern) =>
  assert.rejects(main(dir, server(state).getText), (e) => e.code === 1 && pattern.test(e.message));

test('L2 (review 3, probe-dup): REFUSES a v2 holding an ALTERED copy of a v1 day and a faithful copy later', async () => {
  const v1 = days(3).records;
  const dir = v2Repo(v1);
  const altered = record(1, ' rewritten');
  await refused(dir, v2State([v1[0], altered, v1[2], v1[1]].map(reappended)), /2026-01-02 twice/);
  assert.equal(fs.existsSync(path.join(dir, 'latest.txt')), false);
});

test('L2 (review 3): REFUSES any log, rotated or not, that holds one day twice', async () => {
  const key = newKey();
  const dir = repo(key);
  const records = [record(0), record(1), record(1, ' again')];
  const leaves = records.map(leafOf);
  leaves.records = records;
  await refused(dir, { note: checkpoint(key, 3, leaves), leaves }, /2026-01-02 twice/);
  assert.equal(fs.existsSync(path.join(dir, 'latest.txt')), false);
});

test('L2 (review 3): compareRecords names a day held twice in either list', () => {
  const [a, b] = days(2).records;
  assert.deepEqual(compareRecords([a, b, b], [a, b]), ['the previous log holds 2026-01-02 twice']);
  assert.deepEqual(compareRecords([a, b], [a, b, record(1, ' x')]), ['the new log holds 2026-01-02 twice']);
  assert.deepEqual(compareRecords([a, b], [b, a]), []);
});

test('L4 (review 3): a tree scheme is at most three digits of version, so a planted long one is never a day record', () => {
  const ok = record(0);
  assert.equal(isDayRecord(ok.replace('merkle-v2', 'merkle-v999')), true);
  assert.equal(isDayRecord(ok.replace('merkle-v2', 'merkle-v1000')), false);
  assert.equal(isDayRecord(ok.replace('merkle-v2', `merkle-v2${'9'.repeat(70000)}`)), false);
});
