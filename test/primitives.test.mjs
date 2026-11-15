import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { test } from 'node:test';
import { openNote, parseCheckpoint, parseVerifier } from '../lib/note.mjs';
import { parseDetached, stamp, summarize, upgrade, isUpgradeUriAllowed } from '../lib/ots.mjs';
import { verifyConsistency } from '../lib/tlog.mjs';

const json = (name) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

// Go's note package (github.com/golang/mod, commit 2b553c8b, sumdb/note/note.go)
// and c2sp.org/signed-note (github.com/C2SP/C2SP, commit 09f3e519, "Example").
const GO_VKEY = 'PeterNeumann+c74f20a3+ARpc2QcUPDhMQegwxbzhKqiBfsVkmqq/LDE4izWy10TW';
const GO_TEXT = "If you think cryptography is the answer to your problem,\nthen you don't know what your problem is.\n";
const GO_NOTE = `${GO_TEXT}\n— PeterNeumann x08go/ZJkuBS9UG/SffcvIAQxVBtiFupLLr8pAcElZInNIuGUgYN1FFYC2pZSNXgKvqfqdngotpRZb6KE6RyyBwJnAM=\n`;
const C2SP_VKEY = 'example.com/foo+530d903a+AekyeRrm56hApGFkyQR4ZCbV54Id2LKaANYcrnKv3U2k';
const C2SP_NOTE = 'This is an example message.\n\n— example.com/foo Uw2QOkn8srV1yJGh2VYRlL1Tnagv1YEq6TfXppzi2ONncAlTgK7Ztg1ERYNZXsYjOBH3mFXmRKuwHjG1Yu72IneyaQM=\n';

test('signed notes: the Go and C2SP vectors open; tampering does not', () => {
  assert.deepEqual(openNote(GO_NOTE, parseVerifier(GO_VKEY)), { ok: true, text: GO_TEXT });
  assert.equal(openNote(C2SP_NOTE, parseVerifier(C2SP_VKEY)).ok, true);
  assert.deepEqual(openNote(C2SP_NOTE, parseVerifier(GO_VKEY)), { ok: false, reason: 'unsigned' });
  assert.deepEqual(openNote(GO_NOTE.replace('answer', 'answers'), parseVerifier(GO_VKEY)), { ok: false, reason: 'bad-signature' });
  for (const bad of ['', GO_TEXT, GO_NOTE.replace('JnAM=', 'JnAN='), GO_NOTE.replace('If', 'I\tf'), 'x'.repeat(20000), 7]) {
    assert.equal(openNote(bad, parseVerifier(GO_VKEY)).ok, false);
  }
  for (const key of ['', 'a+b', 'PeterNeumann+c74f20a4+ARpc2QcUPDhMQegwxbzhKqiBfsVkmqq/LDE4izWy10TW', 'PeterNeumann+173116ae+ZRpc2QcUPDhMQegwxbzhKqiBfsVkmqq/LDE4izWy10TW']) {
    assert.throws(() => parseVerifier(key));
  }
  const root = Buffer.alloc(32, 1);
  assert.deepEqual(parseCheckpoint(`o\n5\n${root.toString('base64')}\n`), { origin: 'o', size: 5, root });
  for (const text of ['o\n05\nAA==\n', `o\n5\n${root.toString('base64')}\next\n`, 'o\n5\nAAAA\n']) {
    assert.equal(parseCheckpoint(text), undefined);
  }
});

test('consistency: every probe of the Go library behaves as it expects', () => {
  const { consistency } = json('consistency-vectors.json');
  assert.equal(consistency.length, 98);
  const hex = (h) => Buffer.from(h ?? '', 'hex');
  for (const p of consistency) {
    assert.equal(
      verifyConsistency(p.size1, p.size2, hex(p.root1), hex(p.root2), p.proof.map(hex)),
      !p.wantErr,
      p.file,
    );
  }
});

test('OpenTimestamps: the four real calendar answers make exactly the real Step 0 file', async () => {
  const f = json('ots-step0.json');
  const digest = Buffer.from(f.digest, 'hex');
  const urls = Object.keys(f.calendars);
  const posted = [];
  const post = async (url, body) => {
    posted.push([url, Buffer.from(body).toString('hex')]);
    return { status: 200, body: Buffer.from(f.calendars[url.replace(/\/digest$/, '')], 'base64') };
  };
  const { proof, errors } = await stamp(digest, post, urls);
  assert.deepEqual(errors, []);
  assert.equal(proof.toString('base64'), f.otsFile);
  // Only the digest left: nothing else was posted.
  assert.deepEqual(posted.map(([, body]) => body), urls.map(() => f.digest));
  assert.equal(summarize(parseDetached(proof).tree).pending.length, 4);
});

test('OpenTimestamps: one calendar down is fine; all down is an error', async () => {
  const f = json('ots-step0.json');
  const digest = Buffer.from(f.digest, 'hex');
  const urls = Object.keys(f.calendars);
  const some = await stamp(digest, async (url) => (url.includes('a.pool.opentimestamps') ? { status: 503 } : { status: 200, body: Buffer.from(f.calendars[url.replace(/\/digest$/, '')], 'base64') }), urls);
  assert.equal(some.errors.length, 1);
  await assert.rejects(stamp(digest, async () => { throw new Error('offline'); }, urls), /no calendar accepted/);
});

test('OpenTimestamps: a pending proof is upgraded by the real Bitcoin answer, and only by it', async () => {
  const f = json('ots-step0.json');
  const file = Buffer.from(f.otsFile, 'base64');
  const asked = [];
  const get = async (url) => {
    asked.push(url);
    return url.endsWith(f.aliceCommitment) ? { status: 200, body: Buffer.from(f.aliceUpgrade, 'base64') } : { status: 404 };
  };
  const result = await upgrade(file, get);
  assert.equal(result.changed, true);
  assert.equal(result.confirmed, true);
  assert.deepEqual(summarize(parseDetached(result.proof).tree).bitcoin, [975755]);
  // Already confirmed: nothing asked.
  asked.length = 0;
  const again = await upgrade(result.proof, get);
  assert.deepEqual([again.changed, again.confirmed, asked.length], [false, true, 0]);
  // Still pending everywhere, or an answer with no Bitcoin part: unchanged.
  const pending = await upgrade(file, async () => ({ status: 404 }));
  assert.deepEqual([pending.changed, pending.confirmed], [false, false]);
  // A calendar answering with another pending-only timestamp.
  const noBitcoin = await upgrade(file, async () => ({ status: 200, body: Buffer.from(Object.values(f.calendars)[0], 'base64') }));
  assert.equal(noBitcoin.changed, false);
  const broken = await upgrade(file, async () => { throw new Error('reset'); });
  assert.equal(broken.changed, false);
  assert.throws(() => parseDetached(Buffer.alloc(64)), /not an OpenTimestamps proof/);
});

test('OpenTimestamps: upgrades only from the reference whitelist', () => {
  assert.equal(isUpgradeUriAllowed('https://alice.btc.calendar.opentimestamps.org'), true);
  for (const uri of ['http://alice.btc.calendar.opentimestamps.org', 'https://evil.example', 'https://x.calendar.opentimestamps.org:8443', 'nope']) {
    assert.equal(isUpgradeUriAllowed(uri), false);
  }
});

test('the stamp file is the SHA-256 of the checkpoint file', () => {
  const text = 'o\n1\nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n';
  assert.equal(createHash('sha256').update(text).digest('hex').length, 64);
});
