import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { runChecks, normalizeMcpUrl } from "../src/check.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, "..", "bin", "alexa-mcp-check.js");

function startFakeMcp({ tools, wellKnownStatus = 404 } = {}) {
  const defaultTools = [
    {
      name: "get_day_briefing",
      description: "Owner briefing for today",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "check_inventory",
      description: "Inventory levels",
      inputSchema: { type: "object", properties: { onlyLow: { type: "boolean" } } },
    },
    {
      name: "list_jobs",
      description: "List jobs",
      inputSchema: { type: "object", properties: { date: { type: "string" } } },
    },
  ];
  const toolList = tools !== undefined ? tools : defaultTools;

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/.well-known/oauth-protected-resource") {
      if (wellKnownStatus === 404) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      if (wellKnownStatus === 200) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            resource: "http://127.0.0.1/mcp",
            authorization_servers: ["https://example.com"],
          }),
        );
        return;
      }
      res.writeHead(wellKnownStatus, { "content-type": "text/plain" });
      res.end("error");
      return;
    }
    if (url.pathname !== "/mcp" || req.method !== "POST") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let rpc;
      try {
        rpc = JSON.parse(body || "{}");
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }));
        return;
      }
      // Notification (no id)
      if (rpc.method === "notifications/initialized") {
        res.writeHead(202);
        res.end();
        return;
      }
      const id = rpc.id ?? 1;
      const reply = (obj) => {
        const payload = { jsonrpc: "2.0", id, ...obj };
        // Exercise the SSE path for initialize to prove the client handles it
        if (rpc.method === "initialize") {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };

      if (rpc.method === "initialize") {
        reply({
          result: {
            protocolVersion: "2025-11-25",
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: "fake-mcp", version: "1.0.0" },
          },
        });
        return;
      }
      if (rpc.method === "tools/list") {
        reply({ result: { tools: toolList } });
        return;
      }
      if (rpc.method === "tools/call") {
        const name = rpc.params?.name;
        if (!toolList.some((t) => t.name === name)) {
          reply({ error: { code: -32602, message: `Unknown tool: ${name}` } });
          return;
        }
        reply({
          result: {
            content: [{ type: "text", text: `ok from ${name}` }],
          },
        });
        return;
      }
      reply({ error: { code: -32601, message: `Method not found: ${rpc.method}` } });
    });
  });

  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolvePromise({ server, port, base: `http://127.0.0.1:${port}` });
    });
  });
}

function runCli(args) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

describe("normalizeMcpUrl", () => {
  it("accepts base URL and /mcp endpoint equivalently", () => {
    const a = normalizeMcpUrl("http://localhost:3000");
    const b = normalizeMcpUrl("http://localhost:3000/mcp");
    const c = normalizeMcpUrl("http://localhost:3000/mcp/");
    assert.equal(a.mcpUrl, "http://localhost:3000/mcp");
    assert.equal(b.mcpUrl, a.mcpUrl);
    assert.equal(c.mcpUrl, a.mcpUrl);
    assert.equal(a.wellKnownUrl, "http://localhost:3000/.well-known/oauth-protected-resource");
  });
});

describe("happy path against a fake MCP server", () => {
  let ctx;
  before(async () => {
    ctx = await startFakeMcp();
  });
  after(() => ctx.server.close());

  it("runChecks passes with no FAIL (OAuth 404 is WARN only)", async () => {
    const report = await runChecks({ url: ctx.base, timeout: 5000 });
    assert.equal(report.summary.fail, 0, JSON.stringify(report.checks, null, 2));
    assert.equal(report.ok, true);
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c.status]));
    assert.equal(byId.initialize, "PASS");
    assert.equal(byId.protocol_version, "PASS");
    assert.equal(byId.server_info, "PASS");
    assert.equal(byId.tools_list, "PASS");
    assert.equal(byId.tools_schema, "PASS");
    assert.equal(byId.tools_call, "PASS");
    assert.equal(byId.oauth_protected_resource, "WARN");
    assert.equal(byId.error_semantics, "PASS");
  });

  it("also accepts the /mcp endpoint directly", async () => {
    const report = await runChecks({ url: `${ctx.base}/mcp`, timeout: 5000 });
    assert.equal(report.ok, true);
  });

  it("CLI exits 0 and JSON output is machine-readable", async () => {
    const { code, stdout } = await runCli(["--url", ctx.base, "--json"]);
    assert.equal(code, 0, stdout);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.summary.fail, 0);
    assert.ok(Array.isArray(parsed.checks));
  });

  it("CLI human output contains PASS/WARN and a summary", async () => {
    const { code, stdout } = await runCli(["--url", ctx.base]);
    assert.equal(code, 0, stdout);
    assert.match(stdout, /PASS/);
    assert.match(stdout, /WARN/);
    assert.match(stdout, /Summary:/);
    assert.match(stdout, /READY/);
  });

  it("explicit --call works", async () => {
    const { code, stdout } = await runCli([
      "--url",
      ctx.base,
      "--call",
      "check_inventory",
      "--args",
      '{"onlyLow":true}',
      "--json",
    ]);
    assert.equal(code, 0, stdout);
    const parsed = JSON.parse(stdout);
    const callCheck = parsed.checks.find((c) => c.id === "tools_call");
    assert.equal(callCheck.status, "PASS");
    assert.match(callCheck.title, /check_inventory/);
  });
});

describe("failure case: empty tools/list", () => {
  let ctx;
  before(async () => {
    ctx = await startFakeMcp({ tools: [] });
  });
  after(() => ctx.server.close());

  it("runChecks reports FAIL for empty tools/list", async () => {
    const report = await runChecks({ url: ctx.base, timeout: 5000 });
    assert.equal(report.ok, false);
    assert.ok(report.summary.fail >= 1);
    const listCheck = report.checks.find((c) => c.id === "tools_list");
    assert.equal(listCheck.status, "FAIL");
  });

  it("CLI exits 1 on empty tools/list", async () => {
    const { code, stdout } = await runCli(["--url", ctx.base, "--json"]);
    assert.equal(code, 1, stdout);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.ok, false);
    assert.ok(parsed.summary.fail >= 1);
  });
});

describe("OAuth metadata present", () => {
  let ctx;
  before(async () => {
    ctx = await startFakeMcp({ wellKnownStatus: 200 });
  });
  after(() => ctx.server.close());

  it("reports PASS when RFC 9728 metadata is valid JSON", async () => {
    const report = await runChecks({ url: ctx.base, timeout: 5000 });
    const c = report.checks.find((x) => x.id === "oauth_protected_resource");
    assert.equal(c.status, "PASS");
    assert.equal(report.ok, true);
  });
});
