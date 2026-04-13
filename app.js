function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function normal(mean, std) {
  const u1 = Math.random() || 1e-7;
  const u2 = Math.random() || 1e-7;
  const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  return mean + z * std;
}

function poisson(lambda) {
  if (lambda <= 0) return 0;
  if (lambda > 50) {
    return Math.max(0, Math.round(normal(lambda, Math.sqrt(lambda))));
  }
  const l = Math.exp(-lambda);
  let p = 1;
  let k = 0;
  do {
    k += 1;
    p *= Math.random();
  } while (p > l);
  return k - 1;
}

function sampleLatencyMs(dist, a, b) {
  if (dist === "constant") return Math.max(1, a);
  if (dist === "uniform") {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    return Math.max(1, lo + Math.random() * (hi - lo));
  }
  if (dist === "normal") return Math.max(1, normal(a, Math.max(1, b)));
  if (dist === "lognormal") {
    const x = normal(a, Math.max(0.01, b));
    return Math.max(1, Math.exp(x));
  }
  if (dist === "exponential") {
    const mean = Math.max(1, a);
    return Math.max(1, -Math.log(1 - Math.random()) * mean);
  }
  return Math.max(1, a);
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[clamp(idx, 0, sorted.length - 1)];
}

class FixedWindowLimiter {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.windowStart = 0;
    this.count = 0;
  }

  refresh(tMs) {
    if (tMs >= this.windowStart + this.windowMs) {
      this.windowStart = Math.floor(tMs / this.windowMs) * this.windowMs;
      this.count = 0;
    }
  }

  canAllow(tMs) {
    this.refresh(tMs);
    return this.count < this.limit;
  }

  commit(tMs) {
    this.refresh(tMs);
    this.count += 1;
  }

  countAt(tMs) {
    this.refresh(tMs);
    return this.count;
  }
}

class SlidingWindowLimiter {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.events = [];
    this.head = 0;
  }

  evict(tMs) {
    const floor = tMs - this.windowMs;
    while (this.head < this.events.length && this.events[this.head] <= floor) {
      this.head += 1;
    }
    if (this.head > 2000 && this.head * 2 > this.events.length) {
      this.events = this.events.slice(this.head);
      this.head = 0;
    }
  }

  canAllow(tMs) {
    this.evict(tMs);
    return this.events.length - this.head < this.limit;
  }

  commit(tMs) {
    this.evict(tMs);
    this.events.push(tMs);
  }

  countAt(tMs) {
    this.evict(tMs);
    return this.events.length - this.head;
  }
}

function createLimiter(type, limit, windowMs) {
  if (type === "sliding") return new SlidingWindowLimiter(limit, windowMs);
  return new FixedWindowLimiter(limit, windowMs);
}

function makeWindowSeries(windows) {
  return windows.map((w, idx) => ({
    id: idx,
    label: `${Math.round(w.windowMs / 1000)}s/${w.limit}`,
    windowMs: w.windowMs,
    limit: w.limit,
    utilizationPct: [],
    blocked: 0
  }));
}

