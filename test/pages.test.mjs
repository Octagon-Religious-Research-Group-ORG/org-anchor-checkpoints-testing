import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ENTRIES_PAGE, MAX_ANSWER_BYTES, textGetter } from '../lib/publish.mjs';
import { main } from '../verify.mjs';
import { checkpoint, days, newKey, repo, server } from './helpers.mjs';

// Review round 2, M3: the entries are fetched in pages that fit the answer
// cap with a margin, so a first publication, a catch-up, a rotation or a
// publication after a restore of more than a few hundred days works.
const key = newKey();

/** The fake server behind the REAL getter, so the answer cap applies. */
function capped(state) {
  const fake = server(state);
  return textGetter({
    tries: 1,
    sleep: async () => {},
    fetchImpl: async (url) => new Response(await fake.getText(url), { status: 200 }),
  });
}

test('M3: a first publication of 1,005 days goes through the answer cap', async () => {
  const leaves = days(1005);
  const dir = repo(key);
  const result = await main(dir, capped({ note: checkpoint(key, 1005, leaves), leaves }));
  assert.equal(result.state, 'first');
  assert.equal(fs.readdirSync(path.join(dir, 'entries')).length, 1005);
});

test('a full page of the longest honest records fits the cap with room to spare', () => {
  // The longest record: a 16-digit count and every field at its widest.
  const longest = `org-anchor-day-v2\nday 2026-11-14\ntree org-anchor-merkle-v99\nroot ${'a'.repeat(64)}\nleaves ${'9'.repeat(16)}\nleafset ${'b'.repeat(64)}\nappended 2026-11-14T03:00:00.000Z\n`;
  const body = JSON.stringify({ origin: 'orgspirituality.org/anchors/v1', from: 999999, to: 1000099, records: Array(ENTRIES_PAGE).fill(longest) });
  assert.ok(Buffer.byteLength(body) * 2 < MAX_ANSWER_BYTES, `${Buffer.byteLength(body)} bytes`);
});
