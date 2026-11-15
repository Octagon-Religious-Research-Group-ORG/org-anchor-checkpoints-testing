// Test-only: a throwaway log signer and an RFC 6962 tree builder, so the
// tests can play the server (honest, and every way it could lie).
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ORIGIN = 'orgspirituality.org/anchors/v1';

export function newKey(name = ORIGIN) {
  const pair = generateKeyPairSync('ed25519');
  const pub = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  const id = createHash('sha256').update(name).update(Buffer.from([0x0a, 0x01])).update(pub).digest().subarray(0, 4);
  return {
    name,
    vkey: `${name}+${id.toString('hex')}+${Buffer.concat([Buffer.from([1]), pub]).toString('base64')}`,
    sign(text) {
      const sig = sign(null, Buffer.from(text), pair.privateKey);
      return `${text}\n— ${name} ${Buffer.concat([id, sig]).toString('base64')}\n`;
    },
  };
}

const leaf = (data) => createHash('sha256').update(Buffer.from([0])).update(data).digest();
const node = (l, r) => createHash('sha256').update(Buffer.from([1])).update(l).update(r).digest();
const split = (n) => {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
};
export function root(leaves) {
  if (leaves.length === 0) return createHash('sha256').digest();
  if (leaves.length === 1) return leaves[0];
  const k = split(leaves.length);
  return node(root(leaves.slice(0, k)), root(leaves.slice(k)));
}
function subproof(m, leaves, complete) {
  if (m === leaves.length) return complete ? [] : [root(leaves)];
  const k = split(leaves.length);
  return m <= k
    ? [...subproof(m, leaves.slice(0, k), complete), root(leaves.slice(k))]
    : [...subproof(m - k, leaves.slice(k), false), root(leaves.slice(0, k))];
}
export const consistency = (m, leaves) => subproof(m, leaves, true);

const hex = (text) => createHash('sha256').update(text).digest('hex');

/** One synthetic, well-formed v2 day record (hashes and counts only). */
export function record(i, salt = '') {
  const day = new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
  return [
    'org-anchor-day-v2',
    `day ${day}`,
    'tree org-anchor-merkle-v2',
    `root ${hex(`root ${i}${salt}`)}`,
    'leaves 1',
    `leafset ${hex(`set ${i}${salt}`)}`,
    `appended ${day}T04:00:00.000Z`,
    '',
  ].join('\n');
}

/** A log of `n` synthetic days: their leaf hashes, with `.records`. */
export function days(n, salt = '') {
  const records = Array.from({ length: n }, (_, i) => record(i, salt));
  const leaves = records.map((text) => leaf(Buffer.from(text)));
  leaves.records = records;
  return leaves;
}

export const leafOf = (text) => leaf(Buffer.from(text));

export const checkpoint = (key, size, leaves, origin = ORIGIN) =>
  key.sign(`${origin}\n${size}\n${root(leaves.slice(0, size)).toString('base64')}\n`);

/** A throwaway repository folder with log.json and log.vkey. */
export function repo(key, server = 'https://api.example.org/api/v1') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-'));
  fs.writeFileSync(path.join(dir, 'log.json'), JSON.stringify({ origin: ORIGIN, server }));
  fs.writeFileSync(path.join(dir, 'log.vkey'), `${key.vkey}\n`);
  return dir;
}

/**
 * A fake server: `state.note` is what /anchors/checkpoint serves, and the
 * consistency proof is computed from `state.leaves` (or `state.proof`).
 */
export function server(state) {
  const calls = [];
  const getText = async (url) => {
    calls.push(url);
    if (state.down) {
      const { CannotMeasure } = await import('../lib/publish.mjs');
      throw new CannotMeasure(`Could not read ${url} (offline).`);
    }
    if (url.endsWith('/anchors/log')) return JSON.stringify({ startup: { state: 'done' } });
    if (url.endsWith('/anchors/checkpoint')) return state.note;
    const e = /\/anchors\/entries\?from=(\d+)&to=(\d+)$/.exec(url);
    if (e) {
      if (state.entriesText !== undefined) return state.entriesText;
      const [from, to] = [Number(e[1]), Number(e[2])];
      return JSON.stringify({ origin: ORIGIN, from, to, records: (state.records ?? state.leaves.records).slice(from, to) });
    }
    const m = /from=(\d+)&to=(\d+)$/.exec(url);
    const from = Number(m[1]);
    const to = Number(m[2]);
    if (state.proofText !== undefined) return state.proofText;
    const proof = state.proof ?? consistency(from, state.leaves.slice(0, to));
    return JSON.stringify({ origin: ORIGIN, from, to, proof: proof.map((h) => h.toString('base64')) });
  };
  return { getText, calls };
}
