/**
 * alexa-mcp-check — core checks.
 *
 * Verifies whether an MCP server (Streamable HTTP) is ready for Alexa+:
 *  - initialize handshake negotiating MCP spec 2025-11-25
 *  - serverInfo present
 *  - tools/list non-empty, every tool has name / description / inputSchema (object)
 *  - tools/call on a read-only tool (or an explicit --call tool)
 *  - RFC 9728 protected-resource metadata at /.well-known/oauth-protected-resource
 *  - error semantics: calling a non-existent tool must surface a JSON-RPC
 *    error or a result with isError=true
 *
 * Zero dependencies. Node >= 20, global fetch.
 */

export const TARGET_PROTOCOL_VERSION = "2025-11-25";
export const READ_ONLY_PREFERENCE = ["get_day_briefing", "check_inventory", "list_jobs"];
export const NONEXISTENT_TOOL = "__alexa_mcp_check_does_not_exist__";

export function normalizeMcpUrl(input) {
  if (!input || typeof input !== "string") throw new Error("URL is required");
  let raw = input.trim();
  if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}`;
  const u = new URL(raw);
  const path = u.pathname.replace(/\/+$/, "");
  const mcpPath = path.endsWith("/mcp") ? path : `${path}/mcp`;
  // Rebuild without query/hash for the MCP endpoint
  const mcpUrl = `${u.origin}${mcpPath}`;
  const wellKnownUrl = `${u.origin}/.well-known/oauth-protected-resource`;
  return { input, mcpUrl, origin: u.origin, wellKnownUrl, baseUrl: u.origin };
}

export function isVersionAtLeast(version, target = TARGET_PROTOCOL_VERSION) {
  if (!version || typeof version !== "string") return false;
  // Protocol versions are dates YYYY-MM-DD, so lexical comparison works.
  // Fall back to lexical for any future format as well.
  return version >= target;
}

/**
 * Parse a response body that may be plain JSON or Server-Sent Events
 * (text/event-stream). Streamable HTTP servers may return either.
 * Returns the parsed JSON-RPC object or null.
 */
export function parseRpcBody(text, _contentType) {
  if (!text || !text.trim()) return null;
  const trimmed = text.trim();
  // SSE detection
  if (trimmed.startsWith("data:") || trimmed.startsWith("event:") || trimmed.includes("\ndata:")) {
    const dataPayloads = [];
    for (const line of trimmed.split(/\r?\n/)) {
      if (line.startsWith("data:")) dataPayloads.push(line.slice(5).trim());
    }
    // Try joined payload first (multi-line data for one event)
    for (const candidate of [dataPayloads.join(""), ...dataPayloads]) {
      if (!candidate || candidate === "[DONE]") continue;
      try {
        return JSON.parse(candidate);
      } catch {
        // try next
      }
    }
    // Try parsing each payload individually and return the last valid one
    let last = null;
    for (const p of dataPayloads) {
      try {
        last = JSON.parse(p);
      } catch {}
    }
    return last;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

let rpcId = 0;
async function mcpRequest(mcpUrl, method, params, timeoutMs) {
  const id = ++rpcId;
  const body = { jsonrpc: "2.0", id, method };
  if (params !== undefined) body.params = params;
  const res = await fetchWithTimeout(
    mcpUrl,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
    },
    timeoutMs,
  );
  const text = await res.text();
  const contentType = res.headers.get("content-type") || "";
  const parsed = parseRpcBody(text, contentType);
  return { httpStatus: res.status, contentType, text, parsed };
}

async function sendInitializedNotification(mcpUrl, timeoutMs) {
  try {
    await fetchWithTimeout(
      mcpUrl,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      },
      Math.min(timeoutMs, 1500),
    );
  } catch {
    // Stateless servers may reject or ignore this; it is best-effort.
  }
}

function check(id, title, status, message, suggestion) {
  const c = { id, title, status, message };
  if (suggestion) c.suggestion = suggestion;
  return c;
}

export async function runChecks(options) {
  const { url, callTool = null, callArgs = {}, timeout = 10000 } = options || {};
  const { mcpUrl, wellKnownUrl, origin } = normalizeMcpUrl(url);
  const checks = [];
  let tools = [];
  let initResult = null;

  // ---- initialize ------------------------------------------------------
  let initError = null;
  try {
    const r = await mcpRequest(
      mcpUrl,
      "initialize",
      {
        protocolVersion: TARGET_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "alexa-mcp-check", version: "1.0.0" },
      },
      timeout,
    );
    if (r.parsed && r.parsed.error) {
      initError = `JSON-RPC error ${r.parsed.error.code ?? ""}: ${r.parsed.error.message ?? JSON.stringify(r.parsed.error)}`;
      checks.push(
        check(
          "initialize",
          "Initialize handshake",
          "FAIL",
          `Server returned a JSON-RPC error for initialize: ${initError} (HTTP ${r.httpStatus})`,
          "Fix the initialize handler so it returns a result with protocolVersion, capabilities and serverInfo.",
        ),
      );
    } else if (!r.parsed || !r.parsed.result) {
      initError = `No JSON-RPC result (HTTP ${r.httpStatus})`;
      checks.push(
        check(
          "initialize",
          "Initialize handshake",
          "FAIL",
          `Initialize did not return a JSON-RPC result (HTTP ${r.httpStatus}). Body: ${truncate(r.text)}`,
          "Ensure POST /mcp handles initialize over Streamable HTTP and returns JSON or SSE with a result object.",
        ),
      );
    } else {
      initResult = r.parsed.result;
      checks.push(
        check(
          "initialize",
          "Initialize handshake",
          "PASS",
          `Server responded to initialize (HTTP ${r.httpStatus}).`,
        ),
      );
    }
  } catch (err) {
    initError = err?.cause?.message || err?.message || String(err);
    const isAbort = err?.name === "AbortError";
    checks.push(
      check(
        "initialize",
        "Initialize handshake",
        "FAIL",
        isAbort
          ? `Initialize timed out after ${timeout}ms.`
          : `Could not reach MCP endpoint ${mcpUrl}: ${initError}`,
        "Check the server is running, the URL is correct (base URL or /mcp both work), and the port is reachable. Try --timeout with a larger value on slow networks.",
      ),
    );
  }

  // Best-effort initialized notification (stateless servers ignore it)
  if (initResult) {
    await sendInitializedNotification(mcpUrl, timeout);
  }

  // ---- protocol version ------------------------------------------------
  if (initResult) {
    const pv = initResult.protocolVersion;
    if (!pv) {
      checks.push(
        check(
          "protocol_version",
          "Protocol version (2025-11-25 or later)",
          "FAIL",
          "Initialize result has no protocolVersion.",
          `Negotiate and return protocolVersion "${TARGET_PROTOCOL_VERSION}" (or later) in the initialize result.`,
        ),
      );
    } else if (isVersionAtLeast(pv)) {
      checks.push(
        check(
          "protocol_version",
          "Protocol version (2025-11-25 or later)",
          "PASS",
          `Server negotiated protocolVersion ${pv}.`,
        ),
      );
    } else {
      checks.push(
        check(
          "protocol_version",
          "Protocol version (2025-11-25 or later)",
          "FAIL",
          `Server negotiated protocolVersion ${pv}, which is older than ${TARGET_PROTOCOL_VERSION} required for Alexa+.`,
          `Upgrade the MCP SDK / server so initialize negotiates ${TARGET_PROTOCOL_VERSION} or later.`,
        ),
      );
    }
  } else {
    checks.push(
      check(
        "protocol_version",
        "Protocol version (2025-11-25 or later)",
        "FAIL",
        "Skipped: no initialize result to read protocolVersion from.",
        "Fix initialize first.",
      ),
    );
  }

  // ---- serverInfo ------------------------------------------------------
  if (initResult) {
    const si = initResult.serverInfo;
    if (si && si.name && si.version) {
      checks.push(
        check("server_info", "serverInfo present", "PASS", `serverInfo: ${si.name}@${si.version}.`),
      );
    } else if (si && (si.name || si.version)) {
      checks.push(
        check(
          "server_info",
          "serverInfo present",
          "WARN",
          `serverInfo is partial: ${JSON.stringify(si)}.`,
          "Provide both serverInfo.name and serverInfo.version in the initialize result.",
        ),
      );
    } else {
      checks.push(
        check(
          "server_info",
          "serverInfo present",
          "FAIL",
          "Initialize result has no serverInfo (name/version). Alexa+ and MCP clients use it to identify the server.",
          "Add serverInfo: { name: \"your-server\", version: \"x.y.z\" } to the server constructor / initialize result.",
        ),
      );
    }
  } else {
    checks.push(
      check(
        "server_info",
        "serverInfo present",
        "FAIL",
        "Skipped: no initialize result to read serverInfo from.",
        "Fix initialize first.",
      ),
    );
  }

  // ---- tools/list ------------------------------------------------------
  let toolsListOk = false;
  try {
    const r = await mcpRequest(mcpUrl, "tools/list", {}, timeout);
    if (r.parsed && r.parsed.error) {
      checks.push(
        check(
          "tools_list",
          "tools/list non-empty",
          "FAIL",
          `tools/list returned a JSON-RPC error: ${r.parsed.error.message ?? JSON.stringify(r.parsed.error)} (HTTP ${r.httpStatus})`,
          "Fix tools/list so it returns { tools: [...] } without error.",
        ),
      );
    } else if (!r.parsed || !r.parsed.result || !Array.isArray(r.parsed.result.tools)) {
      checks.push(
        check(
          "tools_list",
          "tools/list non-empty",
          "FAIL",
          `tools/list did not return a tools array (HTTP ${r.httpStatus}). Body: ${truncate(r.text)}`,
          "Return result.tools as an array from tools/list.",
        ),
      );
    } else {
      tools = r.parsed.result.tools;
      if (tools.length === 0) {
        checks.push(
          check(
            "tools_list",
            "tools/list non-empty",
            "FAIL",
            "tools/list returned an empty array. Alexa+ would have no tools to call.",
            "Register at least one tool on the server.",
          ),
        );
      } else {
        toolsListOk = true;
        checks.push(
          check(
            "tools_list",
            "tools/list non-empty",
            "PASS",
            `tools/list returned ${tools.length} tool(s): ${tools.map((t) => t.name).join(", ")}.`,
          ),
        );
      }
    }
  } catch (err) {
    checks.push(
      check(
        "tools_list",
        "tools/list non-empty",
        "FAIL",
        `tools/list request failed: ${err?.message || String(err)}`,
        "Check the server is reachable and tools/list is implemented over Streamable HTTP.",
      ),
    );
  }

  // ---- tools schema ----------------------------------------------------
  if (toolsListOk) {
    const missingName = [];
    const missingDesc = [];
    const badSchema = [];
    for (const t of tools) {
      if (!t.name) missingName.push("(unnamed)");
      if (!t.description) missingDesc.push(t.name || "(unnamed)");
      if (!t.inputSchema || t.inputSchema.type !== "object") badSchema.push(t.name || "(unnamed)");
    }
    if (missingName.length || badSchema.length) {
      const parts = [];
      if (missingName.length) parts.push(`missing name: ${missingName.join(", ")}`);
      if (badSchema.length) parts.push(`inputSchema is not type \"object\": ${badSchema.join(", ")}`);
      checks.push(
        check(
          "tools_schema",
          "Tool schemas (name, description, inputSchema object)",
          "FAIL",
          `Invalid tool definitions — ${parts.join("; ")}.`,
          'Give every tool a name and an inputSchema like { type: "object", properties: { ... } }.',
        ),
      );
    } else if (missingDesc.length) {
      checks.push(
        check(
          "tools_schema",
          "Tool schemas (name, description, inputSchema object)",
          "WARN",
          `Tools missing a description: ${missingDesc.join(", ")}. Alexa+ relies on descriptions to choose tools by voice intent.`,
          "Add a clear, voice-friendly description to every tool.",
        ),
      );
    } else {
      checks.push(
        check(
          "tools_schema",
          "Tool schemas (name, description, inputSchema object)",
          "PASS",
          "Every tool has name, description and inputSchema with type \"object\".",
        ),
      );
    }
  } else {
    checks.push(
      check(
        "tools_schema",
        "Tool schemas (name, description, inputSchema object)",
        "FAIL",
        "Skipped: tools/list was empty or failed, so schemas cannot be verified.",
        "Fix tools/list first.",
      ),
    );
  }

  // ---- tools/call ------------------------------------------------------
  {
    let targetTool = callTool;
    let explicit = Boolean(callTool);
    if (!targetTool && toolsListOk) {
      targetTool = READ_ONLY_PREFERENCE.find((p) => tools.some((t) => t.name === p)) || null;
    }
    if (!targetTool) {
      checks.push(
        check(
          "tools_call",
          "tools/call (read-only tool)",
          "WARN",
          explicit
            ? "No tool selected."
            : `None of the preferred read-only tools (${READ_ONLY_PREFERENCE.join(", ")}) were found, so no automatic call was made.`,
          "Pass --call <tool> --args '<json>' to exercise a specific read-only tool.",
        ),
      );
    } else if (!toolsListOk && explicit) {
      // Still attempt the explicit call even if list failed
      try {
        const r = await mcpRequest(mcpUrl, "tools/call", { name: targetTool, arguments: callArgs || {} }, timeout);
        evaluateToolCall(checks, targetTool, r);
      } catch (err) {
        checks.push(
          check(
            "tools_call",
            `tools/call (${targetTool})`,
            "FAIL",
            `tools/call ${targetTool} failed: ${err?.message || String(err)}`,
            "Check the tool handler and that required arguments are passed with --args.",
          ),
        );
      }
    } else if (!toolsListOk) {
      checks.push(
        check(
          "tools_call",
          "tools/call (read-only tool)",
          "FAIL",
          "Skipped: tools/list failed, so no read-only tool could be selected.",
          "Fix tools/list first.",
        ),
      );
    } else if (!tools.some((t) => t.name === targetTool)) {
      checks.push(
        check(
          "tools_call",
          `tools/call (${targetTool})`,
          "FAIL",
          `Tool "${targetTool}" requested with --call was not found in tools/list.`,
          `Use one of: ${tools.map((t) => t.name).join(", ")}.`,
        ),
      );
    } else {
      try {
        const r = await mcpRequest(mcpUrl, "tools/call", { name: targetTool, arguments: callArgs || {} }, timeout);
        evaluateToolCall(checks, targetTool, r);
      } catch (err) {
        checks.push(
          check(
            "tools_call",
            `tools/call (${targetTool})`,
            "FAIL",
            `tools/call ${targetTool} request failed: ${err?.message || String(err)}`,
            "Check the tool handler does not throw on valid read-only arguments and returns content.",
          ),
        );
      }
    }
  }

  // ---- RFC 9728 protected resource metadata ----------------------------
  try {
    const res = await fetchWithTimeout(
      wellKnownUrl,
      { method: "GET", headers: { accept: "application/json" } },
      timeout,
    );
    const text = await res.text();
    if (res.status === 404) {
      checks.push(
        check(
          "oauth_protected_resource",
          "RFC 9728 protected-resource metadata",
          "WARN",
          `GET ${wellKnownUrl} returned 404. No OAuth protected-resource metadata — acceptable if this deployment does not use account linking / OAuth, but Alexa+ integrations that require authorization will need it.`,
          "If you use OAuth/account linking, serve JSON at /.well-known/oauth-protected-resource with at least { resource, authorization_servers } per RFC 9728.",
        ),
      );
    } else if (res.status >= 200 && res.status < 300) {
      try {
        const json = JSON.parse(text);
        const extra = json.resource ? ` resource=${json.resource}` : "";
        checks.push(
          check(
            "oauth_protected_resource",
            "RFC 9728 protected-resource metadata",
            "PASS",
            `GET ${wellKnownUrl} returned ${res.status} with valid JSON.${extra}`,
          ),
        );
      } catch {
        checks.push(
          check(
            "oauth_protected_resource",
            "RFC 9728 protected-resource metadata",
            "FAIL",
            `GET ${wellKnownUrl} returned ${res.status} but the body is not valid JSON: ${truncate(text)}`,
            "Serve valid JSON at /.well-known/oauth-protected-resource per RFC 9728.",
          ),
        );
      }
    } else {
      checks.push(
        check(
          "oauth_protected_resource",
          "RFC 9728 protected-resource metadata",
          "FAIL",
          `GET ${wellKnownUrl} returned HTTP ${res.status} (expected 200 with JSON, or 404 if OAuth is not used). Body: ${truncate(text)}`,
          "Return 200 with valid RFC 9728 JSON if OAuth is supported, or 404 if it intentionally is not.",
        ),
      );
    }
  } catch (err) {
    checks.push(
      check(
        "oauth_protected_resource",
        "RFC 9728 protected-resource metadata",
        "WARN",
        `Could not fetch ${wellKnownUrl}: ${err?.message || String(err)}`,
        "Check the server exposes /.well-known/oauth-protected-resource on the same origin as /mcp, or confirm OAuth is not required.",
      ),
    );
  }

  // ---- error semantics -------------------------------------------------
  try {
    const r = await mcpRequest(mcpUrl, "tools/call", { name: NONEXISTENT_TOOL, arguments: {} }, timeout);
    if (r.parsed && r.parsed.error) {
      checks.push(
        check(
          "error_semantics",
          "Error semantics (unknown tool)",
          "PASS",
          `Calling a non-existent tool returned a JSON-RPC error (${r.parsed.error.code ?? "no code"}: ${r.parsed.error.message ?? ""}).`,
        ),
      );
    } else if (r.parsed && r.parsed.result && r.parsed.result.isError) {
      checks.push(
        check(
          "error_semantics",
          "Error semantics (unknown tool)",
          "PASS",
          "Calling a non-existent tool returned a result with isError=true, which MCP clients (and Alexa+) can surface as an error.",
        ),
      );
    } else if (r.parsed && r.parsed.result) {
      checks.push(
        check(
          "error_semantics",
          "Error semantics (unknown tool)",
          "FAIL",
          "Calling a non-existent tool returned a successful result without isError. Callers cannot distinguish this failure from success.",
          "Return a JSON-RPC error (e.g. -32602 / -32601) or a result with isError=true for unknown tools.",
        ),
      );
    } else if (r.httpStatus >= 400) {
      checks.push(
        check(
          "error_semantics",
          "Error semantics (unknown tool)",
          "WARN",
          `Calling a non-existent tool returned HTTP ${r.httpStatus} without a parseable JSON-RPC error body. The failure is signalled at HTTP level but not in MCP semantics. Body: ${truncate(r.text)}`,
          "Prefer a JSON-RPC error object in the response body so MCP clients can reason about the failure.",
        ),
      );
    } else {
      checks.push(
        check(
          "error_semantics",
          "Error semantics (unknown tool)",
          "WARN",
          `Calling a non-existent tool gave an ambiguous response (HTTP ${r.httpStatus}, no error, no result). Body: ${truncate(r.text)}`,
          "Return a JSON-RPC error or isError=true for unknown tools.",
        ),
      );
    }
  } catch (err) {
    checks.push(
      check(
        "error_semantics",
        "Error semantics (unknown tool)",
        "WARN",
        `Could not test unknown-tool handling: ${err?.message || String(err)}`,
        "Ensure unknown tools produce a JSON-RPC error or isError=true instead of a transport failure.",
      ),
    );
  }

  const summary = {
    pass: checks.filter((c) => c.status === "PASS").length,
    warn: checks.filter((c) => c.status === "WARN").length,
    fail: checks.filter((c) => c.status === "FAIL").length,
    total: checks.length,
  };
  return {
    target: url,
    mcpUrl,
    wellKnownUrl,
    origin,
    protocolVersionTarget: TARGET_PROTOCOL_VERSION,
    checks,
    summary,
    ok: summary.fail === 0,
    tools: tools.map((t) => t.name),
  };
}

