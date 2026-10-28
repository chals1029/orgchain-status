import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const REPOSITORY = "chals1029/orgchain-status";
const API = `https://api.github.com/repos/${REPOSITORY}`;
const DAY = 86_400_000;
const MINUTE = 60_000;
const PERIOD_DAYS = 90;
const SERVICE_FRESHNESS = 15 * MINUTE;
const SERVICE_HEALTH_URL = "https://orgchain.tech/health/services";
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COMPONENTS = new Map([
  [
    "website",
    {
      url: "https://orgchain.tech/",
      description: "Public OrgChain website availability.",
    },
  ],
  [
    "application-health",
    {
      url: "https://orgchain.tech/up",
      description:
        "Public application health endpoint. Does not test sign-in or private workflows.",
    },
  ],
  [
    "database",
    {
      url: `${SERVICE_HEALTH_URL}/database`,
      description:
        "Application database readiness signal. Historical availability describes the signal, not student operations.",
    },
  ],
  [
    "blockchain",
    {
      url: `${SERVICE_HEALTH_URL}/blockchain`,
      description:
        "Blockchain network and expected contract readiness signal. No transactions are submitted.",
    },
  ],
  [
    "private-storage",
    {
      url: `${SERVICE_HEALTH_URL}/private-storage`,
      description:
        "Private file storage readiness signal using isolated checks, not student files.",
    },
  ],
  [
    "document-processing",
    {
      url: `${SERVICE_HEALTH_URL}/document-processing`,
      description:
        "Document processing readiness signal using a synthetic document, not live-user documents.",
    },
  ],
  [
    "institutional-sign-in",
    {
      url: `${SERVICE_HEALTH_URL}/institutional-sign-in`,
      description:
        "Institutional sign-in gateway availability signal. Does not establish a completed sign-in.",
    },
  ],
  [
    "mail-provider",
    {
      url: `${SERVICE_HEALTH_URL}/mail-provider`,
      description:
        "Mail-provider connectivity readiness signal. No email is sent and delivery is not verified.",
    },
  ],
]);

