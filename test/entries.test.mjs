import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { main } from '../verify.mjs';
import { checkpoint, days, newKey, record, repo, root, server } from './helpers.mjs';

// Review round 1, M2a: the repository keeps every day record too, checked
// against the signed root, so the repository ALONE can rebuild and audit
// the whole log, and the server can be restored from it.
const key = newKey();
const entry = (dir, i) => path.join(dir, 'entries', `${String(i).padStart(8, '0')}.txt`);

async function refusedWith(dir, state, pattern) {
  const listed = fs.existsSync(path.join(dir, 'entries')) ? fs.readdirSync(path.join(dir, 'entries')) : [];
  await assert.rejects(main(dir, server(state).getText), (e) => e.code === 1 && pattern.test(e.message));
  const after = fs.existsSync(path.join(dir, 'entries')) ? fs.readdirSync(path.join(dir, 'entries')) : [];
  assert.deepEqual(after, listed, 'no entry may be written');
}

test('M2a: the first publication keeps every entry, and they rebuild the signed root', async () => {
  const leaves = days(3);
  const dir = repo(key);
  await main(dir, server({ note: checkpoint(key, 3, leaves), leaves }).getText);
  for (let i = 0; i < 3; i++) assert.equal(fs.readFileSync(entry(dir, i), 'utf8'), leaves.records[i]);
  assert.equal(fs.existsSync(entry(dir, 3)), false);
});

test('M2a: a later publication adds only the new range, after the old entries still give the old root', async () => {
  const leaves = days(5);
  const dir = repo(key);
  await main(dir, server({ note: checkpoint(key, 2, leaves), leaves }).getText);
  const fake = server({ note: checkpoint(key, 5, leaves), leaves });
  await main(dir, fake.getText);
  assert.ok(fake.calls.some((u) => u.endsWith('/anchors/entries?from=2&to=5')));
  assert.equal(fs.readdirSync(path.join(dir, 'entries')).length, 5);
});

test('M2a: REFUSES entries that do not give the signed root (honest proof, lying entries)', async () => {
  const leaves = days(4);
  const dir = repo(key);
  const records = [...leaves.records];
  records[2] = record(2, ' other');
  await refusedWith(dir, { note: checkpoint(key, 4, leaves), leaves, records }, /entries .* do not give the signed root/);
});

test('M2a: REFUSES entries that are not day records (nothing else may enter a public repository)', async () => {
  const leaves = days(2);
  const dir = repo(key);
  const records = [leaves.records[0], 'my name is somebody\n'];
  await refusedWith(dir, { note: checkpoint(key, 2, leaves), leaves, records }, /not a day record/);
  await refusedWith(dir, { note: checkpoint(key, 2, leaves), leaves, entriesText: JSON.stringify({ from: 0, to: 1, records: ['x'] }) }, /entries answer/);
});

test("M2a: REFUSES when the repository's own entries were edited", async () => {
  const leaves = days(4);
  const dir = repo(key);
  await main(dir, server({ note: checkpoint(key, 2, leaves), leaves }).getText);
  fs.writeFileSync(entry(dir, 1), record(1, ' edited'));
  await refusedWith(dir, { note: checkpoint(key, 4, leaves), leaves }, /entries\/ no longer give latest\.txt/);
  fs.rmSync(entry(dir, 1));
  await refusedWith(dir, { note: checkpoint(key, 4, leaves), leaves }, /entries\/ no longer give latest\.txt/);
});

test('M2a: the root helper and the kept entries agree', () => {
  const leaves = days(2);
  assert.equal(root(leaves).length, 32);
});
