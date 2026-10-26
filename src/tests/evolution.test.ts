import { test } from "node:test";
import assert from "node:assert/strict";
import { EvolutionClient, EvolutionError, type FetchLike } from "../evolution.js";

interface Call {
  url: string;
  init: RequestInit;
}

function mockFetch(respond: (call: Call) => Response | Promise<Response>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as FetchLike;
  return { fetch: fetchFn, calls };
}

const API_KEY = "clave-super-secreta-123";

function client(fetchFn: FetchLike, timeoutMs = 1000) {
  return new EvolutionClient({
    baseUrl: "http://evo:8080",
    apiKey: API_KEY,
    instance: "Mi Instancia",
    timeoutMs,
    fetch: fetchFn,
  });
}

test("sendText arma URL, header apikey y body exactos", async () => {
  const { fetch, calls } = mockFetch(() => new Response("{}", { status: 201 }));
  const result = await client(fetch).sendText("5219831111111", "hola");
  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://evo:8080/message/sendText/Mi%20Instancia");
  assert.equal(calls[0].init.method, "POST");
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.apikey, API_KEY);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { number: "5219831111111", text: "hola" });
});

test("sendDocument codifica base64 y usa mediatype document", async () => {
  const { fetch, calls } = mockFetch(() => new Response("{}", { status: 201 }));
  const result = await client(fetch).sendDocument("5219831111111", {
    filename: "reporte.md",
    content: "Reporte ñ ✔",
    mimetype: "text/markdown",
    caption: "Resumen",
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls[0].url, "http://evo:8080/message/sendMedia/Mi%20Instancia");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    number: "5219831111111",
    mediatype: "document",
    mimetype: "text/markdown",
    fileName: "reporte.md",
    caption: "Resumen",
    media: Buffer.from("Reporte ñ ✔", "utf8").toString("base64"),
  });
});

test("400 con exists:false se clasifica como destinatario inexistente", async () => {
  const body = {
    status: 400,
    error: "Bad Request",
    response: { message: [[{ exists: false, jid: "5219830000000@s.whatsapp.net", number: "5219830000000" }]] },
  };
  const { fetch } = mockFetch(() => new Response(JSON.stringify(body), { status: 400 }));
  const result = await client(fetch).sendText("5219830000000", "x");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /HTTP 400/);
    assert.match(result.error, /no existe en WhatsApp/);
    assert.ok(!result.error.includes("5219830000000"));
  }
});

test("400 sin causa reconocida usa mensaje genérico sin reenviar el cuerpo", async () => {
  const { fetch } = mockFetch(() => new Response('{"response":{"message":"detalle-interno-sensible"}}', { status: 400 }));
  const result = await client(fetch).sendText("1", "x");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /no proporcionó una causa reconocida/);
    assert.ok(!result.error.includes("detalle-interno-sensible"));
  }
});

test("400 con cuerpo mayor a 16 KB no se interpreta", async () => {
  const huge = JSON.stringify({ response: { message: [[{ exists: false }]] }, relleno: "a".repeat(20_000) });
  const { fetch } = mockFetch(() => new Response(huge, { status: 400 }));
  const result = await client(fetch).sendText("1", "x");
  assert.equal(result.ok, false);
  if (!result.ok) assert.doesNotMatch(result.error, /no existe en WhatsApp/);
});

test("401 y 403 apuntan a credenciales sin filtrar la key", async () => {
  for (const status of [401, 403]) {
    const { fetch } = mockFetch(() => new Response(`{"error":"${API_KEY}"}`, { status }));
    const result = await client(fetch).sendText("1", "x");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /credenciales/);
      assert.ok(!result.error.includes(API_KEY));
    }
  }
});

test("404 apunta a URL base, instancia y endpoint", async () => {
  const { fetch } = mockFetch(() => new Response("no", { status: 404 }));
  const result = await client(fetch).sendText("1", "x");
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /URL base, el nombre de la instancia/);
});

test("429 y 5xx tienen mensajes propios", async () => {
  const r429 = await client(mockFetch(() => new Response("", { status: 429 })).fetch).sendText("1", "x");
  assert.ok(!r429.ok && /límite de solicitudes/.test(r429.error));
  const r500 = await client(mockFetch(() => new Response("", { status: 503 })).fetch).sendText("1", "x");
  assert.ok(!r500.ok && /error interno/.test(r500.error));
});

test("timeout se reporta como falta de respuesta dentro del tiempo límite", async () => {
  const { fetch } = mockFetch(
    ({ init }) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      }),
  );
  const result = await client(fetch, 20).sendText("1", "x");
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /no respondió dentro del tiempo límite/);
});

test("error de red no filtra detalles", async () => {
  const { fetch } = mockFetch(() => {
    throw new TypeError(`fetch failed http://evo:8080 apikey=${API_KEY}`);
  });
  const result = await client(fetch).sendText("1", "x");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /No se pudo comunicar con Evolution/);
    assert.ok(!result.error.includes(API_KEY));
  }
});

test("listGroups pide fetchAllGroups sin participantes y mapea campos", async () => {
  const { fetch, calls } = mockFetch(
    () =>
      new Response(
        JSON.stringify([
          { id: "120363@g.us", subject: "Equipo", size: 5, owner: "x" },
          { id: "999@g.us", subject: "Otro" },
        ]),
        { status: 200 },
      ),
  );
  const groups = await client(fetch).listGroups();
  assert.equal(calls[0].url, "http://evo:8080/group/fetchAllGroups/Mi%20Instancia?getParticipants=false");
  assert.equal(calls[0].init.method, "GET");
  assert.deepEqual(groups, [
    { id: "120363@g.us", subject: "Equipo", size: 5 },
    { id: "999@g.us", subject: "Otro", size: 0 },
  ]);
});

test("listGroups lanza EvolutionError con mensaje seguro si falla", async () => {
  const { fetch } = mockFetch(() => new Response("x", { status: 401 }));
  await assert.rejects(client(fetch).listGroups(), (error: unknown) => {
    assert.ok(error instanceof EvolutionError);
    assert.match(error.message, /credenciales/);
    return true;
  });
});

test("connectionState lee instance.state", async () => {
  const { fetch, calls } = mockFetch(
    () => new Response(JSON.stringify({ instance: { instanceName: "Mi Instancia", state: "open" } }), { status: 200 }),
  );
  const state = await client(fetch).connectionState();
  assert.equal(calls[0].url, "http://evo:8080/instance/connectionState/Mi%20Instancia");
  assert.deepEqual(state, { instanceName: "Mi Instancia", state: "open" });
});
