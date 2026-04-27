function formatNum(n) {
  return Number.isFinite(n) ? n.toLocaleString() : "0";
}

function formatMs(v) {
  return `${Math.round(v)} ms`;
}

function buildProtectionSummary(result, baseline) {
  const base = baseline || result;
  const avoided503 = Math.max(0, base.totals.rate503 - result.totals.rate503);
  const avoidedAppLoad = Math.max(0, base.totals.enteredApp - result.totals.enteredApp);
  const avoidedDependencyLoad = Math.max(0, base.totals.enteredDependency - result.totals.enteredDependency);
  const failureReductionPct = base.totals.rate503 > 0 ? (100 * avoided503) / base.totals.rate503 : 0;
  return {
    avoided503,
    avoidedAppLoad,
    avoidedDependencyLoad,
    failureReductionPct
  };
}

function renderKpis(result, baseline) {
  const { totals, latency, limiterLatency, windowSeries } = result;
  const protection = buildProtectionSummary(result, baseline);
  const mostBlocked = windowSeries
    .map((w) => ({ label: w.label, blocked: w.blocked }))
    .sort((a, b) => b.blocked - a.blocked)[0];

  const items = [
    { name: "Arrived", value: formatNum(totals.arrived), kind: "neutral" },
    { name: "Served", value: `${formatNum(totals.served)} (${totals.servedPct.toFixed(1)}%)`, kind: "served" },
    { name: "Blocked by Limiter", value: `${formatNum(totals.rate429)} (${totals.rate429Pct.toFixed(1)}%)`, kind: "danger" },
    { name: "503 Unavailable", value: `${formatNum(totals.rate503)} (${totals.rate503Pct.toFixed(1)}%)`, kind: "danger" },
    { name: "503 Avoided", value: formatNum(protection.avoided503), kind: "served" },
    { name: "Dependency Load Avoided", value: formatNum(protection.avoidedDependencyLoad), kind: "served" },
    { name: "Failure Reduction", value: `${protection.failureReductionPct.toFixed(1)}%`, kind: "served" },
    { name: "App Pending Peak", value: formatNum(result.queues.peakAppQueue), kind: "queue" },
    { name: "Dependency Active Peak", value: formatNum(result.queues.peakDepInflight), kind: "queue" },
    { name: "Limiter Rule", value: mostBlocked ? `${mostBlocked.label} (${formatNum(mostBlocked.blocked)})` : "No rules", kind: "queue" },
    { name: "Latency p95", value: formatMs(latency.p95), kind: "latency" },
    { name: "Avg Queue Delay", value: formatMs(latency.avgQueueDelay), kind: "queue" },
    { name: "Limiter Lat p95", value: formatMs(limiterLatency.p95), kind: "latency" }
  ];

  const kpiRoot = document.getElementById("kpis");
  kpiRoot.innerHTML = items.map(({ name, value, kind }) => (
    `<div class="kpi" data-kind="${kind}"><div class="name">${name}</div><div class="value">${value}</div></div>`
  )).join("");
}

function pressurePct(value, capacity) {
  if (!capacity) return value > 0 ? 100 : 0;
  return Math.max(0, Math.min(100, (100 * value) / capacity));
}

function stageState({ hardFailure = 0, warning = false, activePct = 0, queuePct = 0 }) {
  if (hardFailure > 0) return "bad";
  if (warning || activePct >= 90 || queuePct >= 70) return "warn";
  return "ok";
}

function stageLabel(state) {
  if (state === "info") return "not modeled";
  if (state === "bad") return "failing";
  if (state === "warn") return "pressure";
  return "stable";
}

function pressureLevel(pct, state) {
  if (state === "bad") return { label: "critical", kind: "bad" };
  if (pct >= 85) return { label: "high", kind: "warn" };
  if (pct >= 55) return { label: "medium", kind: "warn" };
  return { label: "low", kind: "ok" };
}