function runSimulation(cfg) {
  const {
    durationSec,
    stepMs,
    rps,
    burstiness,
    maxConcurrent,
    queueCapacity,
    maxQueueWaitMs,
    limiterType,
    windows,
    rlLatencyDist,
    rlLatA,
    rlLatB,
    latencyDist,
    latA,
    latB
  } = cfg;

  const limiters = windows.map((w) => createLimiter(limiterType, w.limit, w.windowMs));
  const windowSeries = makeWindowSeries(windows);

  const steps = Math.floor((durationSec * 1000) / stepMs);
  const inflight = [];
  const queue = [];
  const limiterPending = [];
  const latencies = [];
  const limiterLatencies = [];

  const timeline = [];
  let totalArrived = 0;
  let totalServed = 0;
  let totalDelayedServed = 0;
  let total429 = 0;
  let totalDroppedWait = 0;
  let sumLatency = 0;
  let sumQueueDelay = 0;
  let peakLimiterPending = 0;

  for (let step = 0; step <= steps; step += 1) {
    const now = step * stepMs;

    for (let i = inflight.length - 1; i >= 0; i -= 1) {
      if (inflight[i].endMs <= now) {
        const req = inflight[i];
        inflight.splice(i, 1);
        totalServed += 1;
        if (req.queueDelayMs > 0) totalDelayedServed += 1;
        const totalLat = req.serviceMs + req.queueDelayMs;
        latencies.push(totalLat);
        sumLatency += totalLat;
        sumQueueDelay += req.queueDelayMs;
      }
    }

    for (let i = queue.length - 1; i >= 0; i -= 1) {
      if (now - queue[i].arrivalMs > maxQueueWaitMs) {
        queue.splice(i, 1);
        total429 += 1;
        totalDroppedWait += 1;
      }
    }

    while (queue.length > 0 && inflight.length < maxConcurrent) {
      const q = queue.shift();
      const serviceMs = sampleLatencyMs(latencyDist, latA, latB);
      inflight.push({
        endMs: now + serviceMs,
        serviceMs,
        queueDelayMs: now - q.arrivalMs
      });
    }

    const phase = (2 * Math.PI * step) / Math.max(10, steps / 2);
    const trafficMultiplier = 1 + burstiness * Math.sin(phase);
    const expectedInStep = (rps * trafficMultiplier * stepMs) / 1000;
    const arrivals = poisson(Math.max(0, expectedInStep));

    let step429 = 0;
    let stepAccepted = 0;

    for (let i = 0; i < arrivals; i += 1) {
      const decisionLatencyMs = sampleLatencyMs(rlLatencyDist, rlLatA, rlLatB);
      limiterPending.push({
        decisionReadyMs: now + decisionLatencyMs,
        decisionLatencyMs
      });
      limiterLatencies.push(decisionLatencyMs);
    }
    totalArrived += arrivals;

    for (let i = limiterPending.length - 1; i >= 0; i -= 1) {
      if (limiterPending[i].decisionReadyMs > now) continue;
      const pendingReq = limiterPending[i];
      limiterPending.splice(i, 1);

      let blockedIdx = -1;
      for (let j = 0; j < limiters.length; j += 1) {
        if (!limiters[j].canAllow(pendingReq.decisionReadyMs)) {
          blockedIdx = j;
          break;
        }
      }

      if (blockedIdx >= 0) {
        total429 += 1;
        step429 += 1;
        windowSeries[blockedIdx].blocked += 1;
        continue;
      }

      for (let j = 0; j < limiters.length; j += 1) {
        limiters[j].commit(pendingReq.decisionReadyMs);
      }
      stepAccepted += 1;

      if (inflight.length < maxConcurrent) {
        const serviceMs = sampleLatencyMs(latencyDist, latA, latB);
        inflight.push({ endMs: now + serviceMs, serviceMs, queueDelayMs: 0 });
      } else if (queue.length < queueCapacity) {
        queue.push({ arrivalMs: now });
      } else {
        total429 += 1;
        step429 += 1;
      }
    }
    peakLimiterPending = Math.max(peakLimiterPending, limiterPending.length);

    for (let i = 0; i < limiters.length; i += 1) {
      const count = limiters[i].countAt(now);
      const pct = windows[i].limit > 0 ? (100 * count) / windows[i].limit : 0;
      windowSeries[i].utilizationPct.push(clamp(pct, 0, 200));
    }

    timeline.push({
      tSec: now / 1000,
      active: inflight.length,
      queued: queue.length,
      limiterPending: limiterPending.length,
      arrivalsPerSec: Math.round((arrivals * 1000) / stepMs),
      acceptedPerSec: Math.round((stepAccepted * 1000) / stepMs),
      r429PerSec: Math.round((step429 * 1000) / stepMs)
    });
  }

  latencies.sort((a, b) => a - b);
  limiterLatencies.sort((a, b) => a - b);
  const avgLatency = totalServed ? sumLatency / totalServed : 0;
  const avgQueueDelay = totalServed ? sumQueueDelay / totalServed : 0;
  const avgLimiterLatency = limiterLatencies.length
    ? limiterLatencies.reduce((acc, v) => acc + v, 0) / limiterLatencies.length
    : 0;

  return {
    totals: {
      arrived: totalArrived,
      served: totalServed,
      delayedServed: totalDelayedServed,
      droppedWait: totalDroppedWait,
      rate429: total429,
      servedPct: totalArrived ? (100 * totalServed) / totalArrived : 0,
      rate429Pct: totalArrived ? (100 * total429) / totalArrived : 0
    },
    latency: {
      avg: avgLatency,
      avgQueueDelay,
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      samples: latencies
    },
    limiterLatency: {
      avg: avgLimiterLatency,
      p95: percentile(limiterLatencies, 95),
      p99: percentile(limiterLatencies, 99),
      peakPending: peakLimiterPending
    },
    windowSeries,
    timeline
  };
}

