import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { textGetter } from '../lib/publish.mjs';
import { main } from '../verify.mjs';
import { checkpoint, days, newKey, repo, server } from './helpers.mjs';

const key = newKey();
const read = (dir, file) => fs.readFileSync(path.join(dir, file), 'utf8');
const files = (dir) => (fs.existsSync(path.join(dir, 'checkpoints')) ? fs.readdirSync(path.join(dir, 'checkpoints')).sort() : []);

/** A repository that already published size `size` of `leaves`. */
async function published(size, leaves) {
  const dir = repo(key);
  await main(dir, server({ note: checkpoint(key, size, leaves), leaves }).getText);
  return dir;
}

test('the first checkpoint is kept as checkpoints/<size>.txt and latest.txt', async () => {
  const leaves = days(3);
  const dir = repo(key);
  const note = checkpoint(key, 3, leaves);
  const result = await main(dir, server({ note, leaves }).getText);
  assert.equal(result.state, 'first');
  assert.equal(read(dir, 'latest.txt'), note);
  assert.equal(read(dir, 'checkpoints/3.txt'), note);
});

test('a consistent larger checkpoint is kept, after its consistency proof', async () => {
  const leaves = days(7);
  const dir = await published(3, leaves);
  const fake = server({ note: checkpoint(key, 7, leaves), leaves });
  const result = await main(dir, fake.getText);
  assert.equal(result.state, 'new');
  assert.deepEqual(files(dir), ['3.txt', '7.txt']);
  assert.ok(fake.calls.some((url) => url.endsWith('/anchors/proof/consistency?from=3&to=7')));
});

test('the same checkpoint again writes nothing', async () => {
  const leaves = days(4);
  const dir = await published(4, leaves);
  const before = read(dir, 'latest.txt');
  const result = await main(dir, server({ note: checkpoint(key, 4, leaves), leaves }).getText);
  assert.equal(result.state, 'unchanged');
  assert.equal(read(dir, 'latest.txt'), before);
});

// Fault injection: each case changes ONE thing a lying server could, and
// leaves everything else honest, so only the check under test can refuse.
async function refused(dir, state, pattern) {
  const before = read(dir, 'latest.txt');
  const listed = files(dir);
  await assert.rejects(main(dir, server(state).getText), (error) => {
    assert.equal(error.code, 1, error.message);
    assert.match(error.message, pattern);
    return true;
  });
  assert.equal(read(dir, 'latest.txt'), before, 'latest.txt must not change');
  assert.deepEqual(files(dir), listed, 'no checkpoint file may be written');
}

test('REFUSES a tampered leaf: a correctly signed tree that rewrote an old day', async () => {
  const leaves = days(5);
  const dir = await published(3, leaves);
  const rewritten = [...leaves];
  rewritten[1] = days(1, ' forged')[0];
  // Signed by the right key; its proof is honest for the REWRITTEN tree.
  await refused(dir, { note: checkpoint(key, 5, rewritten), leaves: rewritten }, /NOT consistent/);
});

test('REFUSES a rolled-back size', async () => {
  const leaves = days(5);
  const dir = await published(5, leaves);
  await refused(dir, { note: checkpoint(key, 3, leaves), leaves }, /BACKWARDS/);
});

test('REFUSES a forked checkpoint: another tree of the same size', async () => {
  const leaves = days(4);
  const dir = await published(4, leaves);
  await refused(dir, { note: checkpoint(key, 4, days(4, ' fork')), leaves }, /FORK/);
});

test('REFUSES a checkpoint signed by another key', async () => {
  const leaves = days(4);
  const dir = await published(3, leaves);
  await refused(dir, { note: checkpoint(newKey(), 4, leaves), leaves }, /not signed by the log key/);
});

test('REFUSES a bad signature by the right key', async () => {
  const leaves = days(4);
  const dir = await published(3, leaves);
  const note = checkpoint(key, 4, leaves);
  const sig = note.trim().split(' ').pop();
  const bytes = Buffer.from(sig, 'base64');
  bytes[10] ^= 1;
  await refused(dir, { note: note.replace(sig, bytes.toString('base64')), leaves }, /does not verify/);
});

