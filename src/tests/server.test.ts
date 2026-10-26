import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../config.js";
import { EvolutionClient, type FetchLike } from "../evolution.js";
import { createServer } from "../server.js";

async function connect(respond: (url: string, body: unknown) => Response) {
  const cfg = loadConfig({
    EVOLUTION_API_KEY: "clave-secreta",
    EVOLUTION_INSTANCE: "inst",
    WHATSAPP_ME: "5219831111111",
    WHATSAPP_TEAM: "5219832222222,120363@g.us",
  });
  const sent: { url: string; body: unknown }[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    sent.push({ url: String(url), body });
    return respond(String(url), body);
  }) as FetchLike;
  const evolution = new EvolutionClient({
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    instance: cfg.instance,
    timeoutMs: 1000,
    fetch: fetchFn,
  });
  const server = createServer(cfg, evolution);
  const client = new Client({ name: "prueba", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, sent };
}

function textOf(result: unknown): string {
  return (result as { content: { text: string }[] }).content[0].text;
}

test("expone las 4 herramientas y el nombre del servidor", async () => {
  const { client } = await connect(() => new Response("{}", { status: 201 }));
  assert.equal(client.getServerVersion()?.name, "whatsapp-evolution");
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    "whatsapp_list_groups",
    "whatsapp_send_document",
    "whatsapp_send_text",
    "whatsapp_status",
  ]);
});

test("whatsapp_send_text a team reporta una línea por destinatario", async () => {
  const { client, sent } = await connect((_url, body) =>
    (body as { number: string }).number === "120363@g.us"
      ? new Response("x", { status: 404 })
      : new Response("{}", { status: 201 }),
  );
  const result = await client.callTool({ name: "whatsapp_send_text", arguments: { to: ["team"], text: "hola" } });
  assert.equal(sent.length, 2);
  const lines = textOf(result).split("\n");
  assert.equal(lines[0], "✔ 5219832222222 enviado");
  assert.match(lines[1], /^✖ 120363@g\.us /);
  assert.notEqual(result.isError, true);
});

test("whatsapp_send_text marca isError si todos fallan y no filtra la key", async () => {
  const { client } = await connect(() => new Response("x", { status: 401 }));
  const result = await client.callTool({ name: "whatsapp_send_text", arguments: { to: ["me"], text: "hola" } });
  assert.equal(result.isError, true);
  assert.ok(!textOf(result).includes("clave-secreta"));
});

test("whatsapp_send_text con destinatario inválido no envía nada", async () => {
  const { client, sent } = await connect(() => new Response("{}", { status: 201 }));
  const result = await client.callTool({ name: "whatsapp_send_text", arguments: { to: ["abc"], text: "hola" } });
  assert.equal(result.isError, true);
  assert.equal(sent.length, 0);
});

test("whatsapp_send_document usa text/plain por defecto", async () => {
  const { client, sent } = await connect(() => new Response("{}", { status: 201 }));
  await client.callTool({
    name: "whatsapp_send_document",
    arguments: { to: ["me"], filename: "r.txt", content: "hola" },
  });
  assert.equal((sent[0].body as { mimetype: string }).mimetype, "text/plain");
});

test("whatsapp_status muestra instancia, estado y URL sin la key", async () => {
  const { client } = await connect(
    () => new Response(JSON.stringify({ instance: { instanceName: "inst", state: "open" } }), { status: 200 }),
  );
  const out = textOf(await client.callTool({ name: "whatsapp_status", arguments: {} }));
  assert.match(out, /Instancia: inst/);
  assert.match(out, /Estado: open/);
  assert.match(out, /URL base: http:\/\/localhost:8080/);
  assert.ok(!out.includes("clave-secreta"));
});

test("whatsapp_list_groups devuelve tabla", async () => {
  const { client } = await connect(
    () => new Response(JSON.stringify([{ id: "1@g.us", subject: "Equipo", size: 3 }]), { status: 200 }),
  );
  const out = textOf(await client.callTool({ name: "whatsapp_list_groups", arguments: {} }));
  assert.equal(out, "id | subject | size\n1@g.us | Equipo | 3");
});
