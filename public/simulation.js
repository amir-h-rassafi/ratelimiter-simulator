function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function normal(mean, std) {
  const u1 = Math.random() || 1e-7;
  const u2 = Math.random() || 1e-7;
  return mean + Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * std;
}

function poisson(lambda) {
  if (lambda <= 0) return 0;
  if (lambda > 50) return Math.max(0, Math.round(normal(lambda, Math.sqrt(lambda))));
  const l = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do { k += 1; p *= Math.random(); } while (p > l);
  return k - 1;
}

const LATENCY_SAMPLERS = {
  constant: (a) => Math.max(1, a),
  uniform: (a, b) => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    return Math.max(1, lo + Math.random() * (hi - lo));
  },
  normal: (a, b) => Math.max(1, normal(a, Math.max(1, b))),
  lognormal: (a, b) => Math.max(1, Math.exp(normal(a, Math.max(0.01, b)))),
  exponential: (a) => Math.max(1, -Math.log(1 - Math.random()) * Math.max(1, a))
};

function sampleLatencyMs(dist, a, b) {
  return (LATENCY_SAMPLERS[dist] || LATENCY_SAMPLERS.constant)(a, b);
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = clamp(Math.ceil((p / 100) * sorted.length) - 1, 0, sorted.length - 1);
  return sorted[idx];
}

function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function trafficWaveMultiplier(step, steps, burstiness) {
  const phase = (2 * Math.PI * step) / Math.max(10, steps / 2);
  return Math.max(0, 1 + burstiness * Math.sin(phase));
}

function expectedTrafficRpsAt(step, steps, rps, burstiness) {
  return Math.max(0, rps * trafficWaveMultiplier(step, steps, burstiness));
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
  canAllow(tMs) { this.refresh(tMs); return this.count < this.limit; }
  commit(tMs) { this.refresh(tMs); this.count += 1; }
  countAt(tMs) { this.refresh(tMs); return this.count; }
}

// Sliding window keeps events sorted ascending by timestamp so evict is a
// monotonic prefix scan. Commits use binary insertion so the invariant
// survives any out-of-order arrivals from the caller.
class SlidingWindowLimiter {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.events = [];
  }
  evict(tMs) {
    const floor = tMs - this.windowMs;
    let drop = 0;
    while (drop < this.events.length && this.events[drop] <= floor) drop += 1;
    if (drop) this.events.splice(0, drop);
  }
  canAllow(tMs) { this.evict(tMs); return this.events.length < this.limit; }
  commit(tMs) {
    let lo = 0;
    let hi = this.events.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.events[mid] <= tMs) lo = mid + 1; else hi = mid;
    }
    this.events.splice(lo, 0, tMs);
  }
  countAt(tMs) { this.evict(tMs); return this.events.length; }
}

