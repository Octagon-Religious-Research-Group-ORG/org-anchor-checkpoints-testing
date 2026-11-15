// One publication: fetch the log's latest signed checkpoint, check it
// against the one this repository already holds, and only then keep it.
import fs from 'node:fs';
import path from 'node:path';
import { canonicalBase64, openNote, parseCheckpoint } from './note.mjs';
import { verifyConsistency } from './tlog.mjs';
import { entryName, isDayRecord, leafHashOf, readEntries, repeatedDays, treeRoot } from './records.mjs';
import { checkPrevious } from './rotation.mjs';

/** exit 1: the log is not consistent (refused). exit 3: could not measure. */
/** Largest answer read (bytes): far above a checkpoint or a proof. */
export const MAX_ANSWER_BYTES = 64 * 1024;
/**
 * Entries asked for per request (review round 2, M3). A record is at most
 * about 280 bytes as JSON, so a page of 100 is under 30 KB: half the cap,
 * with room to spare. The server gives at most this many too.
 */
export const ENTRIES_PAGE = 100;

export class Refused extends Error {
  code = 1;
}
export class CannotMeasure extends Error {
  code = 3;
}

function opened(note, verifier, what) {
  const result = openNote(note, verifier);
  if (!result.ok) {
    throw new Refused(
      result.reason === 'bad-signature'
        ? `${what}: its signature by the log key does not verify.`
        : result.reason === 'unsigned'
          ? `${what}: it is not signed by the log key in log.vkey.`
          : `${what}: it is not a signed note.`,
    );
  }
  return result.text;
}

function checkpointOf(note, verifier, origin, what) {
  const body = parseCheckpoint(opened(note, verifier, what));
  if (!body) throw new Refused(`${what}: not a checkpoint.`);
  if (body.origin !== origin) throw new Refused(`${what}: it is for "${body.origin}", not "${origin}".`);
  return body;
}

/**
 * @param o.dir         the repository (holds latest.txt and checkpoints/)
 * @param o.server      the log's API base, e.g. https://host/api/v1
 * @param o.verifier    the parsed log.vkey
 * @param o.origin      the log's origin
 * @param o.getText     (url) => Promise<string>: throws CannotMeasure when unreachable
 * @param o.previous    for a rotated log: the frozen previous log, pinned (M4)
 * @returns { state: 'new' | 'unchanged' | 'first', size, file? }
 */
