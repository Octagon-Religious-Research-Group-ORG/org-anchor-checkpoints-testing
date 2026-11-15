// OpenTimestamps: the detached .ots format and the calendar protocol, as the
// reference implementation (python-opentimestamps) defines them. A port of
// the ORG backend's own code (src/anchoring/ots.ts), which was checked
// byte-for-byte against the reference client; written here rather than
// taken from npm because the JavaScript library is LGPL-3.0. No dependency.
//
// Only a SHA-256 digest is ever sent to a calendar.
import { createHash } from 'node:crypto';

const MAGIC = Buffer.from('004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294', 'hex');
const TAG_PENDING = '83dfe30d2ef90c8e';
const TAG_BITCOIN = '0588960d73d71901';
const SHA256 = 0x08;
const APPEND = 0xf0;
const PREPEND = 0xf1;
const MAX_MSG = 4096;
const MAX_DEPTH = 256;

/** The four public calendars the reference client submits to. */
export const CALENDARS = [
  'https://a.pool.opentimestamps.org',
  'https://b.pool.opentimestamps.org',
  'https://a.pool.eternitywall.com',
  'https://ots.btc.catallaxy.com',
];
/** Where an upgrade may be fetched: the reference client's whitelist. */
const UPGRADE_SUFFIXES = ['.calendar.opentimestamps.org', '.calendar.eternitywall.com', '.calendar.catallaxy.com'];

export class OtsFormatError extends Error {}

function apply(op, msg) {
  if (op.op === SHA256) return createHash('sha256').update(msg).digest();
  const out = op.op === APPEND ? Buffer.concat([msg, op.arg]) : Buffer.concat([op.arg, msg]);
  if (out.length > MAX_MSG) throw new OtsFormatError('message too long');
  return out;
}

class Reader {
  constructor(buf) {
    this.buf = buf;
    this.at = 0;
  }
  byte() {
    if (this.at >= this.buf.length) throw new OtsFormatError('truncated');
    return this.buf[this.at++];
  }
  bytes(n) {
    if (this.at + n > this.buf.length) throw new OtsFormatError('truncated');
    const out = Buffer.from(this.buf.subarray(this.at, this.at + n));
    this.at += n;
    return out;
  }
  varuint() {
    let value = 0;
    for (let shift = 0; shift <= 49; shift += 7) {
      const b = this.byte();
      value += (b & 0x7f) * 2 ** shift;
      if (value > Number.MAX_SAFE_INTEGER) throw new OtsFormatError('varuint too large');
      if (!(b & 0x80)) return value;
    }
    throw new OtsFormatError('varuint too long');
  }
  varbytes(max = MAX_MSG) {
    const n = this.varuint();
    if (n > max) throw new OtsFormatError('field too long');
    return this.bytes(n);
  }
}

function readAttestation(r) {
  const tag = r.bytes(8).toString('hex');
  const payload = r.varbytes(8192);
  const p = new Reader(payload);
  if (tag === TAG_PENDING) {
    const uri = p.varbytes(1000).toString('utf8');
    if (!/^[\x21-\x7e]+$/.test(uri)) throw new OtsFormatError('bad calendar URI');
    return { kind: 'pending', uri };
  }
  if (tag === TAG_BITCOIN) return { kind: 'bitcoin', height: p.varuint() };
  return { kind: 'unknown', tag, payload };
}

function readNode(r, msg, depth) {
  if (depth > MAX_DEPTH) throw new OtsFormatError('proof too deep');
  const node = { msg, attestations: [], ops: [] };
  for (;;) {
    let tag = r.byte();
    const fork = tag === 0xff;
    if (fork) tag = r.byte();
    if (tag === 0x00) node.attestations.push(readAttestation(r));
    else if (tag === SHA256 || tag === APPEND || tag === PREPEND) {
      const op = tag === SHA256 ? { op: tag } : { op: tag, arg: r.varbytes() };
      node.ops.push({ op, child: readNode(r, apply(op, msg), depth + 1) });
    } else throw new OtsFormatError(`unsupported operation 0x${tag.toString(16)}`);
    if (!fork) return node;
  }
}

function whole(r, msg) {
  const node = readNode(r, msg, 0);
  if (r.at !== r.buf.length) throw new OtsFormatError('trailing bytes');
  return node;
}

/** A serialized timestamp (a calendar's answer) for `msg`. */
export const parseTimestamp = (bytes, msg) => whole(new Reader(bytes), msg);

function varuint(n) {
  const out = [];
  let rest = n;
  do {
    const b = rest % 128;
    rest = Math.floor(rest / 128);
    out.push(rest > 0 ? b | 0x80 : b);
  } while (rest > 0);
  return Buffer.from(out);
}
const varbytes = (b) => Buffer.concat([varuint(b.length), b]);

