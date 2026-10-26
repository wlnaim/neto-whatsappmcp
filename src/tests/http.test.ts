import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../config.js";
import { EvolutionClient, type FetchLike } from "../evolution.js";
import { runHttp } from "../index.js";

let server: Server;
let port: number;

before(async () => {
  const cfg = {
    ...loadConfig({ EVOLUTION_API_KEY: "clave-secreta", EVOLUTION_INSTANCE: "inst", MCP_TRANSPORT: "http" }),
    port: 0,
  };
  const fetchFn = (async () => new Response("{}", { status: 201 })) as FetchLike;
  const client = new EvolutionClient({
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    instance: cfg.instance,
    timeoutMs: 1000,
    fetch: fetchFn,
  });
  server = await runHttp(cfg, client);
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function call(
  method: string,
  path: string,
  options: { body?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { agent: false, host: "127.0.0.1", port, method, path, headers: options.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

const MCP_HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "prueba", version: "1.0.0" } },
});

test("initialize sin header Origin responde 200 con el nombre del servidor", async () => {
  const res = await call("POST", "/mcp", { body: INITIALIZE, headers: MCP_HEADERS });
  assert.equal(res.status, 200);
  assert.match(res.text, /"name":"whatsapp-evolution"/);
});

test("initialize con Host de loopback y puerto explícito responde 200", async () => {
  const res = await call("POST", "/mcp", { body: INITIALIZE, headers: { ...MCP_HEADERS, Host: `localhost:${port}` } });
  assert.equal(res.status, 200);
});

test("Host ajeno se rechaza con 403 (DNS rebinding)", async () => {
  const res = await call("POST", "/mcp", { body: INITIALIZE, headers: { ...MCP_HEADERS, Host: "evil.example" } });
  assert.equal(res.status, 403);
  assert.doesNotMatch(res.text, /whatsapp-evolution/);
});

test("JSON inválido responde 400", async () => {
  const res = await call("POST", "/mcp", { body: "{no es json", headers: MCP_HEADERS });
  assert.equal(res.status, 400);
});

test("GET /mcp responde 405", async () => {
  const res = await call("GET", "/mcp");
  assert.equal(res.status, 405);
});

test("GET /healthz responde 200 ok", async () => {
  const res = await call("GET", "/healthz");
  assert.equal(res.status, 200);
  assert.equal(res.text, "ok");
});
