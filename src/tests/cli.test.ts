import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHookMessage } from "../cli.js";

test("Notification usa title y mensaje", () => {
  const msg = buildHookMessage({
    hook_event_name: "Notification",
    title: "Permiso requerido",
    notification_type: "permission_prompt",
    message: "Claude necesita tu permiso para ejecutar Bash",
    cwd: "C:\\proyectos\\Proyecto",
  });
  assert.equal(
    msg,
    "[Claude Code] Permiso requerido\nClaude necesita tu permiso para ejecutar Bash\nProyecto: C:\\proyectos\\Proyecto",
  );
});

test("Notification sin title usa notification_type", () => {
  const msg = buildHookMessage({
    hook_event_name: "Notification",
    notification_type: "idle_prompt",
    message: "Esperando tu respuesta",
    cwd: "C:\\proyectos\\P",
  });
  assert.equal(msg, "[Claude Code] idle_prompt\nEsperando tu respuesta\nProyecto: C:\\proyectos\\P");
});

test("Stop incluye el último mensaje", () => {
  const msg = buildHookMessage({
    hook_event_name: "Stop",
    cwd: "C:\\proyectos\\P",
    last_assistant_message: "Listo, compilación exitosa.",
  });
  assert.equal(msg, "[Claude Code] Terminó en C:\\proyectos\\P\nListo, compilación exitosa.");
});

test("Stop recorta a 1500 caracteres con elipsis", () => {
  const msg = buildHookMessage({
    hook_event_name: "Stop",
    cwd: "C:\\proyectos\\P",
    last_assistant_message: "a".repeat(2000),
  });
  assert.equal(msg, `[Claude Code] Terminó en C:\\proyectos\\P\n${"a".repeat(1500)}…`);

  const exact = buildHookMessage({ hook_event_name: "Stop", cwd: "c", last_assistant_message: "b".repeat(1500) });
  assert.equal(exact, `[Claude Code] Terminó en c\n${"b".repeat(1500)}`);
});

test("Stop con stop_hook_active no envía nada", () => {
  const msg = buildHookMessage({
    hook_event_name: "Stop",
    cwd: "C:\\proyectos\\P",
    stop_hook_active: true,
    last_assistant_message: "x",
  });
  assert.equal(msg, undefined);
});

test("otro evento usa nombre y proyecto", () => {
  const msg = buildHookMessage({ hook_event_name: "SubagentStop", cwd: "C:\\proyectos\\P" });
  assert.equal(msg, "[Claude Code] SubagentStop\nProyecto: C:\\proyectos\\P");
});
