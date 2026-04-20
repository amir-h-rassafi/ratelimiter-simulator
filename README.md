# Rate Limiter Simulator

Browser simulator for traffic, sliding-window rate limits, queue pressure, backend latency, and `429` outcomes.

Demo: https://ratelimit-simulator.pages.dev/

## Design

```mermaid
flowchart LR
  A[Traffic arrivals] --> B[Rate limit rules]
  B -->|allowed| C[Backend capacity]
  B -->|rejected| E[429]
  C -->|available| D[Served]
  C -->|full| Q[Queue]
  Q -->|slot opens| D
  Q -->|timeout or full| E
```

## Run locally

```bash
python3 -m http.server 8080
```

Open `http://localhost:8080`.
