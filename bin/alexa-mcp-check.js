#!/usr/bin/env node
/**
 * alexa-mcp-check CLI
 * Usage:
 *   alexa-mcp-check --url http://localhost:3000
 *   alexa-mcp-check http://localhost:3000/mcp
 *   alexa-mcp-check --url http://localhost:3000 --call get_day_briefing --json
 *   alexa-mcp-check --url http://localhost:3000 --call check_inventory --args '{"onlyLow":true}'
 */
import { runChecks, formatHuman } from "../src/check.js";

function printHelp() {
  console.log(`alexa-mcp-check — check if an MCP server is ready for Alexa+

Usage:
  alexa-mcp-check --url <base-or-mcp-url> [options]
  alexa-mcp-check <base-or-mcp-url> [options]

Options:
  --url <url>         Base URL (http://localhost:3000) or MCP endpoint (http://localhost:3000/mcp). Both are accepted.
  --call <tool>       Tool to call with tools/call (default: auto-pick a read-only tool: get_day_briefing, check_inventory, list_jobs)
  --args <json>       JSON arguments for --call, e.g. '{"onlyLow":true}' (default: {})
  --json              Output machine-readable JSON instead of human text
  --timeout <ms>      Per-request timeout in milliseconds (default: 10000)
  -h, --help          Show this help

Exit code:
  0  No FAIL checks (PASS/WARN only)
  1  At least one FAIL check, or usage / network setup error

Examples:
  alexa-mcp-check --url http://localhost:3000
  alexa-mcp-check --url http://localhost:3000/mcp --json
  alexa-mcp-check --url http://localhost:3000 --call check_inventory --args '{"onlyLow":true}'
`);
}

function parseArgs(argv) {
  const opts = { url: null, call: null, args: {}, json: false, timeout: 10000, help: false };
  const rest = [...argv];
  let positional = null;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "-h" || a === "--help") opts.help = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--url") opts.url = rest[++i];
    else if (a.startsWith("--url=")) opts.url = a.slice("--url=".length);
    else if (a === "--call") opts.call = rest[++i];
    else if (a.startsWith("--call=")) opts.call = a.slice("--call=".length);
    else if (a === "--args") {
      const raw = rest[++i];
      try {
        opts.args = JSON.parse(raw);
      } catch {
        throw new Error(`--args must be valid JSON, got: ${raw}`);
      }
    } else if (a.startsWith("--args=")) {
      const raw = a.slice("--args=".length);
      try {
        opts.args = JSON.parse(raw);
      } catch {
        throw new Error(`--args must be valid JSON, got: ${raw}`);
      }
    } else if (a === "--timeout") opts.timeout = Number(rest[++i]);
    else if (a.startsWith("--timeout=")) opts.timeout = Number(a.slice("--timeout=".length));
    else if (!a.startsWith("-") && !positional) positional = a;
    else if (!a.startsWith("-") && !opts.url) opts.url = a;
  }
  if (!opts.url && positional) opts.url = positional;
  if (opts.timeout !== undefined && (!Number.isFinite(opts.timeout) || opts.timeout <= 0)) {
    throw new Error("--timeout must be a positive number of milliseconds");
  }
  return opts;
}

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(`Error: ${err.message}`);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ ok: false, error: err.message, checks: [], summary: { pass: 0, warn: 0, fail: 1, total: 0 } }, null, 2));
  }
  process.exit(1);
}

if (opts.help) {
  printHelp();
  process.exit(0);
}

if (!opts.url) {
  console.error("Error: --url is required (or pass the URL as the first argument)");
  printHelp();
  process.exit(1);
}

try {
  const report = await runChecks({
    url: opts.url,
    callTool: opts.call,
    callArgs: opts.args,
    timeout: opts.timeout,
  });
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatHuman(report));
  }
  process.exit(report.ok ? 0 : 1);
} catch (err) {
  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          error: err.message || String(err),
          target: opts.url,
          checks: [
            {
              id: "setup",
              title: "Setup",
              status: "FAIL",
              message: err.message || String(err),
              suggestion: "Check the URL is a valid http(s) URL, e.g. http://localhost:3000 or http://localhost:3000/mcp",
            },
          ],
          summary: { pass: 0, warn: 0, fail: 1, total: 1 },
        },
        null,
        2,
      ),
    );
  } else {
    console.error(`FAIL: ${err.message || String(err)}`);
  }
  process.exit(1);
}