function buildCauseAnalysis(result, cfg, values) {
  const {
    wsDropped,
    limiterDropped,
    appDropped,
    depDropped,
    wsActivePct,
    wsQueuePct,
    limiterActivePct,
    limiterQueuePct,
    appActivePct,
    appQueuePct,
    depActivePct
  } = values;
  const typicalPathMs = result.limiterLatency.p95 + cfg.latA + cfg.depLatA;

  if (result.totals.wsDroppedTimeout > 0) {
    const slowest = [
      { name: "limiter decision", ms: result.limiterLatency.p95 },
      { name: "service latency", ms: cfg.latA },
      { name: "downstream latency", ms: cfg.depLatA }
    ].sort((a, b) => b.ms - a.ms)[0];
    return {
      kind: "bad",
      title: "Wrong decision: request deadline is too small",
      detail: `${formatMs(cfg.wsRequestTimeoutMs)} webserver timeout is below the current p95 path budget of about ${formatMs(typicalPathMs)}. The largest contributor is ${slowest.name}.`,
      action: "Increase the webserver request timeout or reduce the slow stage before treating this as app failure."
    };
  }

  if (limiterDropped > 0) {
    const mode = cfg.rlFailureMode === "bypass" ? "bypass" : "fail request";
    return {
      kind: "bad",
      title: "Wrong decision: limiter capacity is too tight",
      detail: `Limiter pressure reached ${Math.round(Math.max(limiterActivePct, limiterQueuePct))}% and the failure mode is ${mode}. This makes limiter overload visible before app admission.`,
      action: cfg.rlFailureMode === "bypass"
        ? "Raise limiter capacity or keep bypass only if the service has spare capacity."
        : "Raise limiter capacity/queue timeout or intentionally accept fail-closed 503 behavior."
    };
  }

  if (result.totals.limiterBypassed > 0) {
    return {
      kind: "warn",
      title: "Decision tradeoff: limiter is bypassing",
      detail: `${formatNum(result.totals.limiterBypassed)} requests skipped policy because limiter capacity was exhausted. That protects availability but moves pressure to Service and Downstream.`,
      action: "Use this only when backend capacity is known to absorb the bypassed traffic."
    };
  }

  if (appDropped > 0) {
    return {
      kind: "bad",
      title: "Wrong decision: service capacity contract is too small",
      detail: `Service active/pending pressure reached ${Math.round(Math.max(appActivePct, appQueuePct))}%, causing ${formatNum(appDropped)} service-side 503s.`,
      action: "Reduce admitted traffic, increase service capacity, or tune service pending timeout/capacity."
    };
  }

  if (depDropped > 0) {
    return {
      kind: "bad",
      title: "Wrong decision: downstream is the tightest capacity",
      detail: `Downstream active pressure reached ${Math.round(depActivePct)}%, causing ${formatNum(depDropped)} downstream 503s after the service tried to call it.`,
      action: "Lower the limiter threshold or increase downstream concurrency before raising service capacity."
    };
  }

  if (result.totals.rate429 > 0) {
    return {
      kind: "warn",
      title: "Limiter policy is the active decision",
      detail: `${formatNum(result.totals.rate429)} requests were rejected with 429. That is protecting ${formatNum(Math.max(0, result.totals.arrived - result.totals.enteredApp))} potential service admissions.`,
      action: "If this is an example of protection, keep it. If it is unexpected, raise the tightest limiter rule."
    };
  }

  const highest = Math.max(wsActivePct, wsQueuePct, limiterActivePct, limiterQueuePct, appActivePct, appQueuePct, depActivePct);
  return {
    kind: highest >= 70 ? "warn" : "ok",
    title: highest >= 70 ? "No failure yet, but pressure is building" : "No wrong decision detected",
    detail: highest >= 70
      ? `The highest component pressure is ${Math.round(highest)}%, but no 429/503 failure path has triggered yet.`
      : "The current run stays within the configured capacity and timeout contracts.",
    action: highest >= 70 ? "Watch the highest-pressure stage before increasing traffic." : "Use the controls to create pressure and compare which contract fails first."
  };
}

function renderStageCard(stage) {
  const level = pressureLevel(stage.meterPct, stage.state);
  return `
    <article class="pressure-stage" data-state="${stage.state}">
      <div class="pressure-stage-head">
        <span class="stage-dot" aria-hidden="true"></span>
        <div>
          <h3>${stage.name}</h3>
          <strong>${stageLabel(stage.state)}</strong>
          <p>${stage.caption}</p>
        </div>
      </div>
      <div class="stage-meter" aria-label="${stage.name} pressure">
        <span style="width: ${stage.meterPct}%"></span>
      </div>
      <div class="stage-pressure-level" data-kind="${level.kind}">
        <span>${level.label} pressure</span>
        <strong>${Math.round(stage.meterPct)}%</strong>
      </div>
      <dl>
        ${stage.metrics.map(({ name, value }) => `<div><dt>${name}</dt><dd>${value}</dd></div>`).join("")}
      </dl>
    </article>
  `;
}

function renderFlowEdge(label, value, kind = "neutral") {
  return `
    <div class="pressure-edge" data-kind="${kind}">
      <span>${label}</span>
      <strong>${value}</strong>
    </div>
  `;
}