function createLimiter(type, limit, windowMs) {
  return type === "sliding"
    ? new SlidingWindowLimiter(limit, windowMs)
    : new FixedWindowLimiter(limit, windowMs);
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
    durationSec, stepMs, rps, burstiness, trafficNoise = false,
    maxConcurrent, queueCapacity, maxQueueWaitMs,
    limiterType, windows,
    rlLatencyDist, rlLatA, rlLatB,
    latencyDist, latA, latB,
    depMaxConcurrent, depQueueCapacity, depMaxQueueWaitMs,
    depLatencyDist, depLatA, depLatB
  } = cfg;

  const limiters = windows.map((w) => createLimiter(limiterType, w.limit, w.windowMs));
  const windowSeries = makeWindowSeries(windows);
  const steps = Math.floor((durationSec * 1000) / stepMs);

  const appInflight = [];
  const appQueue = [];
  const depInflight = [];
  const depQueue = [];
  const limiterPending = [];
  const limiterLatencies = [];
  const latencyByStatus = { s200: [], s429: [], s503: [] };
  const timeline = [];

  const totals = {
    arrived: 0, enteredApp: 0, enteredDependency: 0, served: 0, delayedServed: 0,
    rate429: 0, rate503: 0,
    appDroppedFull: 0, appDroppedWait: 0,
    depDroppedFull: 0, depDroppedWait: 0
  };
  const peaks = { limiterPending: 0, appQueue: 0, depQueue: 0, appInflight: 0, depInflight: 0 };

  let sumLatency = 0;
  let sumQueueDelay = 0;
  let trafficArrivalAccumulator = 0;

  // Admit to app. `now` is decisionTime — the moment the request leaves the
  // limiter and either starts processing or joins the app queue.
  function admitApp(now, req) {
    if (appInflight.length < maxConcurrent) {
      const serviceMs = sampleLatencyMs(latencyDist, latA, latB);
      appInflight.push({
        endMs: now + serviceMs,
        appServiceMs: serviceMs,
        limiterWaitMs: req.limiterWaitMs,
        appQueueWaitMs: 0
      });
      totals.enteredApp += 1;
      return true;
    }
    if (appQueue.length < queueCapacity) {
      appQueue.push({ ...req, queuedAtMs: now });
      totals.enteredApp += 1;
      return true;
    }
    totals.rate503 += 1;
    totals.appDroppedFull += 1;
    latencyByStatus.s503.push(req.limiterWaitMs);
    return false;
  }

  function admitDependency(now, req) {
    if (depInflight.length < depMaxConcurrent) {
      const serviceMs = sampleLatencyMs(depLatencyDist, depLatA, depLatB);
      depInflight.push({
        endMs: now + serviceMs,
        depServiceMs: serviceMs,
        limiterWaitMs: req.limiterWaitMs,
        appQueueWaitMs: req.appQueueWaitMs,
        appServiceMs: req.appServiceMs,
        depQueueWaitMs: 0
      });
      totals.enteredDependency += 1;
      return true;
    }
    if (depQueue.length < depQueueCapacity) {
      depQueue.push({ ...req, queuedAtMs: now });
      totals.enteredDependency += 1;
      return true;
    }
    totals.rate503 += 1;
    totals.depDroppedFull += 1;
    latencyByStatus.s503.push(req.limiterWaitMs + req.appQueueWaitMs + req.appServiceMs);
    return false;
  }

  for (let step = 0; step <= steps; step += 1) {
    const now = step * stepMs;
    const bucketEnd = now + stepMs;
    let step429 = 0;
    let step503 = 0;
    let stepAccepted = 0;

    // 1. Complete dependency inflight → served
    for (let i = depInflight.length - 1; i >= 0; i -= 1) {
      if (depInflight[i].endMs > now) continue;
      const r = depInflight[i];
      depInflight.splice(i, 1);
      totals.served += 1;
      const queueDelay = r.appQueueWaitMs + r.depQueueWaitMs;
      if (queueDelay > 0) totals.delayedServed += 1;
      const totalLat = r.limiterWaitMs + queueDelay + r.appServiceMs + r.depServiceMs;
      latencyByStatus.s200.push(totalLat);
      sumLatency += totalLat;
      sumQueueDelay += queueDelay;
    }

    // 2. Expire dep queue timeouts
    for (let i = depQueue.length - 1; i >= 0; i -= 1) {
      const r = depQueue[i];
      if (now - r.queuedAtMs < depMaxQueueWaitMs) continue;
      depQueue.splice(i, 1);
      totals.rate503 += 1;
      totals.depDroppedWait += 1;
      step503 += 1;
      latencyByStatus.s503.push(r.limiterWaitMs + r.appQueueWaitMs + r.appServiceMs + (now - r.queuedAtMs));
    }

    // 3. Promote dep queue → dep inflight
    while (depQueue.length && depInflight.length < depMaxConcurrent) {
      const r = depQueue.shift();
      const serviceMs = sampleLatencyMs(depLatencyDist, depLatA, depLatB);
      depInflight.push({
        endMs: now + serviceMs,
        depServiceMs: serviceMs,
        limiterWaitMs: r.limiterWaitMs,
        appQueueWaitMs: r.appQueueWaitMs,
        appServiceMs: r.appServiceMs,
        depQueueWaitMs: now - r.queuedAtMs
      });
    }

    // 4. Complete app inflight → try dependency admission
    for (let i = appInflight.length - 1; i >= 0; i -= 1) {
      if (appInflight[i].endMs > now) continue;
      const r = appInflight[i];
      appInflight.splice(i, 1);
      const entered = admitDependency(now, {
        limiterWaitMs: r.limiterWaitMs,
        appQueueWaitMs: r.appQueueWaitMs,
        appServiceMs: r.appServiceMs
      });
      if (!entered) step503 += 1;
    }

    // 5. Expire app queue timeouts (measured from queue entry, not arrival)
    for (let i = appQueue.length - 1; i >= 0; i -= 1) {
      const r = appQueue[i];
      if (now - r.queuedAtMs < maxQueueWaitMs) continue;
      appQueue.splice(i, 1);
      totals.rate503 += 1;
      totals.appDroppedWait += 1;
      step503 += 1;
      latencyByStatus.s503.push(r.limiterWaitMs + (now - r.queuedAtMs));
    }

    // 6. Promote app queue → app inflight
    while (appQueue.length && appInflight.length < maxConcurrent) {
      const r = appQueue.shift();
      const serviceMs = sampleLatencyMs(latencyDist, latA, latB);
      appInflight.push({
        endMs: now + serviceMs,
        appServiceMs: serviceMs,
        limiterWaitMs: r.limiterWaitMs,
        appQueueWaitMs: now - r.queuedAtMs
      });
    }

    // 7. Generate arrivals and enqueue limiter decisions
    const expectedRps = expectedTrafficRpsAt(step, steps, rps, burstiness);
    const expectedInStep = Math.max(0, (expectedRps * stepMs) / 1000);
    let arrivals;
    if (trafficNoise) {
      arrivals = poisson(expectedInStep);
    } else {
      trafficArrivalAccumulator += expectedInStep;
      arrivals = Math.floor(trafficArrivalAccumulator);
      trafficArrivalAccumulator -= arrivals;
    }
    for (let i = 0; i < arrivals; i += 1) {
      const decisionLatencyMs = sampleLatencyMs(rlLatencyDist, rlLatA, rlLatB);
      limiterPending.push({ decisionReadyMs: now + decisionLatencyMs, arrivalMs: now });
      limiterLatencies.push(decisionLatencyMs);
    }
    totals.arrived += arrivals;

    // 8. Process limiter decisions in chronological order. Sorting by
    // decisionReadyMs is what makes the sliding window correct under
    // jittered decision latencies.
    limiterPending.sort((a, b) => a.decisionReadyMs - b.decisionReadyMs);
    let readyCount = 0;
    while (readyCount < limiterPending.length && limiterPending[readyCount].decisionReadyMs <= bucketEnd) {
      readyCount += 1;
    }
    const ready = limiterPending.splice(0, readyCount);
    for (const pending of ready) {
      const decisionTime = pending.decisionReadyMs;
      const blockedIdx = limiters.findIndex((lim) => !lim.canAllow(decisionTime));
      if (blockedIdx >= 0) {
        totals.rate429 += 1;
        step429 += 1;
        windowSeries[blockedIdx].blocked += 1;
        latencyByStatus.s429.push(decisionTime - pending.arrivalMs);
        continue;
      }
      for (const lim of limiters) lim.commit(decisionTime);
      stepAccepted += 1;
      const entered = admitApp(decisionTime, { limiterWaitMs: decisionTime - pending.arrivalMs });
      if (!entered) step503 += 1;
    }

    peaks.limiterPending = Math.max(peaks.limiterPending, limiterPending.length);
    peaks.appQueue = Math.max(peaks.appQueue, appQueue.length);
    peaks.depQueue = Math.max(peaks.depQueue, depQueue.length);
    peaks.appInflight = Math.max(peaks.appInflight, appInflight.length);
    peaks.depInflight = Math.max(peaks.depInflight, depInflight.length);

    for (let i = 0; i < limiters.length; i += 1) {
      const count = limiters[i].countAt(now);
      const pct = windows[i].limit > 0 ? (100 * count) / windows[i].limit : 0;
      windowSeries[i].utilizationPct.push(clamp(pct, 0, 200));
    }

    const perSec = 1000 / stepMs;
    timeline.push({
      tSec: now / 1000,
      active: appInflight.length,
      queued: appQueue.length,
      depActive: depInflight.length,
      depQueued: depQueue.length,
      limiterPending: limiterPending.length,
      expectedArrivalsPerSec: Math.round(expectedRps),
      arrivalsPerSec: Math.round(arrivals * perSec),
      acceptedPerSec: Math.round(stepAccepted * perSec),
      r429PerSec: Math.round(step429 * perSec),
      r503PerSec: Math.round(step503 * perSec)
    });
  }

  const sortedLatencies = [...latencyByStatus.s200].sort((a, b) => a - b);
  latencyByStatus.s429.sort((a, b) => a - b);
  latencyByStatus.s503.sort((a, b) => a - b);
  const sortedLimiterLatencies = [...limiterLatencies].sort((a, b) => a - b);

  const pct = (num, den) => (den ? (100 * num) / den : 0);
  return {
    totals: {
      ...totals,
      // Rolled-up aliases kept for back-compat; prefer per-stage fields above.
      droppedFull: totals.appDroppedFull + totals.depDroppedFull,
      droppedWait: totals.appDroppedWait + totals.depDroppedWait,
      servedPct: pct(totals.served, totals.arrived),
      rate503Pct: pct(totals.rate503, totals.arrived),
      rate429Pct: pct(totals.rate429, totals.arrived)
    },
    latency: {
      avg: totals.served ? sumLatency / totals.served : 0,
      avgQueueDelay: totals.served ? sumQueueDelay / totals.served : 0,
      p50: percentile(sortedLatencies, 50),
      p95: percentile(sortedLatencies, 95),
      p99: percentile(sortedLatencies, 99),
      samples: sortedLatencies,
      byStatus: latencyByStatus
    },
    limiterLatency: {
      avg: mean(sortedLimiterLatencies),
      p95: percentile(sortedLimiterLatencies, 95),
      p99: percentile(sortedLimiterLatencies, 99),
      peakPending: peaks.limiterPending
    },
    queues: {
      peakLimiterPending: peaks.limiterPending,
      peakAppQueue: peaks.appQueue,
      peakDepQueue: peaks.depQueue,
      peakAppInflight: peaks.appInflight,
      peakDepInflight: peaks.depInflight
    },
    windowSeries,
    timeline
  };
}


const simulationApi = {
  clamp,
  normal,
  poisson,
  sampleLatencyMs,
  percentile,
  FixedWindowLimiter,
  SlidingWindowLimiter,
  createLimiter,
  makeWindowSeries,
  trafficWaveMultiplier,
  expectedTrafficRpsAt,
  runSimulation
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = simulationApi;
}

if (typeof window !== "undefined") {
  Object.assign(window, simulationApi);
}
