#!/usr/bin/env node
// OpenTimestamps for the kept checkpoints: a new proof next to every
// checkpoints/<size>.txt that has none, and an upgrade of every pending
// proof whose calendar now has its Bitcoin part. Only file hashes are sent.
//
// Exit 0 when every checkpoint has a proof (pending ones are normal: Bitcoin
// takes hours). Exit 3 when a checkpoint could not be stamped at all; the
// next run tries again. Anyone can check a proof with the reference client:
// `ots verify checkpoints/<size>.txt.ots`.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stamp, upgrade } from './lib/ots.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

async function request(url, init) {
  const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(20_000) });
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > 64 * 1024) throw new Error('answer too large');
  return { status: response.status, body };
}

export const http = {
  post: (url, body, headers) => request(url, { method: 'POST', body, headers }),
  get: (url, headers) => request(url, { method: 'GET', headers }),
};

export async function main(dir = here, net = http) {
  const folder = path.join(dir, 'checkpoints');
  const files = fs.existsSync(folder) ? fs.readdirSync(folder).filter((f) => /^\d+\.txt$/.test(f)) : [];
  const report = { stamped: [], upgraded: [], failed: [] };
  for (const name of files.sort((a, b) => Number(a.slice(0, -4)) - Number(b.slice(0, -4)))) {
    const file = path.join(folder, name);
    const proofFile = `${file}.ots`;
    if (!fs.existsSync(proofFile)) {
      const digest = createHash('sha256').update(fs.readFileSync(file)).digest();
      try {
        const { proof } = await stamp(digest, net.post);
        fs.writeFileSync(proofFile, proof);
        report.stamped.push(name);
      } catch (error) {
        report.failed.push(`${name}: ${error.message}`);
      }
      continue;
    }
    try {
      const { proof, changed } = await upgrade(fs.readFileSync(proofFile), net.get);
      if (changed) {
        fs.writeFileSync(proofFile, proof);
        report.upgraded.push(name);
      }
    } catch (error) {
      // A proof that cannot be read is left as it is, and said.
      report.failed.push(`${name}.ots: ${error.message}`);
    }
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((report) => {
    console.log(`Stamped: ${report.stamped.join(', ') || 'none'}. Upgraded to Bitcoin: ${report.upgraded.join(', ') || 'none'}.`);
    if (report.failed.length > 0) {
      console.error(`CANNOT STAMP: ${report.failed.join('; ')}`);
      process.exit(3);
    }
  });
}
