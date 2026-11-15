// C2SP signed notes (c2sp.org/signed-note) with Ed25519, and the checkpoint
// body (c2sp.org/tlog-checkpoint). Verification only: this repository never
// holds a private key. Keys are in Go's golang.org/x/mod/sumdb/note format.
import { createHash, createPublicKey, verify } from 'node:crypto';

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
export const MAX_NOTE_BYTES = 16 * 1024;

/** Strict RFC 4648 base64: it must re-encode to the same text. */
export function canonicalBase64(text) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) return undefined;
  const bytes = Buffer.from(text, 'base64');
  return bytes.toString('base64') === text ? bytes : undefined;
}

const validName = (name) => name.length > 0 && !/[\s+]/u.test(name);

function keyIdOf(name, publicKey) {
  return createHash('sha256')
    .update(name)
    .update(Buffer.from([0x0a, 0x01]))
    .update(publicKey)
    .digest()
    .readUInt32BE(0);
}

/** Reads a verifier key `<name>+<hex id>+base64(0x01 || key)`; throws if bad. */
export function parseVerifier(text) {
  const parts = String(text).trim().split('+');
  if (parts.length < 3) throw new Error('Not a valid verifier key.');
  const [name, id] = parts;
  const bytes = canonicalBase64(parts.slice(2).join('+'));
  if (!validName(name) || !/^[0-9a-f]{8}$/.test(id) || bytes?.length !== 33 || bytes[0] !== 1) {
    throw new Error('Not a valid verifier key.');
  }
  const publicKey = bytes.subarray(1);
  const keyId = keyIdOf(name, publicKey);
  if (keyId.toString(16).padStart(8, '0') !== id) {
    throw new Error('Not a valid verifier key: its id does not match the key.');
  }
  const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, publicKey]), format: 'der', type: 'spki' });
  return { name, keyId, key };
}

/**
 * Opens a signed note with the one trusted key. Signatures by other keys are
 * ignored; a failing signature by the trusted key rejects the note; so does
 * having none. Returns { ok: true, text } or { ok: false, reason }.
 */
export function openNote(note, verifier) {
  const malformed = { ok: false, reason: 'malformed' };
  // eslint-disable-next-line no-control-regex
  if (typeof note !== 'string' || Buffer.byteLength(note) > MAX_NOTE_BYTES || !note.endsWith('\n') || /[\u0000-\u0009\u000b-\u001f]/.test(note)) {
    return malformed;
  }
  const split = note.lastIndexOf('\n\n');
  if (split < 0) return malformed;
  const text = note.slice(0, split + 1);
  const lines = note.slice(split + 2, -1).split('\n');
  if (lines.length > 32) return malformed;
  let verified = false;
  for (const line of lines) {
    const match = /^— (\S+) (\S+)$/u.exec(line);
    const bytes = match ? canonicalBase64(match[2]) : undefined;
    if (!match || !validName(match[1]) || !bytes || bytes.length < 5) return malformed;
    if (match[1] !== verifier.name || bytes.readUInt32BE(0) !== verifier.keyId) continue;
    if (!verify(null, Buffer.from(text), verifier.key, bytes.subarray(4))) {
      return { ok: false, reason: 'bad-signature' };
    }
    verified = true;
  }
  return verified ? { ok: true, text } : { ok: false, reason: 'unsigned' };
}

/** origin / size / base64 root, nothing else (no extension lines). */
export function parseCheckpoint(text) {
  const match = /^([^\n]+)\n(0|[1-9][0-9]{0,15})\n([A-Za-z0-9+/=]+)\n$/.exec(text);
  if (!match) return undefined;
  const size = Number(match[2]);
  const root = canonicalBase64(match[3]);
  if (!Number.isSafeInteger(size) || root?.length !== 32) return undefined;
  return { origin: match[1], size, root };
}
