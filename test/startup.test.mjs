import assert from 'node:assert/strict';
import { test } from 'node:test';
import { waitForStartup } from '../lib/publish.mjs';

// Review round 1, L1: the job's first request wakes the sleeping server; it
// then waits for the run that start makes (it builds and signs the day)
// before fetching the checkpoint, so that day is published the same morning.
const status = (state) => JSON.stringify({ startup: state === 'done' ? { state, finishedAt: '2026-11-15T07:18:00.000Z' } : { state } });

test('L1: waits while the start-up run is running, then goes on', async () => {
  const answers = ['running', 'running', 'done'];
  const slept = [];
  const urls = [];
  const result = await waitForStartup({
    server: 'https://api.example.org/api/v1',
    getText: async (url) => {
      urls.push(url);
      return status(answers.shift());
    },
    sleep: async (s) => slept.push(s),
  });
  assert.equal(result, 'done');
  assert.deepEqual(slept, [15, 15]);
  assert.ok(urls.every((u) => u === 'https://api.example.org/api/v1/anchors/log'));
});

test('anchoring switched off: no wait', async () => {
  const result = await waitForStartup({ server: 'https://x', getText: async () => status('off'), sleep: async () => assert.fail('no wait') });
  assert.equal(result, 'off');
});

test('a run that never finishes: gives up after a bounded wait, and says so', async () => {
  let asked = 0;
  const result = await waitForStartup({ server: 'https://x', getText: async () => { asked += 1; return status('running'); }, sleep: async () => {}, tries: 4 });
  assert.equal(result, 'timeout');
  assert.equal(asked, 4);
});

test('a server from before L1 (no startup field) or junk: no wait, said plainly', async () => {
  assert.equal(await waitForStartup({ server: 'https://x', getText: async () => '{}', sleep: async () => {} }), 'unknown');
  assert.equal(await waitForStartup({ server: 'https://x', getText: async () => '<html>', sleep: async () => {} }), 'unknown');
});