// These are ISO timestamps, not permissive Date.parse inputs (which normalize
// impossible dates such as February 30). Metadata may use an explicit offset.
function timestamp(value) {
  if (typeof value !== "string") return null;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (!match) return null;
  const [, year, month, day, hour, minute, second, , zone] = match;
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const monthDays = [
    31,
    leap ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (
    y < 1 ||
    m < 1 ||
    m > 12 ||
    d < 1 ||
    d > monthDays[m - 1] ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59
  )
    return null;
  if (
    zone !== "Z" &&
    (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59)
  )
    return null;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : null;
}

const iso = (value) => (value === null ? null : new Date(value).toISOString());
const date = (value) => new Date(value).toISOString().slice(0, 10);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const plain = (value) =>
  typeof value === "string"
    ? value
        .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
        .replace(/<[^>]*>/g, "")
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
        .trim()
    : "";

function validateSummary(summary) {
  if (!Array.isArray(summary) || summary.length === 0)
    throw new Error("Expected a nonempty Upptime summary array");
  const seen = new Set();
  for (const entry of summary) {
    if (!entry || typeof entry.slug !== "string" || !SLUG.test(entry.slug))
      throw new Error("Unsafe component slug in summary");
    const configured = COMPONENTS.get(entry.slug);
    if (!configured || entry.url !== configured.url)
      throw new Error("Unexpected monitored component or public endpoint");
    if (seen.has(entry.slug)) throw new Error("Duplicate component in summary");
    if (!plain(entry.name)) throw new Error("Component name is missing");
    seen.add(entry.slug);
  }
  if (seen.size !== COMPONENTS.size)
    throw new Error("Missing configured component in summary");
}

// Only allowlisted coarse values cross the publication boundary. In particular,
// endpoint poll times and provider response details are never probe results.
function serviceReading(source, id, now) {
  const value = source?.services?.[id];
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { status: "unknown", started: null, checked: null };
  const rawStart = timestamp(value.startedAt);
  const rawCheck = timestamp(value.checkedAt);
  const started = rawStart !== null && rawStart <= now ? rawStart : null;
  const checked =
    rawCheck !== null &&
    rawCheck <= now &&
    (started === null || rawCheck >= started)
      ? rawCheck
      : null;
  const statuses = {
    operational: "operational",
    degraded: "degraded",
    unavailable: "outage",
    unknown: "unknown",
  };
  const status =
    checked !== null &&
    started !== null &&
    now - checked <= SERVICE_FRESHNESS &&
    typeof value.status === "string" &&
    own(statuses, value.status)
      ? statuses[value.status]
      : "unknown";
  return { status, started, checked };
}

// Upptime only persists history on changes; a separate poll records current checks.
function publicReading(value, started, now) {
  const checked = timestamp(value?.checkedAt);
  const valid =
    started !== null &&
    checked !== null &&
    checked >= started &&
    checked <= now &&
    now - checked <= SERVICE_FRESHNESS;
  const status =
    valid && value?.status === "operational" ? "operational" : "unknown";
  const response =
    status === "operational" &&
    Number.isFinite(value?.responseTimeMs) &&
    value.responseTimeMs >= 0
      ? value.responseTimeMs
      : null;
  return { status, checked: valid ? checked : null, response };
}

// Upptime's history is flat. Extract only known scalar fields; do not interpret
// arbitrary YAML, generators, response bodies, codes, or diagnostic fields.
function historyFields(value) {
  if (typeof value !== "string")
    return value && typeof value === "object" ? value : {};
  const fields = {};
  for (const line of value.split(/\r?\n/)) {
    const match =
      /^(startTime|lastUpdated|status|responseTime):[ \t]*(.*?)[ \t]*$/.exec(
        line,
      );
    if (match) fields[match[1]] = match[2];
  }
  return fields;
}

function maintenanceMetadata(body, knownSlugs) {
  const metadata = {};
  for (const comment of body.matchAll(/<!--([\s\S]*?)-->/g)) {
    for (const line of comment[1].split(/\r?\n/)) {
      const match =
        /^\s*(start|end|expectedDown|expectedDegraded):[ \t]*(.*?)[ \t]*$/.exec(
          line,
        );
      if (match) metadata[match[1]] = match[2];
    }
  }
  const start = timestamp(metadata.start);
  const end = timestamp(metadata.end);
  const expected = new Set();
  for (const key of ["expectedDown", "expectedDegraded"]) {
    if (typeof metadata[key] !== "string") continue;
    for (const slug of metadata[key].split(",").map((value) => value.trim())) {
      if (knownSlugs.has(slug)) expected.add(slug);
    }
  }
  return {
    start,
    end: start !== null && end !== null && end >= start ? end : null,
    expected,
  };
}

function prepareIssues(issues, knownSlugs, periodStart, now) {
  if (!Array.isArray(issues)) throw new Error("Expected GitHub issues array");
  const records = [];
  const intervals = new Map([...knownSlugs].map((slug) => [slug, []]));
  const seen = new Set();
  for (const issue of issues) {
    if (!issue || issue.pull_request) continue;
    const labels = new Set(
      (Array.isArray(issue.labels) ? issue.labels : [])
        .map((label) => (typeof label === "string" ? label : label?.name))
        .filter((label) => typeof label === "string")
        .map((label) => label.toLowerCase()),
    );
    const isStatus = labels.has("status");
    const isMaintenance = labels.has("maintenance");
    if (!isStatus && !isMaintenance) continue;
    if (!Number.isSafeInteger(issue.number) || issue.number < 1)
      throw new Error("Invalid public issue number");
    if (seen.has(issue.number)) continue;
    seen.add(issue.number);
    const canonicalUrl = `https://github.com/${REPOSITORY}/issues/${issue.number}`;
    if (issue.html_url !== canonicalUrl)
      throw new Error("Unexpected public issue URL");
    const created = timestamp(issue.created_at);
    const updated = timestamp(issue.updated_at);
    const closed = issue.closed_at == null ? null : timestamp(issue.closed_at);
    if (
      created === null ||
      updated === null ||
      updated < created ||
      created > now ||
      !["open", "closed"].includes(issue.state) ||
      (issue.state === "closed" &&
        (closed === null || closed < created || closed > now))
    ) {
      throw new Error(
        `Invalid timestamps or state for public issue #${issue.number}`,
      );
    }
    if (
      typeof issue.title !== "string" ||
      !plain(issue.title) ||
      (issue.body != null && typeof issue.body !== "string")
    )
      throw new Error("Invalid public issue text");
    const body = issue.body ?? "";
    const metadata = maintenanceMetadata(body, knownSlugs);
    const affected = new Set(
      [...knownSlugs].filter((slug) => labels.has(slug)),
    );
    if (isMaintenance) for (const slug of metadata.expected) affected.add(slug);
    // Upptime counts every status issue as downtime, including issues describing
    // degraded performance. Planned/expected maintenance alone is not downtime.
    if (isStatus) {
      for (const slug of knownSlugs) {
        if (labels.has(slug))
          intervals
            .get(slug)
            .push([created, issue.state === "open" ? now : closed]);
      }
    }
    const rangeStart = isMaintenance ? (metadata.start ?? created) : created;
    const rangeEnd = isMaintenance
      ? (metadata.end ?? (issue.state === "open" ? now : closed))
      : issue.state === "open"
        ? now
        : closed;
    const inPeriod = rangeStart <= now && rangeEnd >= periodStart;
    const upcoming =
      isMaintenance && metadata.start !== null && metadata.start > now;
    if (!inPeriod && !(isMaintenance && (issue.state === "open" || upcoming)))
      continue;
    records.push({
      id: issue.number,
      title: plain(issue.title),
      url: canonicalUrl,
      state: issue.state,
      createdAt: iso(created),
      updatedAt: iso(updated),
      resolvedAt: issue.state === "closed" ? iso(closed) : null,
      body: plain(body),
      kind: isMaintenance ? "maintenance" : "incident",
      startsAt: isMaintenance ? iso(metadata.start) : null,
      endsAt: isMaintenance ? iso(metadata.end) : null,
      components: [...affected],
    });
  }
  for (const [slug, ranges] of intervals)
    intervals.set(slug, mergeIntervals(ranges));
  records.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id);
  return { records, intervals };
}