function renderPressureMap(result, baseline, cfg) {
  const root = document.getElementById("pressureMap");
  if (!root) return;

  const protection = buildProtectionSummary(result, baseline);
  const wsDropped = result.totals.wsDroppedFull + result.totals.wsDroppedWait + result.totals.wsDroppedTimeout;
  const limiterDropped = result.totals.limiterDroppedFull + result.totals.limiterDroppedWait;
  const appDropped = result.totals.appDroppedFull + result.totals.appDroppedWait;
  const depDropped = result.totals.depDroppedFull;
  const wsActivePct = pressurePct(result.queues.peakWsActive, cfg.wsMaxConcurrent);
  const wsQueuePct = pressurePct(result.queues.peakWsQueue, cfg.wsQueueCapacity);
  const limiterActivePct = pressurePct(result.queues.peakLimiterInflight, cfg.rlMaxConcurrent);
  const limiterQueuePct = pressurePct(result.queues.peakLimiterQueue, cfg.rlQueueCapacity);
  const appActivePct = pressurePct(result.queues.peakAppInflight, cfg.maxConcurrent);
  const appQueuePct = pressurePct(result.queues.peakAppQueue, cfg.queueCapacity);
  const depActivePct = pressurePct(result.queues.peakDepInflight, cfg.depMaxConcurrent);
  const limiterPendingWarn = result.queues.peakLimiterPending > 0 || result.limiterLatency.p95 > Math.max(50, cfg.latA * 0.25);
  const limiterRuleWarn = result.totals.rate429 > 0;
  const analysis = buildCauseAnalysis(result, cfg, {
    wsDropped,
    limiterDropped,
    appDropped,
    depDropped,
    wsActivePct,
    wsQueuePct,
    limiterActivePct,
    limiterQueuePct,
    appActivePct,
    appQueuePct,
    depActivePct
  });

  const stages = [
    {
      name: "Traffic",
      caption: "Offered load",
      state: "ok",
      meterPct: pressurePct(result.totals.arrived, Math.max(1, result.totals.arrived)),
      metrics: [
        { name: "arrived", value: formatNum(result.totals.arrived) },
        { name: "target", value: `${formatNum(cfg.rps)}/s` }
      ]
    },
    {
      name: "Webserver",
      caption: "High-performance request owner",
      state: stageState({ hardFailure: wsDropped, activePct: wsActivePct, queuePct: wsQueuePct }),
      meterPct: Math.max(wsActivePct, wsQueuePct, pressurePct(wsDropped, result.totals.arrived)),
      metrics: [
        { name: "active peak", value: `${formatNum(result.queues.peakWsActive)} / ${formatNum(cfg.wsMaxConcurrent)}` },
        { name: "pending peak", value: `${formatNum(result.queues.peakWsQueue)} / ${formatNum(cfg.wsQueueCapacity)}` },
        { name: "timeout 503", value: formatNum(result.totals.wsDroppedTimeout) },
        { name: "capacity 503", value: formatNum(result.totals.wsDroppedFull + result.totals.wsDroppedWait) },
        { name: "deadline", value: formatMs(cfg.wsRequestTimeoutMs) }
      ]
    },
    {
      name: "Limiter",
      caption: "Pre-admission policy and capacity",
      state: stageState({ hardFailure: limiterDropped, warning: limiterRuleWarn || limiterPendingWarn, activePct: limiterActivePct, queuePct: limiterQueuePct }),
      meterPct: Math.max(
        limiterActivePct,
        limiterQueuePct,
        pressurePct(result.totals.rate429, result.totals.arrived),
        pressurePct(limiterDropped, result.totals.arrived)
      ),
      metrics: [
        { name: "active peak", value: `${formatNum(result.queues.peakLimiterInflight)} / ${formatNum(cfg.rlMaxConcurrent)}` },
        { name: "pending peak", value: `${formatNum(result.queues.peakLimiterQueue)} / ${formatNum(cfg.rlQueueCapacity)}` },
        { name: "503 here", value: formatNum(limiterDropped) },
        { name: "bypassed", value: formatNum(result.totals.limiterBypassed) },
        { name: "429", value: formatNum(result.totals.rate429) },
        { name: "p95 decision", value: formatMs(result.limiterLatency.p95) }
      ]
    },
    {
      name: "App",
      caption: "Post-limiter capacity",
      state: stageState({ hardFailure: appDropped, activePct: appActivePct, queuePct: appQueuePct }),
      meterPct: Math.max(appActivePct, appQueuePct),
      metrics: [
        { name: "active peak", value: `${formatNum(result.queues.peakAppInflight)} / ${formatNum(cfg.maxConcurrent)}` },
        { name: "pending peak", value: `${formatNum(result.queues.peakAppQueue)} / ${formatNum(cfg.queueCapacity)}` },
        { name: "503 here", value: formatNum(appDropped) }
      ]
    },
    {
      name: "Dependency",
      caption: "Downstream bottleneck",
      state: stageState({ hardFailure: depDropped, activePct: depActivePct }),
      meterPct: depActivePct,
      metrics: [
        { name: "active peak", value: `${formatNum(result.queues.peakDepInflight)} / ${formatNum(cfg.depMaxConcurrent)}` },
        { name: "503 here", value: formatNum(depDropped) }
      ]
    },
    {
      name: "Outcome",
      caption: "Visible result",
      state: result.totals.rate503 > 0 ? "bad" : result.totals.rate429 > 0 ? "warn" : "ok",
      meterPct: Math.max(result.totals.rate503Pct, result.totals.rate429Pct),
      metrics: [
        { name: "served", value: formatNum(result.totals.served) },
        { name: "503 avoided", value: formatNum(protection.avoided503) },
        { name: "dep load avoided", value: formatNum(protection.avoidedDependencyLoad) }
      ]
    }
  ];

  root.innerHTML = `
    <div class="placement-note">
      <strong>Placement model</strong>
      <span>The webserver sits after traffic and owns the end-to-end request deadline. The limiter sits before app admission; limiter capacity failure can either return 503 or bypass to app, depending on the selected failure mode.</span>
    </div>
    <div class="cause-summary" data-kind="${analysis.kind}">
      <div>
        <strong>${analysis.title}</strong>
        <span>${analysis.detail}</span>
      </div>
      <p>${analysis.action}</p>
    </div>
    <div class="pressure-flow" aria-label="System pressure flow">
      ${renderStageCard(stages[0])}
      ${renderFlowEdge("arrivals", formatNum(result.totals.arrived))}
      ${renderStageCard(stages[1])}
      ${renderFlowEdge("to limiter", formatNum(result.totals.enteredLimiter), wsDropped ? "bad" : "neutral")}
      ${renderStageCard(stages[2])}
      ${renderFlowEdge("allowed to app", formatNum(result.totals.enteredApp), "ok")}
      ${renderStageCard(stages[3])}
      ${renderFlowEdge("to dependency", formatNum(result.totals.enteredDependency), "ok")}
      ${renderStageCard(stages[4])}
      ${renderFlowEdge("served", formatNum(result.totals.served), result.totals.rate503 ? "bad" : "ok")}
      ${renderStageCard(stages[5])}
    </div>
    <div class="protection-strip">
      <div data-kind="warn"><span>Policy rejected</span><strong>${formatNum(result.totals.rate429)}</strong></div>
      <div data-kind="ok"><span>App load avoided</span><strong>${formatNum(protection.avoidedAppLoad)}</strong></div>
      <div data-kind="ok"><span>Dependency load avoided</span><strong>${formatNum(protection.avoidedDependencyLoad)}</strong></div>
      <div data-kind="${wsDropped ? "bad" : "ok"}"><span>Webserver 503</span><strong>${formatNum(wsDropped)}</strong></div>
      <div data-kind="${limiterDropped ? "bad" : "ok"}"><span>Limiter 503</span><strong>${formatNum(limiterDropped)}</strong></div>
      <div data-kind="${result.totals.limiterBypassed ? "warn" : "ok"}"><span>Limiter bypass</span><strong>${formatNum(result.totals.limiterBypassed)}</strong></div>
      <div data-kind="${result.totals.rate503 ? "bad" : "ok"}"><span>Total 503</span><strong>${formatNum(result.totals.rate503)}</strong></div>
    </div>
  `;
}


