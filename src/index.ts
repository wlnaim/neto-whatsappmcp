import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ConfigError, loadConfig, type Config } from "./config.js";
import { EvolutionClient } from "./evolution.js";
import { createServer } from "./server.js";

const MAX_BODY_BYTES = 8 * 1024 * 1024;

class BodyTooLarge extends Error {}

function log(message: string): void {
  // En modo stdio stdout es el protocolo MCP: todo diagnóstico va a stderr.
  process.stderr.write(`${message}\n`);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function rpcError(code: number, message: string) {
  return { jsonrpc: "2.0", error: { code, message }, id: null };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) throw new BodyTooLarge();
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: Config,
  client: EvolutionClient,
  allowedHosts: string[],
): Promise<void> {
  if (req.method !== "POST") {
    sendJson(res, 405, rpcError(-32000, "Método no permitido."), { Allow: "POST" });
    return;
  }

  let body: unknown;
  try {
    body = JSON.parse(await readBody(req));
  } catch (error) {
    if (error instanceof BodyTooLarge) sendJson(res, 413, rpcError(-32000, "Solicitud demasiado grande."));
    else sendJson(res, 400, rpcError(-32700, "JSON inválido."));
    return;
  }

  // Sin estado: un servidor y un transporte nuevos por cada petición.
  const server = createServer(cfg, client);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    // Mitiga DNS rebinding: solo se aceptan los Host esperados. No se restringe Origin
    // para que los clientes sin ese header (Claude Code, curl) sigan funcionando.
    enableDnsRebindingProtection: true,
    allowedHosts,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

// Levanta el servidor HTTP y devuelve el servidor ya escuchando (port 0 = puerto efímero).
export async function runHttp(cfg: Config, client: EvolutionClient): Promise<Server> {
  let allowedHosts: string[] = [];
  const http = createHttpServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && path === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }
    if (path !== "/mcp") {
      sendJson(res, 404, rpcError(-32000, "No encontrado."));
      return;
    }
    handleMcp(req, res, cfg, client, allowedHosts).catch((error: unknown) => {
      log(`Error al atender la petición MCP: ${error instanceof Error ? error.message : "desconocido"}`);
      sendJson(res, 500, rpcError(-32603, "Error interno del servidor."));
    });
  });

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(cfg.port, cfg.host, resolve);
  });

  // El header Host incluye el puerto real, por eso se calcula después de escuchar.
  const port = (http.address() as AddressInfo).port;
  const names = ["127.0.0.1", "localhost", "[::1]"];
  if (cfg.host !== "0.0.0.0" && cfg.host !== "::" && !names.includes(cfg.host)) names.push(cfg.host);
  allowedHosts = names.flatMap((name) => [name, `${name}:${port}`]);

  log(`Servidor MCP whatsapp-evolution escuchando en ${cfg.host}:${port} (ruta /mcp).`);
  return http;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const client = new EvolutionClient({
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    instance: cfg.instance,
    timeoutMs: cfg.timeoutMs,
  });

  if (cfg.transport === "http") {
    const http = await runHttp(cfg, client);
    const shutdown = () => http.close(() => process.exit(0));
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  } else {
    await createServer(cfg, client).connect(new StdioServerTransport());
    log("Servidor MCP whatsapp-evolution listo (stdio).");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    log(error instanceof ConfigError ? error.message : `No se pudo iniciar el servidor: ${error instanceof Error ? error.message : "error desconocido"}`);
    process.exit(1);
  });
}
