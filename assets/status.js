(() => {
  "use strict";

  const REFRESH_MS = 60_000;
  const STALE_MS = 15 * 60_000;
  const DAY_MS = 86_400_000;
  const LIVE_URL = "https://orgchain.tech";
  const SERVICE_IDS = [
    "database",
    "blockchain",
    "private-storage",
    "document-processing",
    "institutional-sign-in",
    "mail-provider",
  ];
  const COMPONENT_IDS = ["website", "application-health", ...SERVICE_IDS];
  const $ = (id) => document.getElementById(id);
  const labels = {
    operational: "Operational",
    degraded: "Degraded performance",
    outage: "Service outage",
    unknown: "Status unknown",
    "no-data": "No data",
  };
  const dateFormat = new Intl.DateTimeFormat("en", {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const timeFormat = new Intl.DateTimeFormat("en", {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  let snapshot = null;
  let fetchError = false;
  let fetching = false;
  let selectedDays = new Map();
  let returnHash = "#uptime";
  let currentDetail = null;

  function el(tag, className, text) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined) item.textContent = text;
    return item;
  }

  function timestamp(value) {
    return typeof value === "string" && value.trim() ? Date.parse(value) : NaN;
  }

  function strictTimestamp(value) {
    if (typeof value !== "string") return NaN;
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
    if (!match) return NaN;
    const [, year, month, day, hour, minute, second, zone] = match;
    const date = new Date(0);
    date.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
    if (
      date.getUTCFullYear() !== Number(year) ||
      date.getUTCMonth() !== Number(month) - 1 ||
      date.getUTCDate() !== Number(day) ||
      Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 ||
      (zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59))
    ) return NaN;
    return Date.parse(value);
  }

  function dateOnly(value) {
    return (
      typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      Number.isFinite(timestamp(value)) &&
      new Date(timestamp(value)).toISOString().slice(0, 10) === value
    );
  }

  function dateText(value) {
    const time = timestamp(value);
    return Number.isFinite(time)
      ? dateFormat.format(new Date(time))
      : "Not available";
  }

  function timeText(value) {
    const time = timestamp(value);
    return Number.isFinite(time)
      ? `${timeFormat.format(new Date(time))} UTC`
      : "Not available";
  }

  function percentage(value) {
    if (value === null || !Number.isFinite(value)) return "Not available";
    if (value < 100 && value >= 99.995) return ">99.99%";
    return `${value.toFixed(2)}%`;
  }

  function safeLink(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" || url.protocol === "http:"
        ? url.href
        : null;
    } catch {
      return null;
    }
  }

  function link(text, href, className) {
    const url = safeLink(href);
    if (!url) return el("span", className, text);
    const item = el("a", className, text);
    item.href = url;
    item.rel = "noopener noreferrer";
    return item;
  }

  function isPercentage(value) {
    return (
      value === null || (Number.isFinite(value) && value >= 0 && value <= 100)
    );
  }

  function validate(data) {
    if (
      !data ||
      !Number.isFinite(timestamp(data.generatedAt)) ||
      !data.period ||
      data.period.days !== 90 ||
      data.period.timezone !== "UTC" ||
      !dateOnly(data.period.from) ||
      !dateOnly(data.period.to) ||
      timestamp(data.period.to) - timestamp(data.period.from) !== 89 * DAY_MS ||
      !Array.isArray(data.components) ||
      !data.components.length ||
      !Array.isArray(data.incidents)
    )
      throw new Error("Invalid monitoring snapshot");
    const ids = new Set();
    for (const component of data.components) {
      if (
        !component ||
        typeof component.id !== "string" ||
        !component.id ||
        ids.has(component.id) ||
        typeof component.name !== "string" ||
        !component.name ||
        !["operational", "degraded", "outage", "unknown"].includes(
          component.status,
        ) ||
        !isPercentage(component.uptime) ||
        !Array.isArray(component.days) ||
        component.days.length !== 90
      )
        throw new Error("Invalid component observations");
      ids.add(component.id);
      for (const key of ["startedAt", "checkedAt"]) {
        if (
          component[key] !== null &&
          !Number.isFinite(timestamp(component[key]))
        )
          throw new Error("Invalid observation timestamp");
      }
      if (
        component.responseTimeMs !== null &&
        (!Number.isFinite(component.responseTimeMs) ||
          component.responseTimeMs < 0)
      )
        throw new Error("Invalid response observation");
      component.days.forEach((day, index) => {
        const expected = new Date(timestamp(data.period.from) + index * DAY_MS)
          .toISOString()
          .slice(0, 10);
        if (
          !day ||
          day.date !== expected ||
          !["operational", "degraded", "outage", "no-data"].includes(
            day.status,
          ) ||
          !isPercentage(day.uptime) ||
          !Number.isFinite(day.observedMinutes) ||
          day.observedMinutes < 0 ||
          day.observedMinutes > 1440 ||
          (day.status === "no-data" && day.uptime !== null)
        )
          throw new Error("Invalid daily observations");
      });
    }
    if (ids.size !== COMPONENT_IDS.length || COMPONENT_IDS.some((id) => !ids.has(id)))
      throw new Error("Missing monitored components");
    for (const incident of data.incidents) {
      if (
        !incident ||
        !Number.isInteger(incident.id) ||
        typeof incident.title !== "string" ||
        typeof incident.body !== "string" ||
        !["open", "closed"].includes(incident.state) ||
        !["incident", "maintenance"].includes(incident.kind) ||
        !Array.isArray(incident.components) ||
        incident.components.some((id) => typeof id !== "string") ||
        !Number.isFinite(timestamp(incident.createdAt)) ||
        !Number.isFinite(timestamp(incident.updatedAt))
      )
        throw new Error("Invalid incident record");
      for (const key of ["resolvedAt", "startsAt", "endsAt"]) {
        if (
          incident[key] !== null &&
          !Number.isFinite(timestamp(incident[key]))
        )
          throw new Error("Invalid incident timestamp");
      }
    }
    return data;
  }

  async function boundedText(response, limit) {
    const reader = response.body?.getReader();
    if (!reader) return null;
    const decoder = new TextDecoder();
    let text = "";
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return text + decoder.decode();
        size += value.byteLength;
        if (size > limit) return null;
        text += decoder.decode(value, { stream: true });
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  async function observePublic(path, marker, signal) {
    const started = performance.now();
    try {
      const response = await fetch(`${LIVE_URL}${path}`, {
        method: marker ? "GET" : "HEAD",
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal,
      });
      if (response.status !== 200) {
        await response.body?.cancel();
        return { status: "unknown", checkedAt: null, responseTimeMs: null };
      }
      if (marker) {
        const body = await boundedText(response, 262_144);
        if (!body?.includes(marker))
          return { status: "unknown", checkedAt: null, responseTimeMs: null };
      } else {
        await response.body?.cancel();
      }
      return {
        status: "operational",
        checkedAt: new Date().toISOString(),
        responseTimeMs: Math.round(performance.now() - started),
      };
    } catch {
      return { status: "unknown", checkedAt: null, responseTimeMs: null };
    }
  }

  async function observeServices(signal) {
    try {
      const response = await fetch(`${LIVE_URL}/health/services`, {
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal,
        headers: { Accept: "application/json" },
      });
      if (
        response.status !== 200 ||
        !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")
      ) {
        await response.body?.cancel();
        return null;
      }
      const text = await boundedText(response, 16_384);
      return text === null ? null : JSON.parse(text);
    } catch {
      return null;
    }
  }

  function currentService(value, now) {
    const checked = strictTimestamp(value?.checkedAt);
    const started = strictTimestamp(value?.startedAt);
    const valid =
      Number.isFinite(checked) && Number.isFinite(started) &&
      started <= checked && checked <= now && started <= now;
    const statuses = {
      operational: "operational",
      degraded: "degraded",
      unavailable: "outage",
      unknown: "unknown",
    };
    return {
      status: valid && now - checked <= STALE_MS && Object.hasOwn(statuses, value?.status)
        ? statuses[value.status]
        : "unknown",
      checkedAt: valid ? new Date(checked).toISOString() : null,
      startedAt: valid ? new Date(started).toISOString() : null,
      responseTimeMs: null,
    };
  }

  async function updateCurrent(data, signal) {
    const [website, application, services] = await Promise.all([
      observePublic("/", "OrgChain", signal),
      observePublic("/up", null, signal),
      observeServices(signal),
    ]);
    const now = Date.now();
    for (const component of data.components) {
      const current = component.id === "website"
        ? website
        : component.id === "application-health"
          ? application
          : currentService(services?.services?.[component.id], now);
      const previous = timestamp(component.checkedAt);
      // Preserve a recent independently confirmed outage if the live check is unreachable.
      if (current.status === "unknown" && component.status === "outage" &&
          Number.isFinite(previous) && previous <= now && now - previous <= STALE_MS)
        continue;
      component.status = current.status;
      component.checkedAt = current.checkedAt;
      component.responseTimeMs = current.responseTimeMs;
      if (SERVICE_IDS.includes(component.id) && current.startedAt)
        component.startedAt = current.startedAt;
    }
    return data;
  }

  function freshness(now = Date.now()) {
    if (!snapshot)
      return { fresh: false, message: "No monitoring snapshot is available." };
    const times = [
      timestamp(snapshot.generatedAt),
      ...snapshot.components.flatMap((component) => [
        timestamp(component.checkedAt),
        timestamp(component.startedAt),
      ]),
    ];
    if (times.some((time) => Number.isFinite(time) && time > now))
      return {
        fresh: false,
        message:
          "The snapshot contains future monitoring timestamps. Current availability cannot be confirmed.",
      };
    if (
      snapshot.components.some(
        (component) =>
          component.checkedAt &&
          component.status !== "unknown" &&
          now - timestamp(component.checkedAt) > STALE_MS,
      )
    )
      return {
        fresh: false,
        message:
          "The latest checks are delayed. Current availability cannot be confirmed.",
      };
    return { fresh: true, message: "" };
  }

  function noticePhase(incident, now = Date.now()) {
    if (incident.kind === "incident")
      return incident.state === "open" ? "active" : "past";
    const start = timestamp(incident.startsAt);
    const end = timestamp(incident.endsAt);
    if (incident.state === "closed" || (Number.isFinite(end) && end <= now))
      return "past";
    if (Number.isFinite(start) && start > now) return "scheduled";
    if (Number.isFinite(start)) return "maintenance";
    return "notice";
  }

  function overallState() {
    const components = snapshot.components;
    if (components.some((component) => component.status === "outage"))
      return {
        state: "outage",
        title: "Service disruption",
        description:
          "One or more availability or readiness signals report a disruption. This does not diagnose its internal cause.",
        symbol: "!",
      };
    if (components.some((component) => component.status === "degraded"))
      return {
        state: "degraded",
        title: "Degraded performance",
        description:
          "One or more availability or readiness signals report degraded performance.",
        symbol: "!",
      };
    if (
      components.some(
        (component) => component.status === "unknown" || !component.checkedAt,
      )
    )
      return {
        state: "unknown",
        title: "Some service status is unknown",
        description:
          "There is not enough recent monitoring data to confirm every service.",
        symbol: "?",
      };
    if (
      snapshot.incidents.some(
        (incident) => incident.kind === "incident" && incident.state === "open",
      )
    )
      return {
        state: "degraded",
        title: "An incident is being investigated",
        description:
          "Monitored checks are operational; an incident remains open below.",
        symbol: "!",
      };
    if (
      snapshot.incidents.some(
        (incident) => noticePhase(incident) === "maintenance",
      )
    )
      return {
        state: "maintenance",
        title: "Maintenance in progress",
        description:
          "Monitored services are operational. See the maintenance notice below.",
        symbol: "i",
      };
    return {
      state: "operational",
      title: "All monitored systems operational",
      description:
        "All eight availability and readiness checks are reporting normally. Readiness is not proof of completed student operations.",
      symbol: "✓",
    };
  }

  function renderOverall() {
    const health = freshness();
    let state;
    if (fetchError)
      state = {
        state: "unknown",
        title: "Status updates unavailable",
        description: snapshot
          ? "The latest refresh failed. Last-known observations are shown below, not live status."
          : "The monitoring snapshot could not be loaded. Please retry.",
        symbol: "!",
      };
    else if (!snapshot)
      state = {
        state: "unknown",
        title: "Checking system status",
        description: "Loading the latest monitoring snapshot.",
        symbol: "…",
      };
    else if (!health.fresh)
      state = {
        state: "unknown",
        title: "Status updates delayed",
        description: health.message,
        symbol: "!",
      };
    else state = overallState();
    $("overall").className = `overall state-${state.state}`;
    $("overall-title").textContent = state.title;
    $("overall-description").textContent = state.description;
    $("overall-icon").textContent = state.symbol;
    $("retry").hidden = !fetchError &&
      (!snapshot || (health.fresh && snapshot.components.every((component) => component.status !== "unknown")));
    $("retry").disabled = fetching;
    $("retry").textContent = fetching ? "Retrying…" : "Retry now";
    if (!snapshot) return;
    const checks = snapshot.components.map((component) =>
      timestamp(component.checkedAt),
    );
    const oldestCheck =
      checks.length && checks.every(Number.isFinite)
        ? Math.min(...checks)
        : NaN;
    $("last-checked").textContent = Number.isFinite(oldestCheck)
      ? `Last checked: ${timeText(new Date(oldestCheck).toISOString())}`
      : "Last checked: unavailable for one or more services";
    const lastKnown = fetchError || !health.fresh;
    const historyStale = Date.now() - timestamp(snapshot.generatedAt) > STALE_MS ||
      snapshot.period.to !== new Date().toISOString().slice(0, 10);
    $("data-notice").hidden = !lastKnown && !historyStale;
    $("data-notice").textContent = lastKnown
      ? `Showing last-known results. Snapshot updated ${timeText(snapshot.generatedAt)}.`
      : `Current status is checked live. Uptime history and incidents were last updated ${timeText(snapshot.generatedAt)}.`;
  }

  function statusBadge(component) {
    const badge = el("span", `service-state ${component.status}`);
    badge.append(
      el("span", "status-dot"),
      el("span", null, labels[component.status]),
    );
    badge.firstChild.setAttribute("aria-hidden", "true");
    return badge;
  }

  function dayDescription(day) {
    if (day.status === "no-data")
      return `${dateText(day.date)}: ${day.observedMinutes > 0 ? `availability unknown over ${formatMinutes(day.observedMinutes)} observed` : "no observed data"}`;
    return `${dateText(day.date)}: ${labels[day.status]}, ${percentage(day.uptime)} availability over ${formatMinutes(day.observedMinutes)} observed`;
  }

  function formatMinutes(minutes) {
    return `${new Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(minutes)} minutes`;
  }

  function renderServices() {
    const focused = document.activeElement;
    const focusedService = focused?.dataset?.service;
    const focusedDate = focused?.dataset?.date;
    const fragment = document.createDocumentFragment();
    for (const component of snapshot.components) {
      const card = el("article", "service-card");
      const heading = el("div", "service-heading");
      const name = el("div", "service-name");
      name.append(el("h3", null, component.name));
      if (component.description) {
        const info = el("details", "info");
        const summary = el("summary", null, "i");
        summary.setAttribute("aria-label", `About ${component.name}`);
        info.append(summary, el("p", null, component.description));
        name.append(info);
      }
      heading.append(name, statusBadge(component));
      const strip = el("div", "day-strip");
      strip.setAttribute("role", "group");
      strip.setAttribute(
        "aria-label",
        `${component.name}: 90 days of availability. Use arrow keys to select a day, Enter for details.`,
      );
      const previousSelection = selectedDays.get(component.id);
      const selected = component.days.some(
        (day) => day.date === previousSelection,
      )
        ? previousSelection
        : component.days[89].date;
      selectedDays.set(component.id, selected);
      component.days.forEach((day, index) => {
        const bar = el("button", `day-bar ${day.status}`);
        bar.type = "button";
        bar.dataset.service = component.id;
        bar.dataset.date = day.date;
        bar.tabIndex = day.date === selected ? 0 : -1;
        bar.setAttribute("aria-label", dayDescription(day));
        bar.setAttribute("aria-pressed", String(day.date === selected));
        bar.title = dayDescription(day);
        const selectDay = () => {
          selectedDays.set(component.id, day.date);
          for (const sibling of strip.children) {
            sibling.tabIndex = sibling === bar ? 0 : -1;
            sibling.setAttribute("aria-pressed", String(sibling === bar));
          }
        };
        bar.addEventListener("focus", selectDay);
        bar.addEventListener("click", () => {
          selectDay();
          navigateService(component.id, day.date);
        });
        bar.addEventListener("keydown", (event) => {
          let next;
          if (event.key === "ArrowRight" || event.key === "ArrowDown")
            next = Math.min(89, index + 1);
          if (event.key === "ArrowLeft" || event.key === "ArrowUp")
            next = Math.max(0, index - 1);
          if (event.key === "Home") next = 0;
          if (event.key === "End") next = 89;
          if (next !== undefined) {
            event.preventDefault();
            strip.children[next].focus();
          }
        });
        strip.append(bar);
      });
      const axis = el("div", "uptime-axis");
      axis.append(
        el("span", null, "90 days ago"),
        el("span", "axis-rule"),
        el(
          "span",
          "uptime-value",
          component.uptime === null
            ? "No observed uptime"
            : `${percentage(component.uptime)} uptime`,
        ),
        el("span", "axis-rule"),
        el("span", null, "Today"),
      );
      const note =
        component.startedAt &&
        timestamp(component.startedAt) > timestamp(snapshot.period.from)
          ? `Monitoring since ${dateText(component.startedAt)}.`
          : "Uptime reflects observed minutes only.";
      const actions = el("div", "service-actions");
      const detail = el("a", null, "View details →");
      detail.href = serviceHash(component.id, selected);
      detail.addEventListener("click", (event) => {
        event.preventDefault();
        navigateService(component.id, selectedDays.get(component.id));
      });
      actions.append(
        detail,
        el(
          "span",
          "muted",
          component.responseTimeMs === null
            ? component.checkedAt ? `Checked ${timeText(component.checkedAt)}` : "Awaiting check"
            : `${Math.round(component.responseTimeMs)} ms latest response`,
        ),
      );
      card.append(
        heading,
        strip,
        axis,
        el("p", "service-footnote", note),
        actions,
      );
      fragment.append(card);
    }
    $("services").replaceChildren(fragment);
    $("services").setAttribute("aria-busy", "false");
    if (focusedService && focusedDate && !$("service-dialog").open) {
      const bar = Array.from($("services").querySelectorAll(".day-bar")).find(
        (item) =>
          item.dataset.service === focusedService &&
          item.dataset.date === focusedDate,
      );
      bar?.focus({ preventScroll: true });
    }
  }

  function incidentCard(incident, past = false) {
    const phase = noticePhase(incident);
    const card = el(
      "article",
      `notice-card ${incident.kind === "maintenance" ? "maintenance" : !past ? "active-incident" : ""}`,
    );
    const top = el("div", "notice-top");
    const label =
      incident.kind === "maintenance"
        ? {
            scheduled: "Scheduled maintenance",
            maintenance: "Maintenance in progress",
            notice: "Maintenance notice",
            past: "Past maintenance",
          }[phase]
        : past
          ? "Resolved incident"
          : "Open incident";
    top.append(el("span", "notice-tag", label));
    card.append(top, el("h3", null, incident.title));
    const dateLine =
      incident.kind === "maintenance" && incident.startsAt
        ? `Scheduled: ${timeText(incident.startsAt)}${incident.endsAt ? ` – ${timeText(incident.endsAt)}` : " · End time not published"}`
        : `Reported ${timeText(incident.createdAt)}`;
    card.append(el("p", "notice-date", dateLine));
    if (incident.resolvedAt && incident.kind === "incident")
      card.append(
        el("p", "notice-date", `Resolved ${timeText(incident.resolvedAt)}`),
      );
    else
      card.append(
        el("p", "notice-date", `Updated ${timeText(incident.updatedAt)}`),
      );
    if (incident.body.trim()) {
      const body = el("p", "notice-body", incident.body);
      if (past || incident.body.length > 700) {
        const details = el("details", "notice-body-details");
        details.append(el("summary", null, "Read published update"), body);
        card.append(details);
      } else card.append(body);
    }
    if (incident.kind === "maintenance" && !past)
      card.append(
        el(
          "p",
          "detail-note",
          "A maintenance notice does not necessarily mean a service is unavailable. See monitored service status above.",
        ),
      );
    card.append(link("View published update ↗", incident.url, "notice-link"));
    return card;
  }

  function renderIncidents() {
    const current = snapshot.incidents
      .filter((incident) => noticePhase(incident) !== "past")
      .sort((a, b) => {
        const rank = (incident) =>
          noticePhase(incident) === "active"
            ? 0
            : noticePhase(incident) === "maintenance"
              ? 1
              : 2;
        return (
          rank(a) - rank(b) ||
          timestamp(a.startsAt || a.createdAt) -
            timestamp(b.startsAt || b.createdAt)
        );
      });
    $("current-notices").replaceChildren(
      ...(current.length
        ? current.map((incident) => incidentCard(incident))
        : [
            el(
              "p",
              "empty-state",
              "No active incidents or scheduled maintenance.",
            ),
          ]),
    );
    const filter = $("history-filter").value;
    const history = snapshot.incidents
      .filter(
        (incident) =>
          noticePhase(incident) === "past" &&
          (filter === "all" || incident.kind === filter),
      )
      .sort(
        (a, b) =>
          timestamp(b.resolvedAt || b.endsAt || b.updatedAt) -
          timestamp(a.resolvedAt || a.endsAt || a.updatedAt),
      );
    $("incident-history").replaceChildren(
      ...(history.length
        ? history.map((incident) => incidentCard(incident, true))
        : [
            el(
              "p",
              "empty-state",
              filter === "all"
                ? "No past incidents or maintenance reported."
                : `No past ${filter === "incident" ? "incidents" : "maintenance updates"} reported.`,
            ),
          ]),
    );
  }

  function serviceHash(id, day) {
    return `#service=${encodeURIComponent(id)}${day ? `&day=${encodeURIComponent(day)}` : ""}`;
  }

  function navigateService(id, day) {
    if (!location.hash.startsWith("#service="))
      returnHash = location.hash || "#uptime";
    const hash = serviceHash(id, day);
    if (location.hash === hash) handleHash();
    else location.hash = hash;
  }

  function fact(list, name, value) {
    const entry = el("div");
    entry.append(el("dt", null, name), el("dd", null, value));
    list.append(entry);
  }

  function relevantIncidents(component, day) {
    const from = timestamp(day.date);
    const to = from + DAY_MS;
    return snapshot.incidents.filter((incident) => {
      if (
        incident.components.length &&
        !incident.components.includes(component.id)
      )
        return false;
      const start = timestamp(incident.startsAt || incident.createdAt);
      const end =
        timestamp(
          incident.resolvedAt ||
            incident.endsAt ||
            (incident.state === "closed" ? incident.updatedAt : null),
        ) || Date.now();
      return start < to && end >= from;
    });
  }

  function renderDailyDetail(component, date) {
    const day = component.days.find((item) => item.date === date);
    const target = $("selected-day-detail");
    target.replaceChildren();
    if (!day) {
      target.append(
        el("p", null, "This date is outside the published 90-day window."),
      );
      return;
    }
    const daily = el("div", "daily-detail");
    daily.append(
      el("h3", null, dateText(day.date)),
      el(
        "p",
        null,
        `${labels[day.status]}${day.status === "no-data" ? "" : ` · ${percentage(day.uptime)} availability`}`,
      ),
    );
    daily.append(
      el(
        "p",
        null,
        day.status === "no-data"
          ? day.observedMinutes > 0
            ? `${formatMinutes(day.observedMinutes)} of monitoring history are available, but current readiness is unknown or the source cannot establish availability within this partial window. This is not an operational reading.`
            : "No observed monitoring window is available for this day. This is not an operational reading."
          : `${formatMinutes(day.observedMinutes)} observed in UTC. Availability is calculated only over that observed window, not automatically over a full day.`,
      ),
    );
    target.append(daily, el("h3", null, "Related published updates"));
    const related = relevantIncidents(component, day);
    if (!related.length)
      target.append(
        el(
          "p",
          "detail-note",
          "No published incident or maintenance overlaps this service and day. Monitoring disruptions may occur without a published incident.",
        ),
      );
    else {
      const list = el("ul", "related-list");
      for (const incident of related) {
        const row = el("li");
        row.append(link(incident.title, incident.url));
        list.append(row);
      }
      target.append(
        list,
        el(
          "p",
          "detail-note",
          "Related updates overlap this day; they do not establish the cause of every monitoring disruption.",
        ),
      );
    }
  }

  function renderDetail(id, requestedDay) {
    const component = snapshot.components.find((item) => item.id === id);
    $("detail-content").replaceChildren();
    if (!component) {
      $("detail-title").textContent = "Service not found";
      $("detail-content").append(
        el(
          "p",
          "detail-description",
          "This service is not present in the monitoring snapshot. Close this panel to see the monitored services.",
        ),
      );
      currentDetail = { id, day: requestedDay };
      return;
    }
    const day = component.days.some((item) => item.date === requestedDay)
      ? requestedDay
      : component.days[89].date;
    currentDetail = { id, day };
    $("detail-title").textContent = component.name;
    const content = $("detail-content");
    const lastKnown = fetchError || !freshness().fresh;
    if (lastKnown)
      content.append(
        el(
          "p",
          "detail-description",
          "Last-known observations only. Current status cannot be confirmed while updates are unavailable or delayed.",
        ),
      );
    if (component.description)
      content.append(el("p", "detail-description", component.description));
    const status = el("div", "detail-status");
    status.append(
      el(
        "span",
        "muted",
        lastKnown ? "Last-known status:" : "Latest observed status:",
      ),
      statusBadge(component),
    );
    const facts = el("dl", "detail-facts");
    fact(facts, "90-day observed uptime", percentage(component.uptime));
    fact(
      facts,
      "Latest observed response",
      component.responseTimeMs === null
        ? "Not available"
        : `${Math.round(component.responseTimeMs)} ms`,
    );
    fact(facts, "Monitoring began", timeText(component.startedAt));
    fact(facts, "Last checked", timeText(component.checkedAt));
    content.append(
      status,
      facts,
      el(
        "p",
        "detail-note",
        "Response time is the latest check, not a historical measurement for the selected day.",
      ),
    );
    const picker = el("div", "day-picker");
    const label = el("label", null, "Explore a day");
    label.htmlFor = "detail-day";
    const input = el("input");
    input.id = "detail-day";
    input.type = "date";
    input.min = snapshot.period.from;
    input.max = snapshot.period.to;
    input.value = day;
    input.addEventListener("change", () => {
      if (!component.days.some((item) => item.date === input.value)) return;
      currentDetail.day = input.value;
      selectedDays.set(component.id, input.value);
      history.replaceState(null, "", serviceHash(component.id, input.value));
      renderDailyDetail(component, input.value);
    });
    picker.append(label, input);
    const daily = el("div");
    daily.id = "selected-day-detail";
    daily.setAttribute("aria-live", "polite");
    content.append(
      picker,
      daily,
      link("Open monitored endpoint ↗", component.url, "detail-service-link"),
    );
    renderDailyDetail(component, day);
  }

  function handleHash() {
    const dialog = $("service-dialog");
    if (!location.hash.startsWith("#service=")) {
      if (dialog.open) dialog.close();
      currentDetail = null;
      return;
    }
    if (!snapshot) return;
    const params = new URLSearchParams(location.hash.slice(1));
    renderDetail(params.get("service"), params.get("day"));
    if (!dialog.open) dialog.showModal();
  }

  function render() {
    renderOverall();
    if (!snapshot) return;
    renderServices();
    renderIncidents();
    if (currentDetail && $("service-dialog").open) {
      const wasDateFocused = document.activeElement?.id === "detail-day";
      renderDetail(currentDetail.id, currentDetail.day);
      if (wasDateFocused) $("detail-day")?.focus({ preventScroll: true });
    } else handleHash();
  }

  async function refresh() {
    if (fetching) return;
    fetching = true;
    renderOverall();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch("./status.json", {
        cache: "no-store",
        credentials: "omit",
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error("Snapshot request failed");
      snapshot = await updateCurrent(validate(await response.json()), controller.signal);
      fetchError = false;
    } catch {
      fetchError = true;
      if (!snapshot) {
        $("services").setAttribute("aria-busy", "false");
        $("services").replaceChildren(
          el(
            "p",
            "loading-panel",
            "Service observations are unavailable until the monitoring snapshot can be loaded.",
          ),
        );
        $("current-notices").replaceChildren(
          el(
            "p",
            "empty-state",
            "Incident and maintenance information is unavailable. This does not mean there are no active incidents.",
          ),
        );
        $("incident-history").replaceChildren(
          el("p", "empty-state", "Published history could not be loaded."),
        );
      }
    } finally {
      clearTimeout(timeout);
      fetching = false;
      render();
    }
  }

  $("retry").addEventListener("click", refresh);
  $("history-filter").addEventListener("change", () => {
    if (snapshot) renderIncidents();
  });
  $("close-detail").addEventListener("click", () =>
    $("service-dialog").close(),
  );
  $("service-dialog").addEventListener("close", () => {
    if (location.hash.startsWith("#service="))
      history.replaceState(null, "", returnHash);
    currentDetail = null;
  });
  window.addEventListener("hashchange", handleHash);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refresh();
  });
  window.addEventListener("online", refresh);
  setInterval(() => {
    if (!document.hidden) refresh();
  }, REFRESH_MS);
  setInterval(renderOverall, 15_000);
  refresh();
})();