function renderLatencyStats(result) {
  const root = document.getElementById("latencyStats");
  if (!root) return;
  const samples = result.latency.samples;
  const min = samples.length ? samples[0] : 0;
  const max = samples.length ? samples[samples.length - 1] : 0;
  const statusItems = [
    { code: "200", label: "served", value: formatNum(result.totals.served), kind: "ok" },
    { code: "429", label: "rate limited", value: formatNum(result.totals.rate429), kind: "warn" },
    { code: "503", label: "unavailable", value: formatNum(result.totals.rate503), kind: "bad" }
  ];
  const distItems = [
    { name: "HTTP 200 samples", value: formatNum(samples.length) },
    { name: "Min", value: formatMs(min) },
    { name: "p50", value: formatMs(result.latency.p50) },
    { name: "p95", value: formatMs(result.latency.p95) },
    { name: "p99", value: formatMs(result.latency.p99) },
    { name: "Max", value: formatMs(max) }
  ];
  root.innerHTML = `
    <div class="status-stats">
      ${statusItems.map(({ code, label, value, kind }) => (`<div class="status-stat ${kind}"><span>${code}</span><strong>${value}</strong><small>${label}</small></div>`)).join("")}
    </div>
    <div class="dist-stats-grid">
      ${distItems.map(({ name, value }) => (`<div class="dist-stat"><span>${name}</span><strong>${value}</strong></div>`)).join("")}
    </div>
  `;
}
