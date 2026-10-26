// Configuracion del servidor: todo se lee de variables de entorno.

export interface Config {
  baseUrl: string;
  apiKey: string;
  instance: string;
  me: string | undefined;
  team: string[];
  timeoutMs: number;
  transport: "stdio" | "http";
  host: string;
  port: number;
}

export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

function positiveInt(env: Env, name: string, fallback: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new ConfigError(`La variable ${name} debe ser un entero entre 1 y ${max}.`);
  }
  return value;
}

// La URL de Evolution se escribe siempre desde la perspectiva del host (p. ej. http://localhost:8080).
// Dentro de un contenedor localhost apunta al propio contenedor, asi que se traduce a host.docker.internal;
// asi una sola URL sirve en Node, en docker compose y en docker run.
export function resolveBaseUrl(raw: string, runningInContainer: boolean): string {
  if (!runningInContainer) return raw;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError("La variable EVOLUTION_BASE_URL no es una URL válida.");
  }
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") return raw;
  url.hostname = "host.docker.internal";
  return url.toString().replace(/\/+$/, "");
}

// Nunca incluye valores de variables en los mensajes: solo sus nombres.
export function loadConfig(env: Env = process.env): Config {
  const missing = ["EVOLUTION_API_KEY", "EVOLUTION_INSTANCE"].filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new ConfigError(`Falta configurar la(s) variable(s) de entorno requerida(s): ${missing.join(", ")}.`);
  }

  const transport = (env.MCP_TRANSPORT?.trim() || "stdio").toLowerCase();
  if (transport !== "stdio" && transport !== "http") {
    throw new ConfigError("La variable MCP_TRANSPORT debe ser 'stdio' o 'http'.");
  }

  const baseUrl = resolveBaseUrl(
    (env.EVOLUTION_BASE_URL?.trim() || "http://localhost:8080").replace(/\/+$/, ""),
    env.RUNNING_IN_CONTAINER === "1",
  );

  return {
    baseUrl,
    apiKey: env.EVOLUTION_API_KEY!.trim(),
    instance: env.EVOLUTION_INSTANCE!.trim(),
    me: env.WHATSAPP_ME?.trim() || undefined,
    team: (env.WHATSAPP_TEAM ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
    timeoutMs: positiveInt(env, "EVOLUTION_TIMEOUT_MS", 30_000, 600_000),
    transport,
    host: env.MCP_HOST?.trim() || "127.0.0.1",
    port: positiveInt(env, "MCP_PORT", 8787, 65_535),
  };
}

export type RecipientsResult = { ok: true; recipients: string[] } | { ok: false; error: string };

const DIGITS = /^\d+$/;
const JID = /^[0-9A-Za-z._:-]+@(g\.us|s\.whatsapp\.net)$/;

function isValidTarget(value: string): boolean {
  return DIGITS.test(value) || JID.test(value);
}

// Expande los alias 'me' y 'team', valida cada destinatario y elimina duplicados conservando el orden.
export function resolveRecipients(
  to: string[],
  cfg: Pick<Config, "me" | "team">,
): RecipientsResult {
  const resolved: string[] = [];

  for (const entry of to) {
    const item = entry.trim();
    const alias = item.toLowerCase();

    if (alias === "me") {
      if (!cfg.me) return { ok: false, error: "El alias 'me' requiere configurar WHATSAPP_ME." };
      if (!isValidTarget(cfg.me)) {
        return { ok: false, error: "WHATSAPP_ME no es válido: usa solo dígitos con código de país o un JID." };
      }
      resolved.push(cfg.me);
    } else if (alias === "team") {
      if (cfg.team.length === 0) return { ok: false, error: "El alias 'team' requiere configurar WHATSAPP_TEAM." };
      if (!cfg.team.every(isValidTarget)) {
        return { ok: false, error: "WHATSAPP_TEAM contiene un destinatario no válido: usa solo dígitos con código de país o JIDs." };
      }
      resolved.push(...cfg.team);
    } else if (isValidTarget(item)) {
      resolved.push(item);
    } else {
      return {
        ok: false,
        error: "Destinatario inválido: usa 'me', 'team', un número solo con dígitos (con código de país) o un JID terminado en @g.us o @s.whatsapp.net.",
      };
    }
  }

  return { ok: true, recipients: [...new Set(resolved)] };
}
