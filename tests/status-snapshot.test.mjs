import assert from "node:assert/strict";
import test from "node:test";
import { buildSnapshot } from "../scripts/build-status.mjs";

const now = "2026-01-10T12:10:00.000Z";
const start = "2026-01-10T12:00:00.000Z";

function fixture({
  started = start,
  checked = now,
  status = "up",
  daily = {},
} = {}) {
  return {
    now,
    summary: [
      {
        slug: "website",
        name: "Website",
        url: "https://orgchain.tech/",
        status,
        time: 999,
        dailyMinutesDown: daily,
      },
      {
        slug: "application-health",
        name: "Application health",
        url: "https://orgchain.tech/up",
        status: "up",
        dailyMinutesDown: {},
      },
    ],
    histories: {
      website: {
        startTime: started,
        lastUpdated: checked,
        status,
        responseTime: 245,
      },
      "application-health": {
        startTime: start,
        lastUpdated: now,
        status: "up",
        responseTime: 120,
      },
    },
    issues: [],
  };
}

function incident(number, created, closed, extra = {}) {
  return {
    number,
    html_url: `https://github.com/chals1029/orgchain-status/issues/${number}`,
    title: "Synthetic availability incident",
    body: "Synthetic monitoring fixture, not a real incident.",
    labels: [{ name: "status" }, { name: "website" }],
    state: closed ? "closed" : "open",
    created_at: created,
    updated_at: closed || now,
    closed_at: closed,
    ...extra,
  };
}

function website(input) {
  return buildSnapshot(input).components.find(
    (component) => component.id === "website",
  );
}

function closeTo(actual, expected) {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${actual} differs from ${expected}`,
  );
}

test("unobserved days remain gray and a partial first day uses only observed minutes", () => {
  const component = website(fixture());
  assert.deepEqual(
    component.days
      .slice(0, -1)
      .map((day) => [day.status, day.uptime, day.observedMinutes]),
    Array.from({ length: 89 }, () => ["no-data", null, 0]),
  );
  assert.deepEqual(component.days.at(-1), {
    date: "2026-01-10",
    status: "operational",
    uptime: 100,
    observedMinutes: 10,
  });
  assert.equal(component.responseTimeMs, 245);
  assert.equal(component.uptime, 100);
});

test("overlapping and duplicate incident intervals are counted once", () => {
  const input = fixture();
  const first = incident(
    80001,
    "2026-01-10T12:01:00.000Z",
    "2026-01-10T12:05:00.000Z",
  );
  input.issues = [
    first,
    { ...first },
    incident(80002, "2026-01-10T12:03:00.000Z", "2026-01-10T12:07:00.000Z"),
  ];
  const snapshot = buildSnapshot(input);
  const component = snapshot.components[0];
  closeTo(component.uptime, 40);
  closeTo(component.days.at(-1).uptime, 40);
  assert.equal(component.days.at(-1).status, "outage");
  assert.deepEqual(
    snapshot.incidents.map((issue) => issue.id).sort(),
    [80001, 80002],
  );
  assert.equal(snapshot.components[1].uptime, 100);
});

test("an ongoing outage is clipped at the actual observation time", () => {
  const input = fixture({ status: "down" });
  input.issues = [incident(80003, "2026-01-10T12:06:00.000Z", null)];
  const component = website(input);
  assert.equal(component.status, "outage");
  closeTo(component.uptime, 60);
  assert.equal(component.days.at(-1).observedMinutes, 10);
});

test("UTC midnight splits partial observation windows instead of assuming full days", () => {
  const input = fixture({
    started: "2026-01-09T23:58:00.000Z",
    checked: "2026-01-10T00:08:00.000Z",
  });
  input.issues = [
    incident(80004, "2026-01-09T23:59:00.000Z", "2026-01-10T00:02:00.000Z"),
  ];
  const component = website(input);
  assert.equal(component.days.at(-2).date, "2026-01-09");
  assert.equal(component.days.at(-2).observedMinutes, 2);
  closeTo(component.days.at(-2).uptime, 50);
  assert.equal(component.days.at(-1).observedMinutes, 8);
  closeTo(component.days.at(-1).uptime, 75);
  closeTo(component.uptime, 70);
});

test("an incident outside the observed part of the day does not reduce measured availability", () => {
  const input = fixture({ daily: { "2026-01-10": 60 } });
  input.issues = [
    incident(80005, "2026-01-10T01:00:00.000Z", "2026-01-10T02:00:00.000Z"),
  ];
  assert.equal(website(input).uptime, 100);
});

test("ambiguous partial-day downtime is unknown instead of a fabricated precise percentage", () => {
  const component = website(fixture({ daily: { "2026-01-10": 3 } }));
  assert.equal(component.days.at(-1).observedMinutes, 10);
  assert.equal(component.days.at(-1).status, "no-data");
  assert.equal(component.days.at(-1).uptime, null);
  assert.equal(component.uptime, null);
});

test("invalid and future monitoring dates cannot create green historical observations", () => {
  for (const started of [
    "2026-02-30T12:00:00.000Z",
    "2026-01-11T12:00:00.000Z",
    "not-a-date",
  ]) {
    const component = website(fixture({ started }));
    assert.equal(component.status, "unknown");
    assert.equal(component.uptime, null);
    assert.ok(
      component.days.every(
        (day) => day.status === "no-data" && day.uptime === null,
      ),
    );
  }
  const component = website(fixture({ checked: "2026-01-11T12:00:00.000Z" }));
  assert.equal(component.checkedAt, null);
  assert.equal(component.status, "unknown");
});

test("planned maintenance is published without fabricating an outage", () => {
  const input = fixture();
  input.issues = [
    incident(80006, "2026-01-10T11:00:00.000Z", null, {
      title: "Synthetic planned maintenance",
      labels: [{ name: "maintenance" }],
      body: "<!--\nstart: 2026-01-10T13:00:00.000Z\nend: 2026-01-10T14:00:00.000Z\nexpectedDown: website\n-->\nRoutine planned work.",
    }),
  ];
  const snapshot = buildSnapshot(input);
  assert.equal(snapshot.components[0].status, "operational");
  assert.equal(snapshot.components[0].uptime, 100);
  assert.deepEqual(snapshot.incidents[0].components, ["website"]);
  assert.equal(snapshot.incidents[0].kind, "maintenance");
  assert.equal(snapshot.incidents[0].startsAt, "2026-01-10T13:00:00.000Z");
  assert.equal(snapshot.incidents[0].body, "Routine planned work.");
});

test("publication rejects missing monitors, unsafe paths and non-public endpoints", () => {
  const missing = fixture();
  missing.summary.pop();
  assert.throws(() => buildSnapshot(missing), /Missing configured component/);
  const traversal = fixture();
  traversal.summary[0].slug = "../private";
  assert.throws(() => buildSnapshot(traversal), /Unsafe component slug/);
  const internal = fixture();
  internal.summary[0].url = "http://127.0.0.1/private";
  assert.throws(
    () => buildSnapshot(internal),
    /Unexpected monitored component/,
  );
});