function formatNum(n) {
  return Number.isFinite(n) ? n.toLocaleString() : "0";
}

function formatMs(v) {
  return `${Math.round(v)} ms`;
}

function renderKpis(result) {
  const { totals, latency, limiterLatency, windowSeries } = result;
  const mostBlocked = windowSeries
    .map((w) => ({ label: w.label, blocked: w.blocked }))
    .sort((a, b) => b.blocked - a.blocked)[0];

  const items = [
    ["Arrived", formatNum(totals.arrived)],
    ["Served", `${formatNum(totals.served)} (${totals.servedPct.toFixed(1)}%)`],
    ["Delayed Served", formatNum(totals.delayedServed)],
    ["429 Total", `${formatNum(totals.rate429)} (${totals.rate429Pct.toFixed(1)}%)`],
    ["Queue Timeout 429", formatNum(totals.droppedWait)],
    ["Most Blocking Window", mostBlocked ? `${mostBlocked.label} (${formatNum(mostBlocked.blocked)})` : "-"],
    ["Latency Avg", formatMs(latency.avg)],
    ["Latency p50", formatMs(latency.p50)],
    ["Latency p95", formatMs(latency.p95)],
    ["Latency p99", formatMs(latency.p99)],
    ["Avg Queue Delay", formatMs(latency.avgQueueDelay)],
    ["Limiter Lat Avg", formatMs(limiterLatency.avg)],
    ["Limiter Lat p95", formatMs(limiterLatency.p95)],
    ["Limiter Pending Peak", formatNum(limiterLatency.peakPending)]
  ];

  const kpiRoot = document.getElementById("kpis");
  kpiRoot.innerHTML = items.map(([name, value]) => (
    `<div class="kpi"><div class="name">${name}</div><div class="value">${value}</div></div>`
  )).join("");
}

function drawAxes(ctx, w, h, pad, maxY, maxXLabel, yLabel) {
  const innerW = w - 2 * pad;
  const innerH = h - 2 * pad;

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = "#e4ded0";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 5; i += 1) {
    const y = pad + (i * innerH) / 5;
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(w - pad, y);
    ctx.stroke();
  }

  ctx.fillStyle = "#5f6767";
  ctx.font = "12px IBM Plex Sans, sans-serif";
  ctx.fillText("0", 8, h - pad + 2);
  ctx.fillText(String(Math.round(maxY)), 4, pad + 4);
  ctx.fillText(maxXLabel, w - pad - 46, h - 8);
  if (yLabel) ctx.fillText(yLabel, 8, 12);
}