function mergeIntervals(ranges) {
  const merged = [];
  ranges.sort((a, b) => a[0] - b[0]);
  for (const [start, end] of ranges) {
    if (end <= start) continue;
    const previous = merged[merged.length - 1];
    if (previous && start <= previous[1])
      previous[1] = Math.max(previous[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

function dayDowntime(ranges, from, to, daily, dayStart, dayKey) {
  let exact = 0;
  let hasDayInterval = false;
  for (const [start, end] of ranges) {
    if (start >= dayStart + DAY) break;
    if (end > dayStart) hasDayInterval = true;
    exact += Math.max(0, Math.min(end, to) - Math.max(start, from));
  }
  if (hasDayInterval) return exact;
  if (!daily || typeof daily !== "object" || Array.isArray(daily)) return null;
  const minutes = own(daily, dayKey) ? daily[dayKey] : 0;
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < 0)
    return null;
  const recorded = Math.min(DAY, minutes * MINUTE);
  if (recorded === 0) return 0;
  const observed = to - from;
  if (observed === DAY || recorded === DAY) return Math.min(observed, recorded);
  // Aggregated daily totals cannot reveal where downtime fell on a partial day.
  // Return unknown rather than assigning unobserved downtime to observed time.
  return null;
}

/**
 * Pure snapshot builder. summary is the raw history/summary.json array;
 * histories is an object or Map keyed by slug, containing flat YAML strings or
 * {startTime, lastUpdated, status?, responseTime?} objects (ISO date strings).
 * issues is an array of GitHub REST issue objects, with string/object labels.
 * serviceHealth optionally contains the public /health/services aggregate.
 * publicChecks optionally contains actual website and /up endpoint observations.
 * now accepts a Date, epoch milliseconds, or ISO timestamp; no input is mutated.
 */
export function buildSnapshot({
  summary,
  histories,
  issues,
  serviceHealth,
  publicChecks,
  now = new Date(),
}) {
  validateSummary(summary);
  const nowMs =
    now instanceof Date
      ? now.getTime()
      : typeof now === "number"
        ? now
        : timestamp(now);
  if (
    !Number.isFinite(nowMs) ||
    nowMs === null ||
    !Number.isFinite(new Date(nowMs).getTime())
  )
    throw new Error("Invalid snapshot time");
  const today = Date.parse(`${date(nowMs)}T00:00:00.000Z`);
  const periodStart = today - (PERIOD_DAYS - 1) * DAY;
  const slugs = new Set(summary.map((entry) => entry.slug));
  const { records, intervals } = prepareIssues(
    issues,
    slugs,
    periodStart,
    nowMs,
  );
  const components = summary.map((entry) => {
    const privateService = !["website", "application-health"].includes(entry.slug);
    const reading = privateService
      ? serviceReading(serviceHealth, entry.slug, nowMs)
      : null;
    const history = historyFields(
      histories instanceof Map
        ? histories.get(entry.slug)
        : histories?.[entry.slug],
    );
    const rawStart = timestamp(history.startTime);
    const rawCheck = timestamp(history.lastUpdated);
    const started = rawStart !== null && rawStart <= nowMs ? rawStart : null;
    const checked =
      rawCheck !== null &&
      rawCheck <= nowMs &&
      (started === null || rawCheck >= started)
        ? rawCheck
        : null;
    const observed = started !== null && checked !== null && checked >= started;
    const statuses = {
      up: "operational",
      down: "outage",
      degraded: "degraded",
    };
    const rawStatus = history.status ?? entry.status;
    const historyStatus =
      observed && typeof rawStatus === "string" && own(statuses, rawStatus)
        ? statuses[rawStatus]
        : "unknown";
    const publicCheck =
      !privateService && publicChecks !== undefined
        ? publicReading(publicChecks?.[entry.slug], started, nowMs)
        : null;
    const latestStatus = privateService
      ? reading.status
      : publicCheck
        ? publicCheck.status
        : historyStatus;
    const response =
      typeof history.responseTime === "number"
        ? history.responseTime
        : typeof history.responseTime === "string" &&
            /^\d+(?:\.\d+)?$/.test(history.responseTime)
          ? Number(history.responseTime)
          : null;
    let totalObserved = 0;
    let totalDown = 0;
    let unknown = privateService && latestStatus === "unknown";
    const days = [];
    const ranges = intervals.get(entry.slug);
    for (let index = 0; index < PERIOD_DAYS; index++) {
      const dayStart = periodStart + index * DAY;
      const dayKey = date(dayStart);
      const from = observed ? Math.max(dayStart, started) : 0;
      const historyEnd =
        privateService && dayStart === today && reading.checked !== null
          ? Math.min(checked, reading.checked)
          : checked;
      const to = observed ? Math.min(dayStart + DAY, historyEnd) : 0;
      if (to <= from) {
        days.push({
          date: dayKey,
          status: "no-data",
          uptime: null,
          observedMinutes: 0,
        });
        continue;
      }
      const duration = to - from;
      const down = dayDowntime(
        ranges,
        from,
        to,
        entry.dailyMinutesDown,
        dayStart,
        dayKey,
      );
      const uptime =
        down === null
          ? null
          : Math.max(0, Math.min(100, 100 * (1 - down / duration)));
      let status =
        down === null ? "no-data" : down > 0 ? "outage" : "operational";
      // A latest failing check is real even if its status issue has not opened
      // yet. Do not invent an outage duration for that single observation.
      const dayStatus =
        privateService && dayStart === today ? latestStatus : historyStatus;
      if (
        down !== null &&
        checked >= dayStart &&
        checked < dayStart + DAY &&
        ["outage", "degraded"].includes(dayStatus)
      ) {
        status =
          dayStatus === "outage" || status === "outage"
            ? "outage"
            : "degraded";
      }
      if (privateService && dayStart === today && latestStatus === "unknown") {
        status = "no-data";
      }
      days.push({
        date: dayKey,
        status,
        uptime:
          privateService && dayStart === today && latestStatus === "unknown"
            ? null
            : uptime,
        observedMinutes: duration / MINUTE,
      });
      totalObserved += duration;
      if (down === null) unknown = true;
      else totalDown += down;
    }
    return {
      id: entry.slug,
      name: plain(entry.name),
      description: COMPONENTS.get(entry.slug).description,
      url: COMPONENTS.get(entry.slug).url,
      status: latestStatus,
      startedAt: iso(privateService ? reading.started : started),
      checkedAt: iso(privateService ? reading.checked : publicCheck ? publicCheck.checked : checked),
      responseTimeMs: privateService
        ? null
        : publicCheck
          ? publicCheck.response
          : checked !== null && response !== null && Number.isFinite(response) && response >= 0
            ? response
            : null,
      uptime:
        totalObserved > 0 && !unknown
          ? Math.max(0, Math.min(100, 100 * (1 - totalDown / totalObserved)))
          : null,
      days,
    };
  });
  return {
    generatedAt: iso(nowMs),
    period: {
      days: PERIOD_DAYS,
      from: date(periodStart),
      to: date(today),
      timezone: "UTC",
    },
    components,
    incidents: records,
  };
}

async function githubJson(path, token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "OrgChain-Status-Publisher",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  let response;
  try {
    response = await fetch(`${API}${path}`, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error("GitHub public status repository request failed");
  }
  if (!response.ok)
    throw new Error(
      `GitHub public status repository request failed (HTTP ${response.status})`,
    );
  try {
    return await response.json();
  } catch {
    throw new Error("GitHub returned invalid public repository JSON");
  }
}

async function publicIssues(token) {
  const repository = await githubJson("", token);
  if (
    repository.full_name !== REPOSITORY ||
    repository.private !== false ||
    repository.visibility !== "public"
  ) {
    throw new Error(
      "Status publisher requires the configured public repository",
    );
  }
  const issues = new Map();
  for (const label of ["status", "maintenance"]) {
    for (let page = 1; ; page++) {
      const result = await githubJson(
        `/issues?state=all&labels=${label}&per_page=100&sort=created&direction=asc&page=${page}`,
        token,
      );
      if (!Array.isArray(result))
        throw new Error("GitHub returned an invalid issues page");
      for (const issue of result) {
        if (!issue || typeof issue !== "object")
          throw new Error("GitHub returned an invalid issue");
        if (!issue.pull_request) issues.set(issue.number, issue);
      }
      if (result.length < 100) break;
    }
  }
  return [...issues.values()];
}

async function publicServiceHealth() {
  // One credential-free TLS request; redirects cannot change the destination.
  // Read a bounded body under the same deadline, and never publish raw errors.
  try {
    const response = await fetch(SERVICE_HEALTH_URL, {
      headers: { Accept: "application/json" },
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
    if (
      !response.ok ||
      !/^application\/json(?:\s*;|$)/i.test(
        response.headers.get("content-type") ?? "",
      )
    ) {
      await response.body?.cancel();
      return null;
    }
    const reader = response.body?.getReader();
    if (!reader) return null;
    const chunks = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 16_384) {
          await reader.cancel();
          return null;
        }
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
    } finally {
      reader.releaseLock();
    }
  } catch {
    return null;
  }
}

async function publicAvailability() {
  const checks = ["website", "application-health"];
  return Object.fromEntries(
    await Promise.all(checks.map(async (id) => {
      const started = performance.now();
      let operational = false;
      try {
        const response = await fetch(COMPONENTS.get(id).url, {
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          signal: AbortSignal.timeout(8_000),
        });
        if (response.status === 200 && id === "website" && response.body) {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let text = "";
          let bytes = 0;
          try {
            while (bytes <= 262_144) {
              const { done, value } = await reader.read();
              if (done) break;
              bytes += value.byteLength;
              if (bytes > 262_144) break;
              text += decoder.decode(value, { stream: true });
              if (text.includes("OrgChain")) {
                operational = true;
                break;
              }
            }
          } finally {
            await reader.cancel();
            reader.releaseLock();
          }
        } else {
          operational = response.status === 200 && id === "application-health";
          await response.body?.cancel();
        }
      } catch {
        operational = false;
      }
      return [id, {
        status: operational ? "operational" : "unknown",
        checkedAt: new Date().toISOString(),
        responseTimeMs: operational ? Math.round(performance.now() - started) : null,
      }];
    })),
  );
}

async function main() {
  const { values } = parseArgs({
    options: { root: { type: "string" }, output: { type: "string" } },
  });
  if (
    process.env.GITHUB_REPOSITORY &&
    process.env.GITHUB_REPOSITORY !== REPOSITORY
  )
    throw new Error("Unexpected GITHUB_REPOSITORY target");
  const root = resolve(values.root ?? process.cwd());
  const output = values.output
    ? isAbsolute(values.output)
      ? values.output
      : resolve(root, values.output)
    : join(root, "assets", "status.json");
  const summaryText = await readFile(
    join(root, "history", "summary.json"),
    "utf8",
  );
  let summary;
  try {
    summary = JSON.parse(summaryText);
  } catch {
    throw new Error("Invalid Upptime summary JSON");
  }
  validateSummary(summary); // Validate before using any source slug in a path.
  const histories = Object.fromEntries(
    await Promise.all(
      summary.map(async ({ slug }) => [
        slug,
        await readFile(join(root, "history", `${slug}.yml`), "utf8"),
      ]),
    ),
  );
  const [issues, serviceHealth, publicChecks] = await Promise.all([
    publicIssues(process.env.GITHUB_TOKEN),
    publicServiceHealth(),
    publicAvailability(),
  ]);
  const snapshot = buildSnapshot({
    summary,
    histories,
    issues,
    serviceHealth,
    publicChecks,
    now: new Date(),
  });
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  console.log(
    `Published ${snapshot.components.length} monitored components and ${snapshot.incidents.length} public incidents.`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(`Status publication failed: ${error.message}`);
    process.exitCode = 1;
  });
}