function evaluateToolCall(checks, targetTool, r) {
  if (r.parsed && r.parsed.error) {
    checks.push(
      check(
        "tools_call",
        `tools/call (${targetTool})`,
        "FAIL",
        `tools/call ${targetTool} returned a JSON-RPC error: ${r.parsed.error.message ?? JSON.stringify(r.parsed.error)} (HTTP ${r.httpStatus})`,
        "Check the tool handler and the arguments (use --args) — a read-only tool should succeed with valid/empty arguments.",
      ),
    );
  } else if (!r.parsed || !r.parsed.result) {
    checks.push(
      check(
        "tools_call",
        `tools/call (${targetTool})`,
        "FAIL",
        `tools/call ${targetTool} did not return a result (HTTP ${r.httpStatus}). Body: ${truncate(r.text)}`,
        "Return a result with content from the tool handler.",
      ),
    );
  } else if (r.parsed.result.isError) {
    const text = extractResultText(r.parsed.result);
    checks.push(
      check(
        "tools_call",
        `tools/call (${targetTool})`,
        "FAIL",
        `tools/call ${targetTool} returned isError=true: ${text || "(no message)"}`,
        "A read-only tool called with valid arguments should not error. Check required arguments with --args or fix the handler.",
      ),
    );
  } else {
    const text = extractResultText(r.parsed.result);
    checks.push(
      check(
        "tools_call",
        `tools/call (${targetTool})`,
        "PASS",
        `tools/call ${targetTool} succeeded.${text ? ` Response preview: ${truncate(text, 160)}` : ""}`,
      ),
    );
  }
}