function drawLineChart(canvasId, series, maxYOverride, yLabel) {
  const canvas = document.getElementById(canvasId);
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  const pad = 32;
  const n = series.length ? series[0].values.length : 0;

  ctx.clearRect(0, 0, w, h);

  const maxY = maxYOverride || Math.max(1, ...series.flatMap((s) => s.values));
  drawAxes(ctx, w, h, pad, maxY, "time", yLabel);

  const innerW = w - 2 * pad;
  const innerH = h - 2 * pad;
  const toX = (i) => pad + (i / Math.max(1, n - 1)) * innerW;
  const toY = (v) => pad + innerH - (v / maxY) * innerH;

  for (const s of series) {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < s.values.length; i += 1) {
      const x = toX(i);
      const y = toY(s.values[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

function histogram(values, binCount) {
  if (!values.length) return { bins: [], max: 1 };
  const min = values[0];
  const max = values[values.length - 1];
  const width = Math.max(1, (max - min) / binCount);
  const bins = Array.from({ length: binCount }, (_, i) => ({
    from: min + i * width,
    to: min + (i + 1) * width,
    count: 0
  }));

  for (const v of values) {
    const idx = clamp(Math.floor((v - min) / width), 0, binCount - 1);
    bins[idx].count += 1;
  }

  return { bins, max: Math.max(1, ...bins.map((b) => b.count)) };
}

function drawLatencyHistogram(samples) {
  const canvas = document.getElementById("latencyChart");
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  const pad = 32;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);

  const { bins, max } = histogram(samples, 32);
  drawAxes(ctx, w, h, pad, max, "latency", "count");

  if (!bins.length) return;

  const innerW = w - 2 * pad;
  const innerH = h - 2 * pad;
  const barW = innerW / bins.length;

  ctx.fillStyle = "#0e7c66";
  bins.forEach((b, i) => {
    const x = pad + i * barW + 1;
    const bh = (b.count / max) * innerH;
    const y = pad + innerH - bh;
    ctx.fillRect(x, y, Math.max(1, barW - 2), bh);
  });
}

const COOKIE_NAME = "rl_sim_state";
const COOKIE_TTL_SEC = 60 * 60 * 24 * 180;
const CONTROL_IDS = [
  "durationSec",
  "stepMs",
  "rps",
  "burstiness",
  "maxConcurrent",
  "queueCapacity",
  "maxQueueWaitMs",
  "limiterType",
  "latencyDist",
  "latA",
  "latB",
  "rlLatencyDist",
  "rlLatA",
  "rlLatB"
];

function setCookie(name, value, maxAgeSec) {
  document.cookie = `${name}=${encodeURIComponent(value)}; max-age=${maxAgeSec}; path=/; SameSite=Lax`;
}

function getCookie(name) {
  const prefix = `${name}=`;
  const parts = document.cookie.split("; ");
  for (const part of parts) {
    if (part.startsWith(prefix)) {
      return decodeURIComponent(part.slice(prefix.length));
    }
  }
  return null;
}

function loadStateFromCookie() {
  const raw = getCookie(COOKIE_NAME);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getUiState() {
  const controls = {};
  for (const id of CONTROL_IDS) {
    const el = document.getElementById(id);
    if (el) controls[id] = el.value;
  }
  return {
    controls,
    windows: readWindows(),
    visibility: Object.fromEntries(seriesVisibility.entries())
  };
}

function saveStateToCookie() {
  const state = getUiState();
  setCookie(COOKIE_NAME, JSON.stringify(state), COOKIE_TTL_SEC);
}

function applyStateToUi(saved) {
  if (!saved) return;

  if (saved.controls) {
    for (const id of CONTROL_IDS) {
      const el = document.getElementById(id);
      if (el && saved.controls[id] !== undefined) {
        el.value = String(saved.controls[id]);
      }
    }
  }

  if (saved.windows && Array.isArray(saved.windows) && saved.windows.length > 0) {
    const rows = document.getElementById("windowRows");
    rows.innerHTML = "";
    for (const w of saved.windows) {
      addWindowRow(w.windowMs, w.limit);
    }
  }

  if (saved.visibility && typeof saved.visibility === "object") {
    for (const [key, val] of Object.entries(saved.visibility)) {
      seriesVisibility.set(key, Boolean(val));
    }
  }
}

const seriesVisibility = new Map();

function colorForWindowSeries(i) {
  const colors = ["#2f76b7", "#b3541e", "#268f6b", "#7d5ab7", "#bf3f58", "#4a8a34"];
  return colors[i % colors.length];
}

function buildMergedSeries(result) {
  const base = [
    { key: "active", label: "Active", color: "#1f5f99", values: result.timeline.map((p) => p.active) },
    { key: "queue", label: "Queue", color: "#9b6b30", values: result.timeline.map((p) => p.queued) },
    { key: "accepted", label: "Accepted/s", color: "#0e7c66", values: result.timeline.map((p) => p.acceptedPerSec) },
    { key: "r429", label: "429/s", color: "#b14a2f", values: result.timeline.map((p) => p.r429PerSec) },
    { key: "arrivals", label: "Arrivals/s", color: "#6f4db8", values: result.timeline.map((p) => p.arrivalsPerSec) },
    { key: "rlPending", label: "Limiter Pending", color: "#286f6d", values: result.timeline.map((p) => p.limiterPending) }
  ];
  const windows = result.windowSeries.map((w, i) => ({
    key: `window_${i}`,
    label: `${w.label} util%`,
    color: colorForWindowSeries(i),
    values: w.utilizationPct
  }));
  return [...base, ...windows];
}

function renderSeriesToggles(series) {
  const root = document.getElementById("seriesToggles");
  root.innerHTML = "";

  for (const s of series) {
    if (!seriesVisibility.has(s.key)) seriesVisibility.set(s.key, true);
    const id = `toggle_${s.key}`;
    const wrapper = document.createElement("label");
    wrapper.innerHTML = `
      <input id="${id}" type="checkbox" ${seriesVisibility.get(s.key) ? "checked" : ""} />
      <span>${s.label}</span>
    `;
    wrapper.style.setProperty("--legend-color", s.color);
    wrapper.querySelector("span").style.borderBottom = `2px solid ${s.color}`;
    wrapper.querySelector("input").addEventListener("change", (e) => {
      seriesVisibility.set(s.key, e.target.checked);
      const visible = series.filter((x) => seriesVisibility.get(x.key));
      drawLineChart("mergedChart", visible.length ? visible : [series[0]], null, "count/rate/util%");
      saveStateToCookie();
    });
    root.appendChild(wrapper);
  }
}

function addWindowRow(windowMs, limit) {
  const row = document.createElement("div");
  row.className = "window-row";
  row.innerHTML = `
    <label>Window (ms)
      <input type="number" class="win-ms" min="1" step="1" value="${windowMs}" />
    </label>
    <label>Limit
      <input type="number" class="win-limit" min="1" step="1" value="${limit}" />
    </label>
    <button type="button" class="remove-window">Remove</button>
  `;
  row.querySelector(".remove-window").addEventListener("click", () => {
    row.remove();
    saveStateToCookie();
  });
  row.querySelector(".win-ms").addEventListener("input", saveStateToCookie);
  row.querySelector(".win-limit").addEventListener("input", saveStateToCookie);
  document.getElementById("windowRows").appendChild(row);
}

function readWindows() {
  const rows = Array.from(document.querySelectorAll(".window-row"));
  const windows = rows.map((row) => ({
    windowMs: clamp(Number(row.querySelector(".win-ms").value), 1, 3600000),
    limit: clamp(Number(row.querySelector(".win-limit").value), 1, 10000000)
  }));
  const valid = windows.filter((w) => Number.isFinite(w.windowMs) && Number.isFinite(w.limit) && w.windowMs > 0 && w.limit > 0);
  return valid.length ? valid : [{ windowMs: 1000, limit: 50 }];
}

function readConfig() {
  const getNum = (id) => Number(document.getElementById(id).value);
  return {
    durationSec: clamp(getNum("durationSec"), 1, 3600),
    stepMs: clamp(getNum("stepMs"), 10, 2000),
    rps: clamp(getNum("rps"), 0, 200000),
    burstiness: clamp(getNum("burstiness"), 0, 1),
    maxConcurrent: clamp(getNum("maxConcurrent"), 1, 100000),
    queueCapacity: clamp(getNum("queueCapacity"), 0, 1000000),
    maxQueueWaitMs: clamp(getNum("maxQueueWaitMs"), 0, 600000),
    limiterType: document.getElementById("limiterType").value,
    windows: readWindows(),
    rlLatencyDist: document.getElementById("rlLatencyDist").value,
    rlLatA: getNum("rlLatA"),
    rlLatB: getNum("rlLatB"),
    latencyDist: document.getElementById("latencyDist").value,
    latA: getNum("latA"),
    latB: getNum("latB")
  };
}

function runAndRender() {
  const cfg = readConfig();
  const result = runSimulation(cfg);
  renderKpis(result);

  const merged = buildMergedSeries(result);
  renderSeriesToggles(merged);
  const visible = merged.filter((s) => seriesVisibility.get(s.key));
  drawLineChart("mergedChart", visible.length ? visible : [merged[0]], null, "count/rate/util%");
  drawLatencyHistogram(result.latency.samples);
  saveStateToCookie();
}

function boot() {
  document.getElementById("addWindowBtn").addEventListener("click", () => {
    addWindowRow(1000, 60);
    saveStateToCookie();
  });
  document.getElementById("runBtn").addEventListener("click", runAndRender);
  for (const id of CONTROL_IDS) {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", saveStateToCookie);
    if (el) el.addEventListener("change", saveStateToCookie);
  }

  addWindowRow(1000, 60);
  addWindowRow(10000, 500);
  addWindowRow(60000, 2000);
  applyStateToUi(loadStateFromCookie());
  runAndRender();
}

boot();
