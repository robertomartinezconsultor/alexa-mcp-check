# alexa-mcp-check

Check if an MCP server is ready for **Alexa+** — in one command, with no dependencies.

`alexa-mcp-check` is a small Node.js CLI that probes a [Model Context Protocol](https://modelcontextprotocol.io)
server over Streamable HTTP and reports whether it passes the basics Alexa+
needs: the `2025-11-25` handshake, a usable tool list, a working read-only
tool call, OAuth protected-resource metadata (RFC 9728), and sane error
handling for unknown tools.

Built for the **Amazon Developer Hackathon — Alexa+ / Open Source mini
challenge**, as a companion diagnostic for [Foreman MCP](https://github.com/robertomartinezconsultor)
(and usable with any MCP server).

- **Zero dependencies** — Node >= 20 and the global `fetch` only
- **Human or machine output** — readable severities or `--json`
- **CI-friendly exit code** — `1` only when a check is `FAIL`

## Install / run

No install step or build is needed — it is plain ESM JavaScript:

```bash
git clone https://github.com/robertomartinezconsultor/alexa-mcp-check.git
cd alexa-mcp-check

# direct
node bin/alexa-mcp-check.js --url http://localhost:3000

# or via npm bin
npm link   # optional, exposes `alexa-mcp-check` on your PATH
alexa-mcp-check --url http://localhost:3000
```

Requires Node `>=20`.

## Usage

```text
alexa-mcp-check --url <base-or-mcp-url> [options]
alexa-mcp-check <base-or-mcp-url> [options]

Options:
  --url <url>         Base URL (http://localhost:3000) or MCP endpoint
                      (http://localhost:3000/mcp). Both are accepted.
  --call <tool>       Tool to call with tools/call (default: auto-pick a
                      read-only tool: get_day_briefing, check_inventory,
                      list_jobs — in that order)
  --args <json>       JSON arguments for --call, e.g. '{"onlyLow":true}'
                      (default: {})
  --json              Output machine-readable JSON instead of human text
  --timeout <ms>      Per-request timeout in milliseconds (default: 10000)
  -h, --help          Show help
```

Examples:

```bash
# Base URL and /mcp endpoint are equivalent
alexa-mcp-check --url http://localhost:3000
alexa-mcp-check --url http://localhost:3000/mcp

# Machine-readable output for CI
alexa-mcp-check --url http://localhost:3000 --json

# Exercise a specific tool
alexa-mcp-check --url http://localhost:3000 --call check_inventory --args '{"onlyLow":true}'
```

Exit code:

| Code | Meaning |
| --- | --- |
| `0` | No `FAIL` checks (`PASS` / `WARN` only) |
| `1` | At least one `FAIL` check, or a usage/setup error |

## What it validates

Eight checks, each reported as `PASS`, `WARN` or `FAIL` with a suggested fix:

| Check | Severity rule |
| --- | --- |
| **Initialize handshake** | `FAIL` if `initialize` returns no JSON-RPC result or a JSON-RPC error. The client negotiates protocol version `2025-11-25`. |
| **Protocol version** | `PASS` if the server returns `2025-11-25` or later, `FAIL` if it returns an older version or none. |
| **serverInfo present** | `PASS` if `serverInfo.name` and `serverInfo.version` are present, `WARN` if partial, `FAIL` if absent. |
| **tools/list non-empty** | `PASS` if at least one tool is returned, `FAIL` if the list is empty, missing, or errors. |
| **Tool schemas** | `PASS` if every tool has `name`, `description` and `inputSchema` with `type: "object"`. `FAIL` if a name is missing or a schema is not an object, `WARN` if only descriptions are missing. |
| **tools/call (read-only)** | Calls one read-only tool — `get_day_briefing`, then `check_inventory`, then `list_jobs` — or the tool given with `--call`. `PASS` on a successful result, `FAIL` on a JSON-RPC error or `isError: true`, `WARN` (skipped) if no preferred read-only tool exists and none was specified. |
| **RFC 9728 protected-resource metadata** | `GET /.well-known/oauth-protected-resource` on the server origin. `PASS` if it returns valid JSON, `WARN` if it returns `404` (the deployment may operate without account linking / OAuth), `FAIL` only if it returns a different error status or invalid JSON. |
| **Error semantics (unknown tool)** | Calls a deliberately non-existent tool. `PASS` if the server returns a JSON-RPC error or a result with `isError: true`, `FAIL` if it returns a silent success, `WARN` if the failure is only signalled at HTTP level or is ambiguous. This reasoned split matters: a silent success hides failures from voice clients, while an HTTP-only error is imperfect but not silent. |

Both plain JSON and Server-Sent Events (`text/event-stream`) responses from
Streamable HTTP servers are parsed.

## Example: Foreman MCP (local)

[Foreman MCP](../proyecto) is a self-hosted MCP server (spec `2025-11-25`,
Streamable HTTP) that lets Alexa+ run a field-service business by voice.

```bash
# Terminal 1 — start Foreman MCP on a scratch data directory
cd ../proyecto
npm run build
FOREMAN_DATA_DIR=$(mktemp -d) PORT=3000 node dist/index.js
# foreman-mcp listening on http://localhost:3000/mcp

# Terminal 2 — check it
cd ../alexa-mcp-check
node bin/alexa-mcp-check.js --url http://localhost:3000
```

Sample output (full transcript in [`docs/foreman-sample-report.txt`](docs/foreman-sample-report.txt)):

```text
alexa-mcp-check — Alexa+ readiness for MCP servers
Target: http://127.0.0.1:3457
MCP endpoint: http://127.0.0.1:3457/mcp
Well-known: http://127.0.0.1:3457/.well-known/oauth-protected-resource
Protocol target: 2025-11-25

[PASS] Initialize handshake (initialize)
[PASS] Protocol version (2025-11-25 or later) (protocol_version)
[PASS] serverInfo present (server_info)
[PASS] tools/list non-empty (tools_list)
[PASS] Tool schemas (name, description, inputSchema object) (tools_schema)
[PASS] tools/call (get_day_briefing) (tools_call)
[WARN] RFC 9728 protected-resource metadata (oauth_protected_resource)
[PASS] Error semantics (unknown tool) (error_semantics)

Summary: 7 PASS, 1 WARN, 0 FAIL (8 checks)
Result: READY (no FAIL checks)
```

The single `WARN` is expected for Foreman MCP in its default local mode: it
does not use account linking, so it intentionally has no OAuth
protected-resource document. A `WARN` does not fail the run.

## JSON output

```bash
alexa-mcp-check --url http://localhost:3000 --json
```

```json
{
  "target": "http://localhost:3000",
  "mcpUrl": "http://localhost:3000/mcp",
  "wellKnownUrl": "http://localhost:3000/.well-known/oauth-protected-resource",
  "protocolVersionTarget": "2025-11-25",
  "checks": [
    { "id": "initialize", "title": "Initialize handshake", "status": "PASS", "message": "Server responded to initialize (HTTP 200)." }
  ],
  "summary": { "pass": 7, "warn": 1, "fail": 0, "total": 8 },
  "ok": true,
  "tools": ["get_day_briefing", "list_jobs"]
}
```

Every check object has `id`, `title`, `status` and `message`, plus a
`suggestion` (the concrete fix) whenever it is not a plain pass.

## Tests

Real tests with the built-in Node test runner — they boot a minimal fake MCP
server on an ephemeral port (JSON for most methods, SSE for `initialize`) and
exercise the happy path, the explicit `--call` path, OAuth metadata present,
and a failure case:

```bash
npm test
# 9 tests: normalizeMcpUrl, happy path (programmatic + CLI, exit 0),
# empty tools/list => FAIL + CLI exit 1, RFC 9728 PASS case
```

## Limitations (honest)

- **Readiness smoke test, not certification.** Passing means the server
  speaks MCP `2025-11-25` over Streamable HTTP and its tools look callable.
  It does not prove Alexa+ will accept, rank, or invoke the tools well in a
  real device session — that also depends on your Alexa skill / endpoint
  hosting, account linking setup, and Amazon review.
- **No authenticated flows.** The checker sends no `Authorization` header
  and does not perform an OAuth flow. If your server requires a bearer token
  for `/mcp` itself, `initialize` will fail here even though the server may
  be correct behind auth. The RFC 9728 check only reads the public metadata
  document; it does not validate the authorization server it points to.
- **Only one tool is called.** By design it calls a single read-only tool
  (or the one you pass with `--call`) so a check run never mutates business
  state. Mutating tools are listed and schema-checked, never invoked,
  unless you explicitly name one with `--call` — use that with care.
- **Stateless assumption.** It works best with stateless Streamable HTTP
  servers (no `Mcp-Session-Id` required). It sends a best-effort
  `notifications/initialized` notification, but does not maintain a session
  across checks. A strictly stateful server that requires session
  negotiation beyond `initialize` may fail checks it would pass with a
  stateful client.
- **Protocol version comparison is lexical** (`YYYY-MM-DD` versions sort
  correctly as strings). Exotic non-date version strings are compared the
  same way.
- **Well-known location is the origin root** (`/.well-known/oauth-protected-resource`),
  as specified in the check brief. The RFC 9728 variant with a resource-path
  suffix after the well-known prefix is not probed.
- It checks `tools` only — not `resources`, `prompts`, sampling, or
  elicitation, which Alexa+ tool use does not require.

## Project layout

```text
bin/alexa-mcp-check.js   CLI entry point (argument parsing, exit code)
src/check.js             Check engine (also importable: runChecks, normalizeMcpUrl)
test/check.test.js       node --test suite with an in-process fake MCP server
docs/foreman-sample-report.txt  Real run against a local Foreman MCP server
```

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 ELTIGRELABS.
