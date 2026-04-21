const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.join(__dirname, "..", "simulation.js"), "utf8");
const context = { Math, console };
vm.createContext(context);
vm.runInContext(`${source}\nthis.runSimulation = runSimulation;`, context);

function run(overrides = {}) {
  return context.runSimulation({
    durationSec: 10,
    stepMs: 100,
    rps: 20,
    burstiness: 0,
    trafficNoise: false,
    maxConcurrent: 100,
    queueCapacity: 1000,
    maxQueueWaitMs: 5000,
    limiterType: "sliding",
    windows: [{ windowMs: 1000, limit: 100 }],
    rlLatencyDist: "constant",
    rlLatA: 1,
    rlLatB: 0,
    latencyDist: "constant",
    latA: 10,
    latB: 0,
    depMaxConcurrent: 100,
    depQueueCapacity: 1000,
    depMaxQueueWaitMs: 5000,
    depLatencyDist: "constant",
    depLatA: 10,
    depLatB: 0,
    ...overrides
  });
}

function assertLatencyAccounting(result) {
  assert.strictEqual(result.latency.byStatus.s200.length, result.totals.served, "HTTP 200 latency samples must match served count");
  assert.strictEqual(result.latency.byStatus.s429.length, result.totals.rate429, "HTTP 429 latency samples must match 429 count");
  assert.strictEqual(result.latency.byStatus.s503.length, result.totals.rate503, "HTTP 503 latency samples must match 503 count");
}

function assertNoNaN(result) {
  for (const point of result.timeline) {
    assert(Number.isFinite(point.arrivalsPerSec), "arrivalsPerSec must be finite");
    assert(Number.isFinite(point.acceptedPerSec), "acceptedPerSec must be finite");
    assert(Number.isFinite(point.r429PerSec), "r429PerSec must be finite");
    assert(Number.isFinite(point.r503PerSec), "r503PerSec must be finite");
  }
}

{
  const result = run({
    windows: [],
    maxConcurrent: 1,
    queueCapacity: 0,
    maxQueueWaitMs: 1,
    latencyDist: "constant",
    latA: 1000
  });
  assert.strictEqual(result.totals.rate429, 0, "no limiter rules must not produce 429s");
  assert(result.totals.rate503 > 0, "backend saturation should produce 503s");
  assert(result.totals.droppedFull > 0, "queue-full drops should be counted");
  assertNoNaN(result);
  assertLatencyAccounting(result);
}

{
  const result = run({
    windows: [{ windowMs: 1000, limit: 1 }],
    maxConcurrent: 1000,
    queueCapacity: 1000,
    latencyDist: "constant",
    latA: 1
  });
  assert(result.totals.rate429 > 0, "restrictive limiter should produce 429s");
  assert.strictEqual(result.totals.rate503, 0, "ample backend should not produce 503s");
  assertNoNaN(result);
  assertLatencyAccounting(result);
}

{
  const result = run({
    windows: [],
    maxConcurrent: 1,
    queueCapacity: 1000,
    maxQueueWaitMs: 100,
    latencyDist: "constant",
    latA: 1000
  });
  assert.strictEqual(result.totals.rate429, 0, "queue timeout without limiter must not be 429");
  assert(result.totals.droppedWait > 0, "queue timeout should be counted");
  assert(result.totals.rate503 >= result.totals.droppedWait, "queue timeout should contribute to 503");
  assertNoNaN(result);
  assertLatencyAccounting(result);
}


