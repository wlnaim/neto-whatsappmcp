import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { ConfigError, loadConfig, resolveRecipients } from "./config.js";
import { EvolutionClient, formatOutcomes, sendToMany } from "./evolution.js";

const MAX_LAST_MESSAGE = 1500;

export interface HookPayload {
  hook_event_name?: string;
  cwd?: string;
  title?: string;
  message?: string;
  notification_type?: string;
  stop_hook_active?: boolean;
  last_assistant_message?: string;
}

// Arma el aviso de WhatsApp a partir del JSON que Claude Code entrega al hook.
// Devuelve undefined cuando no hay que enviar nada (Stop reentrante).
export function buildHookMessage(payload: HookPayload): string | undefined {
  const cwd = payload.cwd ?? "(desconocido)";

  if (payload.hook_event_name === "Notification") {
    return `[Claude Code] ${payload.title ?? payload.notification_type ?? "Aviso"}\n${payload.message ?? ""}\nProyecto: ${cwd}`;
  }
  if (payload.hook_event_name === "Stop") {
    if (payload.stop_hook_active === true) return undefined;
    const last = payload.last_assistant_message ?? "";
    const shown = last.length > MAX_LAST_MESSAGE ? `${last.slice(0, MAX_LAST_MESSAGE)}…` : last;
    return `[Claude Code] Terminó en ${cwd}\n${shown}`;
  }
  return `[Claude Code] ${payload.hook_event_name ?? "Evento"}\nProyecto: ${cwd}`;
}

function createClient() {
  const cfg = loadConfig();
  const client = new EvolutionClient({
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    instance: cfg.instance,
    timeoutMs: cfg.timeoutMs,
  });
  return { cfg, client };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function runSend(args: string[]): Promise<number> {
  let values: { to?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({ args, options: { to: { type: "string" } }, allowPositionals: true }));
  } catch {
    console.error('Uso: send --to <destino1,destino2> "<texto>"');
    return 2;
  }
  const textToSend = positionals.join(" ").trim();
  if (!values.to || !textToSend) {
    console.error('Uso: send --to <destino1,destino2> "<texto>"');
    return 2;
  }

  const { cfg, client } = createClient();
  const resolved = resolveRecipients(values.to.split(","), cfg);
  if (!resolved.ok) {
    console.error(resolved.error);
    return 1;
  }
  const outcomes = await sendToMany(resolved.recipients, (recipient) => client.sendText(recipient, textToSend));
  console.log(formatOutcomes(outcomes));
  return outcomes.every((o) => o.result.ok) ? 0 : 1;
}

async function runHook(): Promise<number> {
  const { cfg, client } = createClient();

  let message: string | undefined;
  try {
    message = buildHookMessage(JSON.parse(await readStdin()) as HookPayload);
  } catch {
    console.error("El hook no recibió un JSON válido por stdin.");
    return 0;
  }
  if (message === undefined) return 0;

  const resolved = resolveRecipients(["me"], cfg);
  if (!resolved.ok) {
    console.error(resolved.error);
    return 1;
  }
  const outcomes = await sendToMany(resolved.recipients, (recipient) => client.sendText(recipient, message));
  // Un fallo de envío no debe romper a Claude Code: se informa por stderr y se sale con 0.
  if (!outcomes.every((o) => o.result.ok)) console.error(formatOutcomes(outcomes));
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === "send") return await runSend(rest);
    if (command === "hook") return await runHook();
  } catch (error) {
    console.error(error instanceof ConfigError ? error.message : "Error inesperado al ejecutar el comando.");
    return 1;
  }
  console.error('Uso: cli.js send --to <destino1,destino2> "<texto>" | cli.js hook');
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
