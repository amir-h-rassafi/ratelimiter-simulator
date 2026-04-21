#!/usr/bin/env node
const {
  compareScenarios,
  defaultSimulationConfig,
  reviewComponentPath,
  simulateScenario
} = require("./review.js");

const PROTOCOL_VERSION = "2024-11-05";
let buffer = Buffer.alloc(0);

function send(message) {
  const json = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(`Content-Length: ${json.length}\r\n\r\n`);
  process.stdout.write(json);
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function toolDefinitions() {
  return [
    {
      name: "simulate_scenario",
      description: "Run the current flat rate-limit and queueing simulator with explicit numeric parameters.",
      inputSchema: {
        type: "object",
        properties: {
          config: { type: "object", description: "Flat simulation config. Omit to use defaults.", additionalProperties: true }
        },
        additionalProperties: false
      }
    },
    {
      name: "compare_scenarios",
      description: "Compare a baseline configuration and a candidate configuration to see how 429, 503, latency, and queue peaks change.",
      inputSchema: {
        type: "object",
        properties: {
          base: { type: "object", additionalProperties: true },
          candidate: { type: "object", additionalProperties: true }
        },
        required: ["base", "candidate"],
        additionalProperties: false
      }
    },
    {
      name: "review_component_path",
      description: "Normalize a component-oriented path like WAF -> API gateway -> app -> DB into simulator assumptions, then run the simulator and explain the assumptions.",
      inputSchema: {
        type: "object",
        properties: {
          traffic: { type: "object", additionalProperties: true },
          defaults: { type: "object", additionalProperties: true },
          components: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                kind: { type: "string" },
                latencyMs: { type: "number" },
                jitterMs: { type: "number" },
                latencyDist: { type: "string" },
                maxConcurrent: { type: "number" },
                queueCapacity: { type: "number" },
                timeoutMs: { type: "number" },
                rateLimiter: { type: "object", additionalProperties: true }
              },
              required: ["kind"],
              additionalProperties: true
            }
          }
        },
        required: ["components"],
        additionalProperties: false
      }
    },
    {
      name: "default_simulation_config",
      description: "Return the simulator's default configuration so an agent can start from a known baseline.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false
      }
    }
  ];
}

function asToolResult(data) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2)
      }
    ],
    structuredContent: data
  };
}

function handleRequest(message) {
  const { id, method, params } = message;

  if (method === "initialize") {
    return reply(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: {
        name: "rate-limit-simulator-mcp",
        version: "0.1.0"
      }
    });
  }

  if (method === "notifications/initialized") return;

  if (method === "tools/list") {
    return reply(id, { tools: toolDefinitions() });
  }

  if (method === "tools/call") {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    try {
      if (name === "simulate_scenario") return reply(id, asToolResult(simulateScenario(args)));
      if (name === "compare_scenarios") return reply(id, asToolResult(compareScenarios(args)));
      if (name === "review_component_path") return reply(id, asToolResult(reviewComponentPath(args)));
      if (name === "default_simulation_config") return reply(id, asToolResult(defaultSimulationConfig()));
      return fail(id, -32601, `Unknown tool: ${name}`);
    } catch (error) {
      return fail(id, -32000, error && error.message ? error.message : "Tool execution failed");
    }
  }

  return fail(id, -32601, `Unknown method: ${method}`);
}

function consume() {
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const headerText = buffer.slice(0, headerEnd).toString("utf8");
    const match = headerText.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      buffer = Buffer.alloc(0);
      return;
    }
    const length = Number(match[1]);
    const messageStart = headerEnd + 4;
    const messageEnd = messageStart + length;
    if (buffer.length < messageEnd) return;
    const body = buffer.slice(messageStart, messageEnd).toString("utf8");
    buffer = buffer.slice(messageEnd);
    const message = JSON.parse(body);
    handleRequest(message);
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  consume();
});

process.stdin.on("end", () => process.exit(0));