export async function publish(o) {
  const latestFile = path.join(o.dir, 'latest.txt');
  const note = await o.getText(`${o.server}/anchors/checkpoint`);
  const next = checkpointOf(note, o.verifier, o.origin, 'The fetched checkpoint');
  const previous = fs.existsSync(latestFile)
    ? checkpointOf(fs.readFileSync(latestFile, 'utf8'), o.verifier, o.origin, 'The committed latest.txt')
    : undefined;
  if (previous) {
    if (next.size < previous.size) {
      throw new Refused(`The log went BACKWARDS: ${previous.size} entries were published, the server now signs ${next.size}.`);
    }
    if (next.size === previous.size) {
      if (!next.root.equals(previous.root)) {
        throw new Refused(`FORK: two different signed trees of size ${next.size}.`);
      }
      return { state: 'unchanged', size: next.size };
    }
    const raw = await o.getText(`${o.server}/anchors/proof/consistency?from=${previous.size}&to=${next.size}`);
    let answer;
    try {
      answer = JSON.parse(raw);
    } catch {
      throw new CannotMeasure('The consistency proof answer is not JSON.');
    }
    const proof = Array.isArray(answer?.proof) ? answer.proof.map((h) => canonicalBase64(String(h))) : undefined;
    if (
      !proof ||
      proof.some((h) => !h) ||
      answer.from !== previous.size ||
      answer.to !== next.size ||
      !verifyConsistency(previous.size, next.size, previous.root, next.root, proof)
    ) {
      throw new Refused(
        `The new checkpoint (size ${next.size}) is NOT consistent with the published one (size ${previous.size}): the log was rewritten.`,
      );
    }
  } else if (next.size === 0) {
    return { state: 'unchanged', size: 0 };
  }
  // The entries (review round 1, M2a): the ones kept here must still give
  // the kept checkpoint, and the new range must complete the new one.
  const kept = readEntries(o.dir);
  const keptSize = previous?.size ?? 0;
  if (!kept || kept.length !== keptSize || !treeRoot(kept.map(leafHashOf)).equals(previous?.root ?? treeRoot([]))) {
    throw new Refused(`The repository's entries/ no longer give latest.txt (size ${keptSize}): they were edited, removed or added by hand.`);
  }
  const fresh = [];
  for (let from = keptSize; from < next.size; from += ENTRIES_PAGE) {
    const to = Math.min(next.size, from + ENTRIES_PAGE);
    let answer;
    try {
      answer = JSON.parse(await o.getText(`${o.server}/anchors/entries?from=${from}&to=${to}`));
    } catch (error) {
      if (error instanceof Refused || error instanceof CannotMeasure) throw error;
      throw new CannotMeasure('The entries answer is not JSON.');
    }
    if (answer?.from !== from || answer?.to !== to || !Array.isArray(answer.records) || answer.records.length !== to - from) {
      throw new Refused(`The server's entries answer for ${from}..${to} does not fit.`);
    }
    for (const [i, text] of answer.records.entries()) {
      if (!isDayRecord(text)) throw new Refused(`Entry ${from + i} from the server is not a day record; nothing is kept.`);
      fresh.push(text);
    }
  }
  // Each day once, in every log (review round 3, L2).
  const twice = repeatedDays([...kept, ...fresh]);
  if (twice.length > 0) {
    throw new Refused(`The log holds ${twice.slice(0, 5).join(', ')} twice; each day is appended once, so nothing is kept.`);
  }
  if (!treeRoot([...kept, ...fresh].map(leafHashOf)).equals(next.root)) {
    throw new Refused(`The entries the server gave do not give the signed root of size ${next.size}; nothing is kept.`);
  }
  // A rotated log: every day of the frozen previous log, unchanged (M4).
  if (o.previous) {
    const problems = checkPrevious(o.dir, o.previous, [...kept, ...fresh]);
    if (problems.length > 0) {
      throw new Refused(`This log does not keep the previous log it replaces: ${problems.slice(0, 5).join('; ')}.`);
    }
  }
  const dir = path.join(o.dir, 'checkpoints');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${next.size}.txt`);
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') !== note) {
    throw new Refused(`checkpoints/${next.size}.txt already holds a different checkpoint.`);
  }
  fs.mkdirSync(path.join(o.dir, 'entries'), { recursive: true });
  fresh.forEach((text, i) => fs.writeFileSync(path.join(o.dir, 'entries', entryName(keptSize + i)), text));
  fs.writeFileSync(file, note);
  fs.writeFileSync(latestFile, note);
  return { state: previous ? 'new' : 'first', size: next.size, file };
}

/**
 * GET with retries long enough for a sleeping free instance to wake (about a
 * minute on Render's free tier): `tries` attempts, `waits` between them.
 */
export function textGetter({ fetchImpl = fetch, tries = 8, waits = [5, 10, 15, 20, 30, 30, 30], timeoutMs = 30_000, sleep } = {}) {
  const pause = sleep ?? ((s) => new Promise((resolve) => setTimeout(resolve, s * 1000)));
  return async (url) => {
    let last = 'no answer';
    for (let attempt = 1; attempt <= tries; attempt++) {
      try {
        const response = await fetchImpl(url, {
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
          headers: { 'User-Agent': 'org-anchor-checkpoints' },
        });
        const body = await response.text();
        if (Buffer.byteLength(body) > MAX_ANSWER_BYTES) throw new Error('answer too large');
        if (response.status === 200) return body;
        // 409: the server says its own copy of the log does not hold together.
        if (response.status === 409) {
          throw new Refused(`The server reports its copy of the anchor log is inconsistent (HTTP 409 from ${url}): ${body.slice(0, 300)}`);
        }
        last = `HTTP ${response.status}${body ? `: ${body.slice(0, 300)}` : ''}`;
        // A 4xx will not change by asking again.
        if (response.status >= 400 && response.status < 500 && response.status !== 429) break;
      } catch (error) {
        if (error instanceof Refused) throw error;
        last = error.message;
      }
      if (attempt < tries) await pause(waits[Math.min(attempt - 1, waits.length - 1)]);
    }
    throw new CannotMeasure(`Could not read ${url} (${last}).`);
  };
}

/**
 * Waits for the run the server makes when it starts (it builds the day and
 * signs a checkpoint), polling GET /anchors/log every 15 s, at most `tries`
 * times (4 minutes by default). The first request is also what wakes a
 * sleeping server. Returns 'done', 'off' (anchoring switched off),
 * 'timeout' (gave up: the checkpoint fetched may be from before that run),
 * or 'unknown' (the server does not say).
 */
export async function waitForStartup({ server, getText, sleep, tries = 16 }) {
  const pause = sleep ?? ((s) => new Promise((resolve) => setTimeout(resolve, s * 1000)));
  for (let attempt = 1; attempt <= tries; attempt++) {
    let state;
    try {
      state = JSON.parse(await getText(`${server}/anchors/log`))?.startup?.state;
    } catch (error) {
      if (error instanceof Refused || error instanceof CannotMeasure) throw error;
      return 'unknown';
    }
    if (state === 'done' || state === 'off') return state;
    if (state !== 'running' && state !== 'not-started') return 'unknown';
    if (attempt < tries) await pause(15);
  }
  return 'timeout';
}