function writeAttestation(a) {
  const [tag, payload] =
    a.kind === 'pending'
      ? [TAG_PENDING, varbytes(Buffer.from(a.uri, 'utf8'))]
      : a.kind === 'bitcoin'
        ? [TAG_BITCOIN, varuint(a.height)]
        : [a.tag, a.payload];
  return Buffer.concat([Buffer.from([0]), Buffer.from(tag, 'hex'), varbytes(payload)]);
}

export function serializeTimestamp(node) {
  const items = [
    ...node.attestations.map(writeAttestation),
    ...node.ops.map(({ op, child }) =>
      Buffer.concat([Buffer.from([op.op]), op.arg ? varbytes(op.arg) : Buffer.alloc(0), serializeTimestamp(child)]),
    ),
  ];
  if (items.length === 0) throw new OtsFormatError('empty timestamp');
  return Buffer.concat(items.map((item, i) => (i < items.length - 1 ? Buffer.concat([Buffer.from([0xff]), item]) : item)));
}

export const serializeDetached = (digest, tree) =>
  Buffer.concat([MAGIC, varuint(1), Buffer.from([SHA256]), digest, serializeTimestamp(tree)]);

export function parseDetached(file) {
  const r = new Reader(file);
  if (!r.bytes(MAGIC.length).equals(MAGIC)) throw new OtsFormatError('not an OpenTimestamps proof');
  if (r.varuint() !== 1) throw new OtsFormatError('unknown proof version');
  if (r.byte() !== SHA256) throw new OtsFormatError('not a SHA-256 proof');
  const digest = r.bytes(32);
  return { digest, tree: whole(r, digest) };
}

function attestationsOf(node) {
  return [...node.attestations.map((attestation) => ({ attestation, node })), ...node.ops.flatMap(({ child }) => attestationsOf(child))];
}

/** Pending calendars (with the commitment to ask about) and Bitcoin heights. */
export function summarize(tree) {
  const out = { pending: [], bitcoin: [] };
  for (const { attestation, node } of attestationsOf(tree)) {
    if (attestation.kind === 'pending') out.pending.push({ uri: attestation.uri, commitment: node.msg.toString('hex'), node });
    if (attestation.kind === 'bitcoin') out.bitcoin.push(attestation.height);
  }
  return out;
}

export function isUpgradeUriAllowed(uri) {
  let u;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  return u.protocol === 'https:' && !u.username && !u.password && !u.port && UPGRADE_SUFFIXES.some((s) => u.hostname.endsWith(s));
}

const HEADERS = { Accept: 'application/vnd.opentimestamps.v1', 'User-Agent': 'org-anchor-checkpoints' };

/**
 * A new detached proof for `digest` from every calendar that answers.
 * `post(url, body, headers)` resolves { status, body }. Throws when none does.
 */
export async function stamp(digest, post, calendars = CALENDARS) {
  const tree = { msg: digest, attestations: [], ops: [] };
  const errors = [];
  for (const url of calendars) {
    try {
      const answer = await post(`${url}/digest`, digest, { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' });
      if (answer.status !== 200) throw new Error(`HTTP ${answer.status}`);
      const part = parseTimestamp(answer.body, digest);
      tree.attestations.push(...part.attestations);
      tree.ops.push(...part.ops);
    } catch (error) {
      errors.push(`${url}: ${error.message}`);
    }
  }
  if (tree.attestations.length + tree.ops.length === 0) {
    throw new Error(`no calendar accepted the digest (${errors.join('; ')})`);
  }
  return { proof: serializeDetached(digest, tree), errors };
}

/**
 * Asks each pending calendar for its Bitcoin part and grafts it in. Refuses
 * a calendar off the whitelist and an answer with no Bitcoin attestation.
 * `get(url, headers)` resolves { status, body }. Returns the new proof bytes,
 * and whether it now reaches Bitcoin.
 */
export async function upgrade(file, get) {
  const { digest, tree } = parseDetached(file);
  if (summarize(tree).bitcoin.length > 0) return { proof: file, confirmed: true, changed: false };
  let changed = false;
  for (const { uri, commitment, node } of summarize(tree).pending) {
    if (!isUpgradeUriAllowed(uri)) continue;
    try {
      const answer = await get(`${uri.replace(/\/+$/, '')}/timestamp/${commitment}`, HEADERS);
      if (answer.status !== 200) continue;
      const part = parseTimestamp(answer.body, Buffer.from(commitment, 'hex'));
      if (summarize(part).bitcoin.length === 0) continue;
      node.attestations.push(...part.attestations);
      node.ops.push(...part.ops);
      changed = true;
      break;
    } catch {
      // One calendar down or answering badly stops only itself.
    }
  }
  const proof = changed ? serializeDetached(digest, tree) : file;
  if (changed) parseDetached(proof);
  return { proof, confirmed: summarize(parseDetached(proof).tree).bitcoin.length > 0, changed };
}
