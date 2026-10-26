import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigError, loadConfig, resolveBaseUrl, resolveRecipients } from "../config.js";

const cfg = { me: "5219831111111", team: ["5219832222222", "120363000000000000@g.us", "5219831111111"] };

test("resolveRecipients: me y team se expanden", () => {
  const r = resolveRecipients(["me"], cfg);
  assert.deepEqual(r, { ok: true, recipients: ["5219831111111"] });
  const t = resolveRecipients(["team"], cfg);
  assert.deepEqual(t, { ok: true, recipients: ["5219832222222", "120363000000000000@g.us", "5219831111111"] });
});

test("resolveRecipients: deduplica conservando el orden", () => {
  const r = resolveRecipients(["me", "team", "5219833333333", "5219833333333"], cfg);
  assert.deepEqual(r, {
    ok: true,
    recipients: ["5219831111111", "5219832222222", "120363000000000000@g.us", "5219833333333"],
  });
});

test("resolveRecipients: acepta JIDs de grupo y de usuario", () => {
  const r = resolveRecipients(["120363111@g.us", "5219831111111@s.whatsapp.net"], cfg);
  assert.deepEqual(r, { ok: true, recipients: ["120363111@g.us", "5219831111111@s.whatsapp.net"] });
});

test("resolveRecipients: alias sin configurar produce error", () => {
  const me = resolveRecipients(["me"], { me: undefined, team: [] });
  assert.equal(me.ok, false);
  const team = resolveRecipients(["team"], { me: "1", team: [] });
  assert.equal(team.ok, false);
});

test("resolveRecipients: destinatarios inválidos", () => {
  for (const bad of ["abc", "+5219831111111", "5219 831", "x@gmail.com", "@g.us", ""]) {
    const r = resolveRecipients([bad], cfg);
    assert.equal(r.ok, false, `debería rechazar '${bad}'`);
    if (!r.ok) assert.match(r.error, /inválido/);
  }
});

test("loadConfig: valores por defecto y recorte de barra final", () => {
  const c = loadConfig({ EVOLUTION_API_KEY: "k", EVOLUTION_INSTANCE: "i" });
  assert.equal(c.baseUrl, "http://localhost:8080");
  assert.equal(c.timeoutMs, 30000);
  assert.equal(c.transport, "stdio");
  assert.equal(c.port, 8787);
  assert.equal(c.host, "127.0.0.1");
  assert.deepEqual(c.team, []);
  assert.equal(c.me, undefined);

  const d = loadConfig({
    EVOLUTION_API_KEY: "k",
    EVOLUTION_INSTANCE: "i",
    EVOLUTION_BASE_URL: "http://evolution-api:8080//",
    WHATSAPP_TEAM: " 1 , 2,,3 ",
    MCP_TRANSPORT: "http",
    MCP_PORT: "9000",
    MCP_HOST: "0.0.0.0",
    EVOLUTION_TIMEOUT_MS: "5000",
  });
  assert.equal(d.baseUrl, "http://evolution-api:8080");
  assert.deepEqual(d.team, ["1", "2", "3"]);
  assert.equal(d.transport, "http");
  assert.equal(d.port, 9000);
  assert.equal(d.host, "0.0.0.0");
  assert.equal(d.timeoutMs, 5000);
});

test("loadConfig: sin API key falla sin filtrar otros valores", () => {
  const secretInstance = "instancia-secreta-xyz";
  const secretUrl = "http://host-secreto.example:8080";
  assert.throws(
    () => loadConfig({ EVOLUTION_INSTANCE: secretInstance, EVOLUTION_BASE_URL: secretUrl, WHATSAPP_ME: "5219839999999" }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /EVOLUTION_API_KEY/);
      assert.ok(!error.message.includes(secretInstance));
      assert.ok(!error.message.includes(secretUrl));
      assert.ok(!error.message.includes("5219839999999"));
      return true;
    },
  );
});

test("loadConfig: transporte o números inválidos", () => {
  const base = { EVOLUTION_API_KEY: "k", EVOLUTION_INSTANCE: "i" };
  assert.throws(() => loadConfig({ ...base, MCP_TRANSPORT: "ws" }), ConfigError);
  assert.throws(() => loadConfig({ ...base, MCP_PORT: "abc" }), ConfigError);
  assert.throws(() => loadConfig({ ...base, EVOLUTION_TIMEOUT_MS: "0" }), ConfigError);
});

test("resolveBaseUrl: en contenedor traduce localhost y 127.0.0.1 a host.docker.internal", () => {
  assert.equal(resolveBaseUrl("http://localhost:8080", true), "http://host.docker.internal:8080");
  assert.equal(resolveBaseUrl("http://127.0.0.1:8080/base/", true), "http://host.docker.internal:8080/base");
});

test("resolveBaseUrl: no cambia otros hosts ni fuera de contenedor", () => {
  assert.equal(resolveBaseUrl("http://evolution-api:8080", true), "http://evolution-api:8080");
  assert.equal(resolveBaseUrl("https://evo.midominio.com", true), "https://evo.midominio.com");
  assert.equal(resolveBaseUrl("http://localhost:8080", false), "http://localhost:8080");
});

test("resolveBaseUrl: URL inválida en contenedor lanza ConfigError sin filtrar el valor", () => {
  assert.throws(
    () => resolveBaseUrl("no-es-una-url-secreta", true),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.ok(!error.message.includes("no-es-una-url-secreta"));
      return true;
    },
  );
});

test("loadConfig: RUNNING_IN_CONTAINER=1 usa la URL efectiva", () => {
  const base = { EVOLUTION_API_KEY: "k", EVOLUTION_INSTANCE: "i", EVOLUTION_BASE_URL: "http://localhost:8080/" };
  assert.equal(loadConfig({ ...base, RUNNING_IN_CONTAINER: "1" }).baseUrl, "http://host.docker.internal:8080");
  assert.equal(loadConfig(base).baseUrl, "http://localhost:8080");
});
