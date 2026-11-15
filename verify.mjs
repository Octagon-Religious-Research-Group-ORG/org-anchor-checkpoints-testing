#!/usr/bin/env node
// Fetches the ORG anchor log's latest signed checkpoint and keeps it only if
// it is signed by the key in log.vkey AND only appends to the checkpoint
// this repository already holds (latest.txt).
//
// Exit 0: kept a new checkpoint, or nothing new.
// Exit 1: REFUSED: bad signature, another key, a fork, the log going
//         backwards, or a rewritten log. Nothing was written.
// Exit 3: could not measure: the server did not answer, or this repository
//         is not set up yet. Nothing was written.
// Either failure fails the workflow run, and GitHub emails the owner.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseVerifier } from './lib/note.mjs';
import { CannotMeasure, publish, textGetter } from './lib/publish.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export async function main(dir = here, getText = textGetter()) {
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'log.json'), 'utf8'));
  if (!/^https:\/\/[^\s/]+\/\S*[^/]$/.test(config.server ?? '') || config.server.includes('REPLACE')) {
    throw new CannotMeasure('log.json has no server address yet (see README, "Setting it up").');
  }
  let verifier;
  try {
    verifier = parseVerifier(fs.readFileSync(path.join(dir, 'log.vkey'), 'utf8'));
  } catch {
    throw new CannotMeasure('log.vkey holds no valid public key yet (see README, "Setting it up").');
  }
  if (verifier.name !== config.origin) {
    throw new CannotMeasure(`log.vkey is for "${verifier.name}", log.json names "${config.origin}".`);
  }
  return publish({ dir, server: config.server, verifier, origin: config.origin, getText });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (result) => {
      console.log(
        result.state === 'unchanged'
          ? `Nothing new: the log still has ${result.size} entries.`
          : `Kept checkpoint ${result.size} (${result.state === 'first' ? 'the first one' : 'consistent with the last'}).`,
      );
    },
    (error) => {
      console.error(`${error.code === 1 ? 'REFUSED' : 'CANNOT MEASURE'}: ${error.message}`);
      process.exit(error.code === 1 ? 1 : 3);
    },
  );
}
