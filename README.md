# OrgChain Status

Public status website: https://status.orgchain.tech/

This repository hosts OrgChain's independent GitHub Pages status website. The application VPS is not needed to serve the status page or its logo.

## Public interface

The custom static interface in `assets/` shows eight monitored services, a 90-day UTC availability strip, daily details, current notices and incident history. Service details use hash URLs such as `#service=website`; the former generated site's `/history/...` routes are not used.

Days before monitoring began or after the last observation have no data, not guaranteed uptime. Partial days use the observed window; overlapping incident intervals are counted once. If an aggregate cannot establish partial-day availability, the result remains unknown. Current checks or snapshots older than 15 minutes, future timestamps and failed refreshes cannot display an all-operational summary.

The browser fetches only same-origin `status.json`, refreshing every minute. No GitHub token or per-visitor GitHub API access is required. The visible interface has no provider credit footer.

## Monitoring and publication

Upptime checks the public website and `/up`, plus six allowlisted cached readiness endpoints under `/health/services/`: `database`, `blockchain`, `private-storage`, `document-processing`, `institutional-sign-in` and `mail-provider`. Application services test configured database connectivity. Blockchain checks require recent blocks, the correct network and deployed contract with sufficient validator health. Storage and document processing use isolated synthetic artifacts. Google measures configured gateway/provider availability; SMTP measures verified encrypted connectivity/authentication without sending a message. These are readiness signals, not completed student sign-in, delivered email or successful private submissions/transactions.

The `OrgChain Status` workflow:

1. Checks availability and updates real status incidents and `history/` observations.
2. Runs snapshot regression tests and client syntax checks.
3. Uses `scripts/build-status.mjs` to produce `assets/status.json` from monitoring history, public status/maintenance issues and the credential-free aggregate `/health/services` snapshot.
4. Publishes `assets/` directly to GitHub Pages.

Availability checks and publication are scheduled every five minutes, but GitHub scheduling can be delayed. A daily/manual/configuration-triggered response-time recording is also retained. Public issue edits trigger publication so maintenance notices and incident updates can appear without waiting for the next schedule. A failed publisher retains the prior website; the interface marks old observations as delayed rather than inventing fresh results.

The publisher uses only the configured public repository, paginates public issues, strips hidden maintenance metadata from display text, and never embeds runtime credentials. GitHub Actions uses a short-lived repository-scoped token with separate monitoring, build and deployment permissions. Do not store a broad personal access token, application credentials, private logs or student data in this repository.

The application runs its private timer every five minutes and publishes only component status, `checkedAt` and `startedAt`; public requests never launch expensive probes. The publisher uses those actual timestamps, not a successful endpoint poll, for private current states. Missing, unreachable, stale, future or malformed private observations become unknown, without hiding an independently measured Website outage. Today's availability cannot be green when its private observation is unknown. Past readiness-signal failures are retained but are not diagnoses of an internal cause. No RPC addresses, credentials, node topology, student records, files or diagnostics enter the public snapshot.

Upptime's curl transport includes HTTP response headers in the string evaluated by body checks. The readiness rules therefore accept HTTP header blocks followed by exactly the allowlisted JSON object, while still requiring HTTP 200 and operational/degraded state. HTML login/error pages and unknown/null observations cannot satisfy the guard. Verify transport changes against an actual `curl --include` response, not just a parsed JSON body.

## Local verification

```sh
node --test
node --check assets/status.js
node scripts/build-status.mjs
python -m http.server 4174 --bind 127.0.0.1 --directory assets
```

Open `http://127.0.0.1:4174/`. The publisher can use a privately supplied `GITHUB_TOKEN` for GitHub API limits; never put its value in a command committed here. It also accepts `--root` and `--output` for isolated verification. Generated `assets/status.json` is ignored by Git and rebuilt in Actions from real records. Never commit or deploy synthetic UI fixtures.

## Incidents and maintenance

Detected outages create `status` issues tagged with the relevant component slug from `.upptimerc.yml`; recovery closes them. Short incidents are retained. The status page links to the original public issue for its complete update thread.

For planned maintenance, create an issue labeled `maintenance` and include an HTML comment with UTC `start` and `end` ISO timestamps. Use `expectedDown` and/or `expectedDegraded` with comma-separated component slugs where appropriate. Text outside the comment is the public update. A maintenance notice alone does not count as an actual outage.

All issue titles, bodies and updates are public. Never include student records, document contents, internal addresses, credentials or raw application logs.
