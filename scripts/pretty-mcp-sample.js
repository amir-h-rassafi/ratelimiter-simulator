#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { reviewComponentPath } = require("../mcp/review.js");

const samplePath = path.join(__dirname, "..", "examples", "mcp-review-component-path.ndjson");
const supportsColor = !process.env.NO_COLOR && process.env.TERM !== "dumb";

const color = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m"
};

function paint(value, name) {
  if (!supportsColor) return String(value);
  return `${color[name]}${value}${color.reset}`;
}

function metric(label, value, tone = "cyan") {
  return `${paint(label.padEnd(18), "dim")} ${paint(value, tone)}`;
}

function pctBar(value, width = 28) {
  const pct = Math.max(0, Math.min(100, value));
  const filled = Math.round((pct / 100) * width);
  return `${"#".repeat(filled)}${"-".repeat(width - filled)} ${pct.toFixed(1)}%`;
}

function readSampleArguments() {
  const lines = fs.readFileSync(samplePath, "utf8").trim().split(/\r?\n/);
  const toolCall = lines
    .map((line) => JSON.parse(line))
    .find((message) => message.method === "tools/call");

  if (!toolCall) throw new Error(`No tools/call request found in ${samplePath}`);
  if (toolCall.params?.name !== "review_component_path") {
    throw new Error(`Expected review_component_path sample, got ${toolCall.params?.name || "unknown"}`);
  }
  return toolCall.params.arguments;
}

const input = readSampleArguments();
const review = reviewComponentPath(input);
const summary = review.summary;
const components = input.components.map((component) => component.name || component.kind).join(" -> ");

console.log(paint("Rate Limit Simulator MCP Sample", "bold"));
console.log(paint(`Source: ${path.relative(path.join(__dirname, ".."), samplePath)}`, "dim"));
console.log(paint(`Path: ${components}`, "dim"));
console.log("");

console.log(paint("Outcome", "bold"));
console.log(metric("Arrived", summary.arrived));
console.log(metric("Served", `${summary.served} (${summary.servedPct}%)`, summary.servedPct >= 50 ? "green" : "yellow"));
console.log(metric("HTTP 429", `${summary.rate429} (${summary.rate429Pct}%)`, summary.rate429 ? "yellow" : "green"));
console.log(metric("HTTP 503", `${summary.rate503} (${summary.rate503Pct}%)`, summary.rate503 ? "red" : "green"));
console.log("");

console.log(paint("Traffic Split", "bold"));
console.log(`${paint("Served".padEnd(10), "green")} ${paint(pctBar(summary.servedPct), "green")}`);
console.log(`${paint("429".padEnd(10), "yellow")} ${paint(pctBar(summary.rate429Pct), "yellow")}`);
console.log(`${paint("503".padEnd(10), "red")} ${paint(pctBar(summary.rate503Pct), "red")}`);
console.log("");

console.log(paint("Latency", "bold"));
console.log(metric("p50", `${summary.p50} ms`));
console.log(metric("p95", `${summary.p95} ms`, summary.p95 > 500 ? "yellow" : "green"));
console.log(metric("p99", `${summary.p99} ms`, summary.p99 > 800 ? "red" : "yellow"));
console.log(metric("avg", `${summary.avgLatency} ms`));
console.log("");

console.log(paint("Queues", "bold"));
console.log(metric("Limiter pending", summary.peakLimiterPending, summary.peakLimiterPending ? "yellow" : "green"));
console.log(metric("App queue", summary.peakAppQueue, summary.peakAppQueue ? "yellow" : "green"));
console.log(metric("Dependency queue", summary.peakDepQueue, summary.peakDepQueue ? "red" : "green"));
console.log("");

console.log(paint("Collapse", "bold"));
console.log(metric("Control latency", `${review.collapse.control.latencyMs} ms`));
console.log(metric("App capacity", `${review.collapse.app.maxConcurrent} active, ${review.collapse.app.queueCapacity} queued`));
console.log(metric("Dependency cap", `${review.collapse.dependency.maxConcurrent} active, ${review.collapse.dependency.queueCapacity} queued`));

if (review.warnings.length) {
  console.log("");
  console.log(paint("Warnings", "bold"));
  for (const warning of review.warnings) console.log(paint(`- ${warning}`, "yellow"));
}
