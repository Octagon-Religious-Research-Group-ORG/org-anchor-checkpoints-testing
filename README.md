# ORG anchor checkpoints

This repository is a public, independent copy of the **ORG anchor log**: the
record that lets anyone check, years from now, that what members wrote on the
ORG website was not changed afterwards, and when it existed.

## What it proves, in plain words

Every day the ORG website seals that day's new writing (beliefs, comments,
their edits) into one fingerprint, and has that fingerprint time-stamped by
two outside services (FreeTSA and the Bitcoin blockchain, through
OpenTimestamps). Since 2026-11, every sealed day is also added to one
running list, the **anchor log**, which can only grow: a day can be added,
never changed or removed.

Once a day, this repository asks the website for the newest summary of that
list (a **checkpoint**: how many days it holds and one fingerprint of all of
them, signed with the ORG's key) and keeps it **only if**:

1. it is signed with the ORG's public key in [`log.vkey`](log.vkey),
2. it is the previous checkpoint plus new days, nothing else: the website
   must prove that mathematically (a "consistency proof") before anything is
   kept, and
3. the new days' records themselves, fetched and kept in `entries/`, give
   exactly the signed fingerprint, together with every record already kept
   here. A record must be a day record (hashes, counts and a time) or
   nothing is kept: no other text can ever reach this repository. Each day
   may appear only once in the whole log; a day held twice is refused.

If either check fails, nothing is kept, the run fails, and GitHub emails the
repository owner. Every kept checkpoint is also time-stamped in Bitcoin
(`checkpoints/<size>.txt.ots`), so the date it was kept here does not rest
on this repository or on GitHub either.

**Why that matters.** The website's own database cannot be the only record of
itself: someone with full access to it could quietly replace a day.
This repository is out of their reach, so once a day is in a checkpoint
kept here, replacing it on the website no longer goes unnoticed. The
website's own checks compare against this copy every time, and anyone can
too.

**What it does not prove.** It says nothing about who wrote what or what it
means; the log holds only fingerprints and counts, never text or names. It
proves the order in which days were added and when each was added, not that
a day's activity happened on the date in its name. And days added since the
last checkpoint here are not yet protected by it: usually a few hours, at
most about a day.

## Files

| File | What it is |
|---|---|
| `latest.txt` | the newest kept checkpoint |
| `entries/<index>.txt` | every day record of the log, in order: with these the log can be rebuilt and audited from this repository alone |
| `checkpoints/<size>.txt` | every kept checkpoint, by the number of days it covers |
| `checkpoints/<size>.txt.ots` | its OpenTimestamps proof |
| `log.vkey` | the ORG anchor log's public key |
| `log.json` | the log's name and the website's address |
| `verify.mjs`, `stamp.mjs`, `lib/` | the checks and the stamping, plain Node.js, no dependencies |
| `compare-logs.mjs` | after a key rotation: proves the new log kept every day of the old one |
| `previous/` | only in a rotated log's repository: the frozen previous log, which every publication must keep |
| `test/` | tests of the checks, including every way a dishonest server could lie |

A checkpoint is three lines and a signature (the [C2SP checkpoint format](https://c2sp.org/tlog-checkpoint)):

```
orgspirituality.org/anchors/v1        the log's name
42                                    how many days it covers
<base64 fingerprint of all 42>

— orgspirituality.org/anchors/v1 <signature>
```

## Check it yourself

Anyone can, with free tools and without trusting the ORG or this repository:

- **The checks:** install Node.js 22 or later, clone this repository, and run
  `node --test` (the checks' own tests) and `node verify.mjs` (fetches the
  website's newest checkpoint and checks it against `latest.txt` exactly as
  the daily job does). Exit 0: consistent. Exit 1: refused, with the reason.
  Exit 3: could not check (the website did not answer).
- **The whole history:** every commit here is a checkpoint that was checked
  against the one before it. `git log -p latest.txt` shows them in order,
  and the files in `entries/` rebuild the newest one: hash each as
  SHA-256(0x00 ‖ file bytes) and build the RFC 6962 tree over them in order;
  the root must be the third line of `latest.txt` (base64).
- **The Bitcoin time:** with the reference OpenTimestamps client
  (`pip install opentimestamps-client`), `ots verify checkpoints/<size>.txt.ots`.
  A new proof is "pending" for a few hours until Bitcoin confirms it; later
  runs here upgrade it. Without a Bitcoin node: `ots info` shows the block
  height, which any block explorer can confirm.
- **One day's place in the log:** a receipt downloaded from the website
  carries the day's record and its proof against a checkpoint; that
  checkpoint (or a later one consistent with it) must be here.

The log's design follows Certificate Transparency
([RFC 9162](https://www.rfc-editor.org/rfc/rfc9162)) and the C2SP
specifications ([signed-note](https://c2sp.org/signed-note),
[tlog-checkpoint](https://c2sp.org/tlog-checkpoint)); any tool for those
formats can check these files.

## How it runs

`.github/workflows/publish.yml`, daily at 07:17 UTC and on demand:

1. `node --test`: the checks test themselves first.
2. `node verify.mjs`: wake the website (its free server sleeps and takes
   about a minute to start; requests are retried for about two and a half
   minutes), wait up to 4 minutes for the run the server makes when it
   starts (that run builds the day and signs it, so the day is kept this
   morning instead of tomorrow), then fetch, check and keep. A server that
   reports its own copy of the log broken (HTTP 409) is REFUSED, like any
   other inconsistency.
3. `node stamp.mjs`: stamp new checkpoints, upgrade pending stamps.
4. Commit and push what was kept (`latest.txt`, `checkpoints/`, `entries/`).

## Recovery and key rotation

- **The website lost its copy of the log** (for example its database was
  restored from an older backup): the ORG backend's
  `npm run anchor-log:restore` rebuilds it from a clone of this repository,
  after checking that `entries/` reproduce the signed `latest.txt`.
- **A new key** starts a new log (`orgspirituality.org/anchors/v2`) in a new
  repository; this one is frozen (its workflow switched off) and stays as
  the record of every day it holds. The new repository keeps a copy of this
  one's final `latest.txt` and `entries/` in `previous/`, pinned in its
  `log.json` (`previous`: origin, key, size, root), and REFUSES every
  publication unless every day here is in the new log unchanged (only its
  append time is new), and neither log holds a day twice. `node compare-logs.mjs <this repository> <the new
  one>` checks the same by hand. The ORG backend's README, "Key rotation",
  has every step.

It uses no secret (only GitHub's own token, with permission to write to this
repository), and the website holds no credential for it.

**Email on failure.** GitHub sends scheduled-workflow notifications to the
person who created the workflow file (GitHub docs: "Notifications for
scheduled workflows are sent to the user who initially created the
workflow"), so the owner must add the workflow file himself and keep email
notifications for failed Actions runs switched on in his GitHub settings.

**The 60-day rule.** GitHub switches scheduled workflows off "when no
repository activity has occurred in 60 days" in a public repository. A new
checkpoint is committed whenever the website sealed a new day, which should
count as activity; if the website is quiet for two months, the owner must
switch the workflow back on (Actions tab). Not yet verified on the live
repository.

## Setting it up (the owner, once)

1. On your own machine, in the ORG backend repository:
   `node scripts/anchor-log-keygen.mjs <a new file>`. It writes the private
   key to that file and prints only the public key.
2. Put the public key in `log.vkey` (one line), and the website's API address
   in `log.json` (`"server": "https://<api host>/api/v1"`).
3. Create this repository, public, in the ORG's GitHub organisation, with
   these files, and add `.github/workflows/publish.yml` yourself.
4. On the server: `ANCHOR_LOG_SIGNING_KEY` (the private key file's line),
   `ANCHOR_LOG_VERIFIER_KEY` (the public key) and `ANCHOR_LOG_PUBLISHED_URL`
   (the raw address of `latest.txt` here, e.g.
   `https://raw.githubusercontent.com/<org>/org-anchor-checkpoints/main/latest.txt`),
   and `ANCHOR_LOG_BOOTSTRAP=1` for the first publication only: until a
   checkpoint exists here, the address answers 404, and the server signs
   the first checkpoint only while that flag says the 404 is expected.
5. Run the workflow once by hand (Actions, "Run workflow") and check it kept
   a first checkpoint.
6. Remove `ANCHOR_LOG_BOOTSTRAP` from the server. While it is set and a
   checkpoint is published here, the server signs nothing (on purpose: a
   404 later on must never again mean "nothing published").

Until then `node verify.mjs` answers "cannot measure" (exit 3) and keeps
nothing.
