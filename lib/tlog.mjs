// RFC 9162 §2.1.4.2 consistency proof verification over RFC 6962 hashes:
// does the tree of size2 (root2) only append to the tree of size1 (root1)?
// Edge cases follow Google's Go library (transparency-dev/merkle).
import { createHash } from 'node:crypto';

export function nodeHash(left, right) {
  return createHash('sha256').update(Buffer.from([1])).update(left).update(right).digest();
}

const isHash = (b) => Buffer.isBuffer(b) && b.length === 32;
const isSize = (n) => Number.isSafeInteger(n) && n >= 0;

export function verifyConsistency(size1, size2, root1, root2, proof) {
  if (!isSize(size1) || !isSize(size2) || size2 < size1 || size1 === 0) return false;
  if (size1 === size2) return proof.length === 0 && root1.equals(root2);
  if (!isHash(root1) || !isHash(root2) || !proof.every(isHash) || proof.length === 0) return false;
  const s1 = BigInt(size1);
  const path = (s1 & (s1 - 1n)) === 0n ? [root1, ...proof] : [...proof];
  let fn = s1 - 1n;
  let sn = BigInt(size2 - 1);
  while ((fn & 1n) === 1n) {
    fn >>= 1n;
    sn >>= 1n;
  }
  let fr = path[0];
  let sr = path[0];
  for (const c of path.slice(1)) {
    if (sn === 0n) return false;
    if ((fn & 1n) === 1n || fn === sn) {
      fr = nodeHash(c, fr);
      sr = nodeHash(c, sr);
      while ((fn & 1n) === 0n && fn !== 0n) {
        fn >>= 1n;
        sn >>= 1n;
      }
    } else {
      sr = nodeHash(sr, c);
    }
    fn >>= 1n;
    sn >>= 1n;
  }
  return fr.equals(root1) && sr.equals(root2) && sn === 0n;
}
