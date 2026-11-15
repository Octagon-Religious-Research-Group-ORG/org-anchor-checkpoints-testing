import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseDetached } from '../lib/ots.mjs';
import { main as stampAll } from '../stamp.mjs';
import { checkpoint, days, newKey, repo } from './helpers.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const json = (name) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

test('as committed (no key, no server yet), verify.mjs says it cannot measure: exit 3', () => {
  const run = spawnSync(process.execPath, [path.join(root, 'verify.mjs')], { encoding: 'utf8' });
  assert.equal(run.status, 3);
  assert.match(run.stderr, /CANNOT MEASURE/);
});

test('stamp.mjs stamps each new checkpoint once, upgrades pending ones, reports failures', async () => {
  const f = json('ots-step0.json');
  const dir = repo(newKey());
  fs.mkdirSync(path.join(dir, 'checkpoints'));
  fs.writeFileSync(path.join(dir, 'checkpoints', '3.txt'), checkpoint(newKey(), 3, days(3)));
  const answers = Object.values(f.calendars).map((b) => Buffer.from(b, 'base64'));
  let posts = 0;
  const net = {
    post: async () => ({ status: 200, body: answers[posts++ % answers.length] }),
    get: async () => ({ status: 404 }),
  };
  let report = await stampAll(dir, net);
  assert.deepEqual(report, { stamped: ['3.txt'], upgraded: [], failed: [] });
  const proof = fs.readFileSync(path.join(dir, 'checkpoints', '3.txt.ots'));
  assert.equal(parseDetached(proof).digest.length, 32);
  report = await stampAll(dir, net);
  assert.deepEqual(report, { stamped: [], upgraded: [], failed: [] });
  fs.writeFileSync(path.join(dir, 'checkpoints', '5.txt'), 'x');
  report = await stampAll(dir, { post: async () => ({ status: 503 }), get: net.get });
  assert.equal(report.failed.length, 1);
  assert.equal(fs.existsSync(path.join(dir, 'checkpoints', '5.txt.ots')), false);
  fs.writeFileSync(path.join(dir, 'checkpoints', '3.txt.ots'), 'broken');
  report = await stampAll(dir, net);
  assert.match(report.failed.join(), /3\.txt\.ots/);
});
