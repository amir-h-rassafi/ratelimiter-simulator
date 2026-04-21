const assert = require("assert");
const {
  defaultSimulationConfig,
  reviewComponentPath,
  compareScenarios
} = require("../mcp/review.js");

{
  const defaults = defaultSimulationConfig();
  assert.strictEqual(defaults.limiterType, "sliding");
  assert(Array.isArray(defaults.windows));
}

{
  const review = reviewComponentPath({
    traffic: { rps: 120, burstiness: 0.2 },
    components: [
      { kind: "waf", name: "WAF", latencyMs: 3, jitterMs: 1, rateLimiter: { type: "sliding", windows: [{ windowMs: 1000, limit: 40 }] } },
      { kind: "api_gateway", name: "Gateway", latencyMs: 5, jitterMs: 2 },
      { kind: "app", name: "App", latencyMs: 80, jitterMs: 10, maxConcurrent: 20, queueCapacity: 200, timeoutMs: 1000 },
      { kind: "db", name: "DB", latencyMs: 240, jitterMs: 30, maxConcurrent: 4, queueCapacity: 40, timeoutMs: 300 }
    ]
  });
  assert.strictEqual(review.normalizedConfig.rlLatA, 8);
  assert.strictEqual(review.normalizedConfig.maxConcurrent, 20);
  assert.strictEqual(review.normalizedConfig.depMaxConcurrent, 4);
  assert(review.summary.arrived > 0);
  assert(review.assumptions.length >= 4);
}

{
  const comparison = compareScenarios({
    base: { windows: [], rps: 120, depMaxConcurrent: 2, depQueueCapacity: 10, depMaxQueueWaitMs: 100, depLatA: 300, depLatB: 0, depLatencyDist: "constant", latencyDist: "constant", latA: 40, latB: 0 },
    candidate: { windows: [{ windowMs: 1000, limit: 20 }], limiterType: "sliding", rps: 120, depMaxConcurrent: 2, depQueueCapacity: 10, depMaxQueueWaitMs: 100, depLatA: 300, depLatB: 0, depLatencyDist: "constant", latencyDist: "constant", latA: 40, latB: 0 }
  });
  assert(comparison.candidate.rate429 > comparison.base.rate429);
  assert(comparison.candidate.rate503 <= comparison.base.rate503);
}

console.log("mcp review tests passed");
