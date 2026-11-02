#!/usr/bin/env node
/**
 * agent-bounty-feed-client — a minimal, dependency-free MCP client for
 * Agent Bounty Feed (https://dailydollar-bot.github.io/agent-bounty-feed/).
 *
 * It performs the MCP Streamable HTTP handshake, lists the server's tools, and
 * calls `list_bounties`, printing the open paid bounties as a table (or JSON).
 *
 * Requires Node 18+ (built-in fetch). No npm install, no API key, no auth.
 */

const DEFAULT_URL =
  process.env.ABF_MCP_URL ||
  "https://agent-bounty-feed.dailydollar.workers.dev/mcp";

const PROTOCOL_VERSION = "2025-03-26";

function parseArgs(argv) {
  const args = {
    url: DEFAULT_URL,
    minUsd: 0,
    limit: 10,
    source: "",
    exclude: "",
    sort: "reward",
    json: false,
    tools: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    switch (a) {
      case "--url": args.url = next(); break;
      case "--min-usd": args.minUsd = Number(next()); break;
      case "--limit": args.limit = Number(next()); break;
      case "--source": args.source = next(); break;
      case "--exclude": args.exclude = next(); break;
      case "--sort": args.sort = next(); break;
      case "--json": args.json = true; break;
      case "--tools": args.tools = true; break;
      case "-h": case "--help": args.help = true; break;
      default:
        if (a.startsWith("-")) throw new Error(`unknown flag: ${a}`);
        args.minUsd = Number(a); // bare number = minimum USD
    }
  }
  return args;
}

function usage() {
  return `Usage: node client.mjs [options]

  --min-usd <n>     minimum reward in USD-equivalent (default 0)
  --limit <n>       max rows to request (default 10)
  --source <csv>    frantic,taskmarket,algora,direct,... (default all)
  --exclude <csv>   e.g. kyc,stake,bond,purchase,human_only,x_account
  --sort <field>    reward|first_seen (default reward)
  --json            print the raw JSON payload
  --tools           list MCP tools before calling
  --url <url>       override the MCP endpoint
  -h, --help        this text`;
}

/** POST a JSON-RPC message and return the JSON result, handling SSE or JSON. */
async function rpc(url, body, sessionId) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 300)}` : ""}`);
  }

  const sid = res.headers.get("mcp-session-id") || sessionId;
  const ctype = res.headers.get("content-type") || "";

  // Notifications legitimately return 202/204 with no body.
  if (res.status === 202 || res.status === 204) return { result: null, sessionId: sid };

  let payload;
  if (ctype.includes("text/event-stream")) {
    const text = await res.text();
    payload = parseSse(text);
  } else {
    payload = await res.json();
  }

  if (payload?.error) {
    throw new Error(`MCP error ${payload.error.code}: ${payload.error.message}`);
  }
  return { result: payload?.result ?? null, sessionId: sid };
}

/** Extract the last JSON-RPC message from a text/event-stream body. */
function parseSse(text) {
  const chunks = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .join("\n");
    if (data) chunks.push(data);
  }
  for (let i = chunks.length - 1; i >= 0; i--) {
    try {
      const msg = JSON.parse(chunks[i]);
      if (msg.id !== undefined || msg.result || msg.error) return msg;
    } catch {
      /* keep looking */
    }
  }
  throw new Error("no JSON-RPC message found in SSE response");
}

function fmtDeadline(s) {
  if (!s) return "—";
  return s.replace("T", " ").replace(/\.\d+Z$/, "Z");
}

function printTable(items, meta) {
  console.log(
    `Agent Bounty Feed — ${meta.count} shown of ${meta.total_matching} matching ` +
      `(generated ${meta.generated_at})`
  );
  console.log("");
  const rows = items.map((b) => ({
    usd: b.est_usd == null ? "?" : `$${Number(b.est_usd).toFixed(2)}`,
    board: String(b.source || "").slice(0, 11),
    slots: b.slots_left == null ? "—" : String(b.slots_left),
    deadline: fmtDeadline(b.deadline),
    title: String(b.title || "").replace(/\s+/g, " ").slice(0, 46),
    url: String(b.url || ""),
  }));
  const head = ["USD", "BOARD", "SLOTS", "DEADLINE", "TITLE", "URL"];
  const widths = head.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(Object.values(r)[i]).length))
  );
  const line = (cells) =>
    cells.map((c, i) => String(c).padEnd(widths[i])).join("  ").trimEnd();
  console.log(line(head));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) console.log(line(Object.values(r)));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  // 1. initialize
  let out = await rpc(args.url, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "agent-bounty-feed-client", version: "1.0.0" },
    },
  });
  const sessionId = out.sessionId;
  if (!out.result) throw new Error("initialize returned no result");

  // 2. notifications/initialized (notifications have no id and no response)
  try {
    await rpc(args.url, { jsonrpc: "2.0", method: "notifications/initialized" }, sessionId);
  } catch {
    // Some servers do not require it; continue.
  }

  // 3. optional tools/list
  if (args.tools) {
    out = await rpc(args.url, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, sessionId);
    const tools = out.result?.tools || [];
    console.error(`tools: ${tools.map((t) => t.name).join(", ")}`);
  }

  // 4. tools/call list_bounties
  const toolArgs = {
    min_usd: args.minUsd,
    limit: args.limit,
    sort: args.sort,
  };
  if (args.source) toolArgs.source = args.source;
  if (args.exclude) toolArgs.exclude_requires = args.exclude;

  out = await rpc(
    args.url,
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "list_bounties", arguments: toolArgs },
    },
    sessionId
  );

  const content = out.result?.content;
  const text = Array.isArray(content) ? content.find((c) => c.type === "text")?.text : null;
  if (!text) throw new Error("list_bounties returned no text content");

  const data = JSON.parse(text);
  if (args.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  printTable(data.items || [], data);
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exitCode = 1;
});