{
  const openLoop = run({
    windows: [],
    rps: 120,
    maxConcurrent: 40,
    queueCapacity: 200,
    maxQueueWaitMs: 1500,
    latencyDist: "constant",
    latA: 40,
    depMaxConcurrent: 2,
    depQueueCapacity: 10,
    depMaxQueueWaitMs: 100,
    depLatencyDist: "constant",
    depLatA: 300
  });
  const protectedFlow = run({
    windows: [{ windowMs: 1000, limit: 20 }],
    rps: 120,
    maxConcurrent: 40,
    queueCapacity: 200,
    maxQueueWaitMs: 1500,
    latencyDist: "constant",
    latA: 40,
    depMaxConcurrent: 2,
    depQueueCapacity: 10,
    depMaxQueueWaitMs: 100,
    depLatencyDist: "constant",
    depLatA: 300
  });
  assert(protectedFlow.totals.rate429 > 0, "limiter should actively reject in the protected scenario");
  assert(protectedFlow.totals.rate503 < openLoop.totals.rate503, "limiter should reduce downstream 503s");
  assert(protectedFlow.queues.peakDepQueue <= openLoop.queues.peakDepQueue, "limiter should not worsen dependency queue pressure");
  assertNoNaN(protectedFlow);
  assertLatencyAccounting(protectedFlow);
  assertLatencyAccounting(openLoop);
}



{
  const values = Array.from({ length: 12 }, (_, i) => context.expectedTrafficRpsAt(i, 11, 30, 0));
  assert(values.every((value) => value === 30), "burst factor 0 must produce a flat expected traffic shape at target RPS");
}


{
  const result = run({
    durationSec: 2,
    stepMs: 100,
    rps: 30,
    burstiness: 0,
    trafficNoise: false,
    windows: [{ windowMs: 1000, limit: 1000 }],
    maxConcurrent: 1000,
    queueCapacity: 1000,
    latencyDist: "constant",
    latA: 1
  });
  const offered = result.timeline.map((point) => point.arrivalsPerSec);
  assert(offered.every((value) => value === 30), "with traffic noise disabled, flat 30 RPS should produce flat observed arrivals at 30/s");
}

{
  const result = run({
    durationSec: 4,
    stepMs: 100,
    rps: 30,
    burstiness: 0,
    trafficNoise: true,
    windows: [{ windowMs: 1000, limit: 1000 }],
    maxConcurrent: 1000,
    queueCapacity: 1000,
    latencyDist: "constant",
    latA: 1
  });
  const offered = result.timeline.map((point) => point.arrivalsPerSec);
  assert(offered.some((value) => value !== 30), "with traffic noise enabled, observed arrivals should vary around the baseline");
  assert(result.timeline.every((point) => point.expectedArrivalsPerSec === 30), "traffic noise must not change the expected traffic shape");
}

{
  const values = Array.from({ length: 48 }, (_, i) => context.expectedTrafficRpsAt(i, 47, 30, 0.5));
  assert(values.some((value) => value > 30), "positive burst factor should create peaks above baseline RPS");
  assert(values.some((value) => value < 30), "positive burst factor should create troughs below baseline RPS");
  assert(values.every((value) => value >= 0), "expected traffic shape must not go negative");
}


{
  const result = run({
    durationSec: 2,
    stepMs: 100,
    rps: 30,
    burstiness: 0,
    trafficNoise: false,
    rlLatencyDist: "constant",
    rlLatA: 1,
    rlLatB: 0,
    windows: [{ windowMs: 1000, limit: 1000 }],
    maxConcurrent: 1000,
    queueCapacity: 1000,
    latencyDist: "constant",
    latA: 1,
    depMaxConcurrent: 1000,
    depQueueCapacity: 1000,
    depLatencyDist: "constant",
    depLatA: 1,
    depLatB: 0
  });
  const expected = result.timeline.slice(1).map((point) => point.expectedArrivalsPerSec);
  const accepted = result.timeline.slice(1).map((point) => point.acceptedPerSec);
  assert(expected.every((value) => value === 30), "healthy flat traffic should keep expected offered traffic flat");
  assert(accepted.every((value) => value === 30), "healthy low-latency path should admit the same flat traffic rate without an artificial bucket lag");
}

{
  const result = run({
    windows: [{ windowMs: 1000, limit: 1000 }],
    maxConcurrent: 1000,
    queueCapacity: 1000,
    latencyDist: "constant",
    latA: 1
  });
  assert(result.totals.served > 0, "healthy config should serve traffic");
  assert.strictEqual(result.totals.rate429, 0, "healthy config should not hit limiter");
  assert.strictEqual(result.totals.rate503, 0, "healthy config should not hit backend drops");
  assertNoNaN(result);
  assertLatencyAccounting(result);
}

console.log("simulation sanity tests passed");