function extractResultText(result) {
  if (!result || !Array.isArray(result.content)) return "";
  return result.content
    .filter((c) => c && c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join(" ")
    .trim();
}

function truncate(s, n = 220) {
  if (!s) return "(empty)";
  const one = String(s).replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

export function formatHuman(report) {
  const lines = [];
  lines.push(`alexa-mcp-check — Alexa+ readiness for MCP servers`);
  lines.push(`Target: ${report.target}`);
  lines.push(`MCP endpoint: ${report.mcpUrl}`);
  lines.push(`Well-known: ${report.wellKnownUrl}`);
  lines.push(`Protocol target: ${report.protocolVersionTarget}`);
  lines.push("");
  const icon = { PASS: "PASS", WARN: "WARN", FAIL: "FAIL" };
  for (const c of report.checks) {
    lines.push(`[${icon[c.status]}] ${c.title} (${c.id})`);
    lines.push(`       ${c.message}`);
    if (c.suggestion) lines.push(`       Fix: ${c.suggestion}`);
  }
  lines.push("");
  lines.push(
    `Summary: ${report.summary.pass} PASS, ${report.summary.warn} WARN, ${report.summary.fail} FAIL (${report.summary.total} checks)`,
  );
  lines.push(report.ok ? "Result: READY (no FAIL checks)" : "Result: NOT READY (at least one FAIL)");
  return lines.join("\n");
}
