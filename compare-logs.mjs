#!/usr/bin/env node
// After a key rotation: node compare-logs.mjs <old log's repository> <new log's repository>
// Exit 0: every day of the old (frozen) log is in the new one, unchanged
// but for its append time. Exit 1: a day differs or is missing, or a
// repository does not hold together. Exit 2: wrong arguments.
import { compareLogs } from './lib/rotation.mjs';

const [oldDir, newDir] = process.argv.slice(2);
if (!oldDir || !newDir) {
  console.error('Usage: node compare-logs.mjs <old repository> <new repository>');
  process.exit(2);
}
const result = compareLogs(oldDir, newDir);
if (result.ok) {
  console.log(`All ${result.days} days of the old log are in the new one, unchanged.`);
} else {
  console.error(`REFUSED: ${result.problems.join('; ')}`);
  process.exit(1);
}
