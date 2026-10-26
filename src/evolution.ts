// Cliente de Evolution API. Nunca incluye la API key ni cuerpos de respuesta crudos en los errores.

export type FetchLike = typeof fetch;

export interface EvolutionOptions {
  baseUrl: string;
  apiKey: string;
  instance: string;
  timeoutMs: number;
  fetch?: FetchLike;
}

export type SendResult = { ok: true } | { ok: false; error: string };

export interface DocumentInput {
  filename: string;
  content: string;
  mimetype: string;
  caption?: string;
}

export interface GroupInfo {
  id: string;
  subject: string;
  size: number;
}

export interface ConnectionState {
  instanceName: string;
  state: string;
}

// Error con mensaje seguro para mostrar al usuario.
export class EvolutionError extends Error {}

const MAX_ERROR_BODY_BYTES = 16 * 1024;

type Outcome = { ok: true; response: Response; body?: unknown } | { ok: false; error: string };

export class EvolutionClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly instance: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: EvolutionOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.instance = options.instance;
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetch ?? fetch;
  }

  sendText(number: string, text: string): Promise<SendResult> {
    return this.send("message/sendText", { number, text });
  }

  sendDocument(number: string, doc: DocumentInput): Promise<SendResult> {
    return this.send("message/sendMedia", {
      number,
      mediatype: "document",
      mimetype: doc.mimetype,
      fileName: doc.filename,
      caption: doc.caption,
      media: Buffer.from(doc.content, "utf8").toString("base64"),
    });
  }

  async listGroups(): Promise<GroupInfo[]> {
    const outcome = await this.request("GET", "group/fetchAllGroups", "la consulta", undefined, "?getParticipants=false");
    if (!outcome.ok) throw new EvolutionError(outcome.error);
    if (!Array.isArray(outcome.body)) throw new EvolutionError("Evolution devolvió una respuesta inesperada al listar grupos.");
    return outcome.body.map((item: Record<string, unknown>) => ({
      id: String(item?.id ?? ""),
      subject: String(item?.subject ?? ""),
      size: typeof item?.size === "number" ? item.size : 0,
    }));
  }

  async connectionState(): Promise<ConnectionState> {
    const outcome = await this.request("GET", "instance/connectionState", "la consulta");
    if (!outcome.ok) throw new EvolutionError(outcome.error);
    const root = (outcome.body ?? {}) as Record<string, unknown>;
    const info = (root.instance ?? root) as Record<string, unknown>;
    if (typeof info.state !== "string") {
      throw new EvolutionError("Evolution devolvió una respuesta inesperada al consultar el estado de la instancia.");
    }
    return { instanceName: String(info.instanceName ?? this.instance), state: info.state };
  }

  private async send(endpoint: string, body: unknown): Promise<SendResult> {
    const outcome = await this.request("POST", endpoint, "el envío", body);
    return outcome.ok ? { ok: true } : { ok: false, error: outcome.error };
  }

  private async request(
    method: "GET" | "POST",
    endpoint: string,
    action: string,
    body?: unknown,
    query = "",
  ): Promise<Outcome> {
    const url = `${this.baseUrl}/${endpoint}/${encodeURIComponent(this.instance)}${query}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method,
        headers: {
          apikey: this.apiKey,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        return { ok: false, error: await describeFailure(response, action) };
      }
      if (method === "GET") {
        try {
          return { ok: true, response, body: await response.json() };
        } catch (error) {
          if (controller.signal.aborted) throw error;
          return { ok: false, error: `Evolution devolvió una respuesta inválida para ${action}.` };
        }
      }
      await response.body?.cancel();
      return { ok: true, response };
    } catch (error) {
      if (controller.signal.aborted || isAbort(error)) {
        return {
          ok: false,
          error:
            action === "el envío"
              ? "Evolution no respondió dentro del tiempo límite. La entrega no pudo confirmarse; revisa WhatsApp antes de reintentar."
              : "Evolution no respondió dentro del tiempo límite.",
        };
      }
      return {
        ok: false,
        error:
          action === "el envío"
            ? "No se pudo comunicar con Evolution. La entrega no pudo confirmarse; revisa la conexión y WhatsApp antes de reintentar."
            : "No se pudo comunicar con Evolution. Revisa la URL base y la conexión.",
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

async function describeFailure(response: Response, action: string): Promise<string> {
  const prefix = `Evolution rechazó ${action} (HTTP ${response.status}). `;
  const status = response.status;

  // Solo se extraen causas estructuradas y reconocidas de un cuerpo acotado; nunca se reenvía texto crudo.
  if (status === 400) {
    try {
      const text = await readLimited(response, MAX_ERROR_BODY_BYTES);
      if (text !== undefined) {
        const detail = (JSON.parse(text) as { response?: unknown }).response;
        if (numberDoesNotExist(detail)) {
          return prefix + "Evolution indica que el destinatario no existe en WhatsApp (exists: false). Verifica el número y código de país.";
        }
        if (missingRequiredField(detail)) {
          return prefix + "Evolution indica que falta un campo obligatorio del mensaje (number o text). Verifica la compatibilidad del servicio.";
        }
      }
    } catch {
      // Cuerpo ilegible o no JSON: se usa el mensaje genérico.
    }
    return prefix + "Verifica el destinatario y los datos de la solicitud; el servicio no proporcionó una causa reconocida.";
  }
  if (status === 401 || status === 403) return prefix + "Verifica las credenciales de Evolution y sus permisos.";
  if (status === 404) return prefix + "Verifica la URL base, el nombre de la instancia y el endpoint.";
  if (status === 429) return prefix + "Se alcanzó el límite de solicitudes. Espera antes de reintentar.";
  if (status >= 500) return prefix + "El servicio presentó un error interno. Revisa su estado antes de reintentar.";
  return prefix + "Revisa el estado y la configuración del servicio.";
}

// Lee como máximo `max` bytes; si el cuerpo es más grande devuelve undefined.
async function readLimited(response: Response, max: number): Promise<string | undefined> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function numberDoesNotExist(value: unknown, depth = 0): boolean {
  if (depth > 16) return false;
  if (Array.isArray(value)) return value.some((item) => numberDoesNotExist(item, depth + 1));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return record.exists === false || numberDoesNotExist(record.message, depth + 1);
  }
  return false;
}

function missingRequiredField(value: unknown, depth = 0): boolean {
  if (depth > 16) return false;
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    return lower.includes('requires property "number"') || lower.includes('requires property "text"');
  }
  if (Array.isArray(value)) return value.some((item) => missingRequiredField(item, depth + 1));
  if (value && typeof value === "object") return missingRequiredField((value as Record<string, unknown>).message, depth + 1);
  return false;
}

export interface SendOutcome {
  recipient: string;
  result: SendResult;
}

// Envía de forma secuencial a cada destinatario y devuelve el resultado individual.
export async function sendToMany(
  recipients: string[],
  send: (recipient: string) => Promise<SendResult>,
): Promise<SendOutcome[]> {
  const outcomes: SendOutcome[] = [];
  for (const recipient of recipients) {
    outcomes.push({ recipient, result: await send(recipient) });
  }
  return outcomes;
}

export function formatOutcomes(outcomes: SendOutcome[]): string {
  return outcomes
    .map(({ recipient, result }) => (result.ok ? `✔ ${recipient} enviado` : `✖ ${recipient} ${result.error}`))
    .join("\n");
}
