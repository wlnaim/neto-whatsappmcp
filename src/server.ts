import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveRecipients, type Config } from "./config.js";
import {
  EvolutionClient,
  formatOutcomes,
  sendToMany,
  type SendResult,
} from "./evolution.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function text(message: string, isError = false): ToolResult {
  return { content: [{ type: "text", text: message }], ...(isError ? { isError: true } : {}) };
}

const TO_DESCRIPTION =
  "Destinatarios: 'me' (el propio usuario, WHATSAPP_ME), 'team' (todo el equipo, WHATSAPP_TEAM), " +
  "un número solo con dígitos y código de país (ej. 5219831234567) o un JID de grupo terminado en @g.us.";

async function deliver(
  cfg: Config,
  to: string[],
  send: (recipient: string) => Promise<SendResult>,
): Promise<ToolResult> {
  const resolved = resolveRecipients(to, cfg);
  if (!resolved.ok) return text(resolved.error, true);
  const outcomes = await sendToMany(resolved.recipients, send);
  return text(formatOutcomes(outcomes), outcomes.every((o) => !o.result.ok));
}

export function createServer(cfg: Config, client: EvolutionClient): McpServer {
  const server = new McpServer({ name: "whatsapp-evolution", version: "1.0.0" });

  server.registerTool(
    "whatsapp_send_text",
    {
      description:
        "Envía un mensaje de texto de WhatsApp. Úsala cuando el usuario pida avisarle a él mismo ('me'), " +
        "a su equipo ('team') o a números/grupos concretos: por ejemplo al terminar una construcción, " +
        "o para avisar que te detuviste esperando un dato o una decisión suya. " +
        "Devuelve una línea por destinatario con el resultado.",
      inputSchema: {
        to: z.array(z.string()).min(1).describe(TO_DESCRIPTION),
        text: z.string().min(1).describe("Texto del mensaje."),
      },
    },
    ({ to, text: body }) => deliver(cfg, to, (recipient) => client.sendText(recipient, body)),
  );

  server.registerTool(
    "whatsapp_send_document",
    {
      description:
        "Envía por WhatsApp un documento (por ejemplo un reporte) generado a partir de contenido de texto. " +
        "El contenido se envía como archivo adjunto con el nombre indicado. " +
        "Úsala para reportes largos; para avisos cortos usa whatsapp_send_text. " +
        "Devuelve una línea por destinatario con el resultado.",
      inputSchema: {
        to: z.array(z.string()).min(1).describe(TO_DESCRIPTION),
        filename: z.string().min(1).describe("Nombre del archivo con extensión, ej. reporte.md."),
        content: z.string().min(1).describe("Contenido de texto del documento."),
        mimetype: z.string().min(1).optional().describe("Tipo MIME del archivo. Por defecto text/plain."),
        caption: z.string().optional().describe("Texto opcional que acompaña al documento."),
      },
    },
    ({ to, filename, content, mimetype, caption }) =>
      deliver(cfg, to, (recipient) =>
        client.sendDocument(recipient, {
          filename,
          content,
          mimetype: mimetype ?? "text/plain",
          caption,
        }),
      ),
  );

  server.registerTool(
    "whatsapp_list_groups",
    {
      description:
        "Lista los grupos de WhatsApp de la instancia (id | subject | size). " +
        "Úsala para obtener el JID (@g.us) de un grupo antes de enviarle mensajes.",
      inputSchema: {},
    },
    async () => {
      try {
        const groups = await client.listGroups();
        const rows = groups.map((g) => `${g.id} | ${g.subject} | ${g.size}`);
        return text(["id | subject | size", ...rows].join("\n"));
      } catch (error) {
        return text(error instanceof Error ? error.message : "No se pudo listar los grupos.", true);
      }
    },
  );

  server.registerTool(
    "whatsapp_status",
    {
      description:
        "Consulta el estado de la conexión de la instancia de Evolution (por ejemplo 'open' = conectada) " +
        "y la URL base configurada. Úsala para diagnosticar antes de enviar mensajes.",
      inputSchema: {},
    },
    async () => {
      const header = `Instancia: ${cfg.instance}\nURL base: ${cfg.baseUrl}`;
      try {
        const state = await client.connectionState();
        return text(`${header}\nEstado: ${state.state}`);
      } catch (error) {
        const reason = error instanceof Error ? error.message : "No se pudo consultar el estado.";
        return text(`${header}\n${reason}`, true);
      }
    },
  );

  return server;
}
