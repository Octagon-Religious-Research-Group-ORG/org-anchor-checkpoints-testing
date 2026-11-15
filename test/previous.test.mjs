import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { main } from '../verify.mjs';
import { checkpoint, days, leafOf, newKey, record, repo, root, server } from './helpers.mjs';

// Review round 2, M4: a rotated log's repository refuses to publish unless
// every day of the FROZEN previous log (vendored in previous/, pinned in
// log.json by its key, size and root) is in it unchanged but for its
// append time. compare-logs.mjs becomes a gate, not a manual step.
const V1 = 'orgspirituality.org/anchors/v1';
const V2 = 'orgspirituality.org/anchors/v2';
const k1 = newKey(V1);
const k2 = newKey(V2);
const reappended = (text) => text.replace(/appended .*\n$/, 'appended 2027-01-01T04:00:00.000Z\n');

/** A v2 repository with the frozen v1 vendored and pinned. */
function v2Repo(v1Records, pin = {}) {
  const dir = repo(k2);
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'log.json'), 'utf8'));
  config.origin = V2;
  const v1Leaves = v1Records.map(leafOf);
  config.previous = {
    origin: V1,
    vkey: k1.vkey,
    size: v1Records.length,
    root: root(v1Leaves).toString('base64'),
    ...pin,
  };
  fs.writeFileSync(path.join(dir, 'log.json'), JSON.stringify(config));
  fs.mkdirSync(path.join(dir, 'previous', 'entries'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'previous', 'latest.txt'), checkpoint(k1, v1Records.length, v1Leaves, V1));
  v1Records.forEach((text, i) => fs.writeFileSync(path.join(dir, 'previous', 'entries', `${String(i).padStart(8, '0')}.txt`), text));
  return dir;
}

/** The v2 server's state for these records. */
function v2State(records) {
  const leaves = records.map(leafOf);
  leaves.records = records;
  return { note: checkpoint(k2, records.length, leaves, V2), leaves };
}

const refusedWith = async (dir, state, pattern) =>
  assert.rejects(main(dir, server(state).getText), (e) => e.code === 1 && pattern.test(e.message));

test('M4: a faithful v2 (every v1 day re-appended, then more) is published', async () => {
  const v1 = days(3).records;
  const dir = v2Repo(v1);
  const result = await main(dir, server(v2State([...v1.map(reappended), record(3)])).getText);
  assert.equal(result.state, 'first');
});

test('M4: REFUSES a v2 that changed a v1 day', async () => {
  const v1 = days(3).records;
  const dir = v2Repo(v1);
  await refusedWith(dir, v2State([v1[0], record(1, ' rewritten'), v1[2]].map(reappended)), /2026-01-02 differs/);
  assert.equal(fs.existsSync(path.join(dir, 'latest.txt')), false);
});

test('M4: REFUSES a v2 that left a v1 day out', async () => {
  const v1 = days(3).records;
  await refusedWith(v2Repo(v1), v2State(v1.slice(0, 2).map(reappended)), /2026-01-03 is missing/);
});

test('M4: REFUSES when the vendored v1 is not the pinned one, or not signed by its key', async () => {
  const v1 = days(3).records;
  const state = v2State(v1.map(reappended));
  await refusedWith(v2Repo(v1, { size: 2 }), state, /previous log .* not the pinned/);
  await refusedWith(v2Repo(v1, { root: Buffer.alloc(32).toString('base64') }), state, /previous log .* not the pinned/);
  await refusedWith(v2Repo(v1, { vkey: newKey(V1).vkey }), state, /previous log/);
  const edited = v2Repo(v1);
  fs.writeFileSync(path.join(edited, 'previous', 'entries', '00000001.txt'), record(1, ' edited'));
  await refusedWith(edited, state, /previous\/entries do not give its latest\.txt/);
});
