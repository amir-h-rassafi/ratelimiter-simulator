# Rate Limiter Simulator

Lightweight browser-based simulator for exploring:
- Cascaded multi-window rate limiting with `fixed window` and `sliding window`.
- Input traffic intensity and burst shaping.
- Rate-limiter decision latency and its system impact.
- Latency distribution effects on concurrency and queueing.
- Outcomes: served, delayed served, and `429` rates.

## Run

Because this is static HTML/CSS/JS, either:

1. Open `index.html` directly in your browser, or
2. Serve locally (recommended):

```bash
python3 -m http.server 8080
```

Then visit `http://localhost:8080`.

## Model Summary

- Arrivals are generated per simulation step using a Poisson process around target RPS.
- Burst factor applies a sinusoidal multiplier to create traffic waves.
- Each request passes the selected window limiter:
  - `fixed`: count resets each window.
  - `sliding`: count uses last `windowMs` rolling interval.
  - With cascade enabled, request must pass every configured window.
- If accepted:
  - Starts immediately if in-flight count is below `max concurrent`.
  - Otherwise enters a bounded queue.
  - If queue is full or wait time exceeds `max queue wait`, request is counted as `429`.
- Service time comes from the selected latency distribution.
- Each request also has limiter decision latency before allow/reject is evaluated.

## Latency Distribution Parameters

- `constant`: A = latency ms.
- `uniform`: A/B = min/max latency ms.
- `normal`: A/B = mean/stddev ms.
- `log-normal`: A/B = mu/sigma (log space).
- `exponential`: A = mean latency ms.

## Rate-Limiter Latency Parameters

- Uses same distribution options as service latency.
- Models control-plane decision delay before request is admitted/rejected.
- High values increase `limiter pending`, delay acceptance, and can worsen queue pressure/429 outcomes.

## Analytics Shown

- Total arrived requests.
- Served count and served %.
- Delayed served count.
- `429` total and %.
- Queue-timeout `429`.
- Latency stats: avg, p50, p95, p99.
- Avg queue delay.
- Combined time-series chart with toggles for active, queue, accepted/s, `429`/s, arrivals/s, limiter pending, and per-window utilization.
- Latency shape chart: histogram of observed end-to-end latency.
- Timeline includes limiter pending depth to visualize control-plane bottlenecks.
