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

1. it is signed with the ORG's public key in [`log.vkey`](log.vkey), and
2. it is the previous checkpoint plus new days, nothing else: the website
   must prove that mathematically (a "consistency proof") before anything is
   kept.

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
means; the log holds only fingerprints and counts, never text or names. And
days added since the last checkpoint here (normally under a day) are not yet
protected by it.

## Files

| File | What it is |
|---|---|
| `latest.txt` | the newest kept checkpoint |
| `checkpoints/<size>.txt` | every kept checkpoint, by the number of days it covers |
| `checkpoints/<size>.txt.ots` | its OpenTimestamps proof |
| `log.vkey` | the ORG anchor log's public key |
| `log.json` | the log's name and the website's address |
| `verify.mjs`, `stamp.mjs`, `lib/` | the checks and the stamping, plain Node.js, no dependencies |
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
  against the one before it. `git log -p latest.txt` shows them in order.
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
2. `node verify.mjs`: fetch, check, keep. It retries for about two and a half
   minutes, because the website's free server sleeps and takes about a minute
   to wake.
3. `node stamp.mjs`: stamp new checkpoints, upgrade pending stamps.
4. Commit and push what was kept.

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
   `https://raw.githubusercontent.com/<org>/org-anchor-checkpoints/main/latest.txt`).
5. Run the workflow once by hand (Actions, "Run workflow") and check it kept
   a first checkpoint.

Until then `node verify.mjs` answers "cannot measure" (exit 3) and keeps
nothing.