test('REFUSES a checkpoint for another log, and one that is not a checkpoint', async () => {
  const leaves = days(4);
  const dir = await published(3, leaves);
  await refused(dir, { note: key.sign(`example.org/other\n4\n${'A'.repeat(43)}=\n`), leaves }, /not "orgspirituality/);
  await refused(dir, { note: key.sign('hello\n'), leaves }, /not a checkpoint/);
  await refused(dir, { note: 'garbage', leaves }, /not a signed note/);
});

test('REFUSES a proof that does not fit: wrong sizes, junk hashes, none', async () => {
  const leaves = days(6);
  const dir = await published(3, leaves);
  const note = checkpoint(key, 6, leaves);
  await refused(dir, { note, leaves, proof: [] }, /NOT consistent/);
  await refused(dir, { note, leaves, proofText: JSON.stringify({ from: 2, to: 6, proof: [] }) }, /NOT consistent/);
  await refused(dir, { note, leaves, proofText: JSON.stringify({ from: 3, to: 6, proof: ['not base64!'] }) }, /NOT consistent/);
  await refused(dir, { note, leaves, proofText: JSON.stringify({ from: 3, to: 6 }) }, /NOT consistent/);
});

test('REFUSES when the committed latest.txt itself was edited', async () => {
  const leaves = days(4);
  const dir = await published(3, leaves);
  fs.writeFileSync(path.join(dir, 'latest.txt'), read(dir, 'latest.txt').replace('\n3\n', '\n2\n'));
  await refused(dir, { note: checkpoint(key, 4, leaves), leaves }, /committed latest.txt/);
});

test('REFUSES to overwrite a stored checkpoint file with another', async () => {
  const leaves = days(4);
  const dir = repo(key);
  fs.mkdirSync(path.join(dir, 'checkpoints'));
  fs.writeFileSync(path.join(dir, 'checkpoints', '4.txt'), 'something else');
  fs.writeFileSync(path.join(dir, 'latest.txt'), checkpoint(key, 2, leaves));
  fs.mkdirSync(path.join(dir, 'entries'));
  leaves.records.slice(0, 2).forEach((text, i) => fs.writeFileSync(path.join(dir, 'entries', `0000000${i}.txt`), text));
  await refused(dir, { note: checkpoint(key, 4, leaves), leaves }, /already holds a different/);
});

test('cannot measure: not set up (no key, no server), never a pass', async () => {
  const dir = repo(key, 'https://REPLACE-WITH-THE-API-HOST/api/v1');
  await assert.rejects(main(dir, server({}).getText), (e) => e.code === 3 && /no server address/.test(e.message));
  const noKey = repo(key);
  fs.writeFileSync(path.join(noKey, 'log.vkey'), 'REPLACE WITH THE PUBLIC KEY\n');
  await assert.rejects(main(noKey, server({}).getText), (e) => e.code === 3 && /no valid public key/.test(e.message));
  const other = repo(newKey('example.org/x'));
  await assert.rejects(main(other, server({}).getText), (e) => e.code === 3 && /log.vkey is for/.test(e.message));
});

test('cannot measure: the server never answers, or answers junk; nothing written', async () => {
  const leaves = days(4);
  const dir = await published(3, leaves);
  await assert.rejects(main(dir, server({ down: true }).getText), (e) => e.code === 3);
  await assert.rejects(
    main(dir, server({ note: checkpoint(key, 4, leaves), leaves, proofText: '<html>' }).getText),
    (e) => e.code === 3 && /not JSON/.test(e.message),
  );
  assert.deepEqual(files(dir), ['3.txt']);
});

test('an empty log is nothing to publish', async () => {
  const dir = repo(key);
  const result = await main(dir, server({ note: checkpoint(key, 0, []), leaves: [] }).getText);
  assert.equal(result.state, 'unchanged');
  assert.equal(fs.existsSync(path.join(dir, 'latest.txt')), false);
});

test('waits out a cold start: retries until the server answers', async () => {
  const waited = [];
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls <= 3) throw new Error('connect ECONNREFUSED');
    if (calls === 4) return new Response('waking', { status: 503 });
    return new Response('ok\n', { status: 200 });
  };
  const get = textGetter({ fetchImpl, sleep: async (s) => waited.push(s) });
  assert.equal(await get('https://x/anchors/checkpoint'), 'ok\n');
  assert.deepEqual(waited, [5, 10, 15, 20]);
  // The default waits add up to more than a minute (Render's free tier).
  const total = [5, 10, 15, 20, 30, 30, 30].reduce((a, b) => a + b, 0);
  assert.ok(total >= 60);
});

test('gives up after its tries, and at once on a 4xx', async () => {
  let calls = 0;
  const down = textGetter({ fetchImpl: async () => { calls += 1; throw new Error('offline'); }, sleep: async () => {} });
  await assert.rejects(down('https://x/y'), (e) => e.code === 3 && /offline/.test(e.message));
  assert.equal(calls, 8);
  calls = 0;
  const missing = textGetter({ fetchImpl: async () => { calls += 1; return new Response('no', { status: 404 }); }, sleep: async () => {} });
  await assert.rejects(missing('https://x/y'), (e) => e.code === 3 && /HTTP 404/.test(e.message));
  assert.equal(calls, 1);
  const huge = textGetter({ tries: 1, fetchImpl: async () => new Response('x'.repeat(70_000), { status: 200 }) });
  await assert.rejects(huge('https://x/y'), /too large/);
});

test("L5: a 409 (the server's copy of the log is broken) is REFUSED, exit 1, not cannot-measure", async () => {
  let calls = 0;
  const broken = textGetter({
    fetchImpl: async () => {
      calls += 1;
      return new Response('{"message":"inconsistent"}', { status: 409 });
    },
    sleep: async () => {},
  });
  await assert.rejects(broken('https://x/anchors/proof/consistency?from=1&to=2'), (e) => e.code === 1 && /409/.test(e.message));
  assert.equal(calls, 1);
});
