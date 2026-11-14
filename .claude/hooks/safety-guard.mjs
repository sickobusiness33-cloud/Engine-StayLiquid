#!/usr/bin/env node
// Hook PreToolUse de Claude Code: lee la llamada a la herramienta por stdin y la bloquea (exit 2) si es peligrosa.
// Reglas en safety-guard-rules.mjs. Registro de lo bloqueado: ~/.claude/safety-guard.log (sin secretos).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluate } from './safety-guard-rules.mjs';

const redact = s => String(s).replace(/((?:key|secret|token|password|passphrase|signature)\w*\s*[=:]\s*)\S+/gi, '$1[redacted]');
function log(line) {
  try {
    const dir = path.join(os.homedir(), '.claude'); fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'safety-guard.log'), `${new Date().toISOString()} ${line}\n`);
  } catch { /* el log nunca debe romper el hook */ }
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { raw += d; });
process.stdin.on('end', () => {
  let input; try { input = JSON.parse(raw); } catch { process.exit(0); }   // entrada ilegible: no bloquear herramientas por un fallo del guardia
  let res = null;
  try { res = evaluate(input, { cwd: input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd() }); }
  catch (e) { log(`ERROR evaluando: ${String(e && e.message).slice(0, 120)}`); process.exit(0); }
  if (!res) process.exit(0);
  const what = redact(JSON.stringify(input.tool_input || {})).slice(0, 160);
  if (res.allowed) { log(`EXCEPCION regla=${res.rule} tool=${input.tool_name} ${what}`); process.exit(0); }
  log(`BLOQUEADO regla=${res.rule} tool=${input.tool_name} ${what}`);
  process.stderr.write(
    `SAFETY-GUARD bloqueó esta acción [${res.rule}]: ${res.reason}\n` +
    `No la reintentes por otra vía. Pide al dueño una orden expresa; con ella, antepón SAFETY_GUARD_ALLOW=${res.rule} al comando (solo Bash).\n`);
  process.exit(2);
});
