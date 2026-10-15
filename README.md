# OrgChain Status

Public status website: https://status.orgchain.tech/

This repository hosts OrgChain's independent GitHub Pages status website. The application VPS is not needed to serve the status page or its logo.

## Public interface

The custom static interface in `assets/` shows two monitored services, a 90-day UTC availability strip, daily details, current notices and incident history. Service details use hash URLs such as `#service=website`; the former generated site's `/history/...` routes are not used.

Days before monitoring began or after the last observation have no data, not guaranteed uptime. Partial days use the observed window; overlapping incident intervals are counted once. If an aggregate cannot establish partial-day availability, the result remains unknown. Current checks or snapshots older than 15 minutes, future timestamps and failed refreshes cannot display an all-operational summary.

The browser fetches only same-origin `status.json`, refreshing every minute. No GitHub token or per-visitor GitHub API access is required. The visible interface has no provider credit footer.

## Monitoring and publication

Upptime checks the public website (`https://orgchain.tech/`, HTTP 200 with OrgChain content) and application health endpoint (`https://orgchain.tech/up`, HTTP 200). This does not verify institutional sign-in, email delivery, database readiness or private document submissions.

The `OrgChain Status` workflow:

1. Checks availability and updates real status incidents and `history/` observations.
2. Runs snapshot regression tests and client syntax checks.
3. Uses `scripts/build-status.mjs` to produce `assets/status.json` from the monitoring history and public status/maintenance issues.
4. Publishes `assets/` directly to GitHub Pages.

Availability checks and publication are scheduled every five minutes, but GitHub scheduling can be delayed. A daily/manual/configuration-triggered response-time recording is also retained. Public issue edits trigger publication so maintenance notices and incident updates can appear without waiting for the next schedule. A failed publisher retains the prior website; the interface marks old observations as delayed rather than inventing fresh results.

The publisher uses only the configured public repository, paginates public issues, strips hidden maintenance metadata from display text, and never embeds runtime credentials. GitHub Actions uses a short-lived repository-scoped token with separate monitoring, build and deployment permissions. Do not store a broad personal access token, application credentials, private logs or student data in this repository.

## Local verification

```sh
node --test
node --check assets/status.js
node scripts/build-status.mjs
python -m http.server 4174 --bind 127.0.0.1 --directory assets
```

Open `http://127.0.0.1:4174/`. The publisher can use a privately supplied `GITHUB_TOKEN` for GitHub API limits; never put its value in a command committed here. It also accepts `--root` and `--output` for isolated verification. Generated `assets/status.json` is ignored by Git and rebuilt in Actions from real records. Never commit or deploy synthetic UI fixtures.

## Incidents and maintenance

Detected outages create `status` issues tagged with the relevant component (`website`, `application-health`); recovery closes them. Short incidents are retained. The status page links to the original public issue for its complete update thread.

For planned maintenance, create an issue labeled `maintenance` and include an HTML comment with UTC `start` and `end` ISO timestamps. Use `expectedDown` and/or `expectedDegraded` with comma-separated component slugs where appropriate. Text outside the comment is the public update. A maintenance notice alone does not count as an actual outage.

All issue titles, bodies and updates are public. Never include student records, document contents, internal addresses, credentials or raw application logs.
