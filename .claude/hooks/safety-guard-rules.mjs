// ============================================================================
// SAFETY GUARD · reglas (sin dependencias). Decide si una llamada a una herramienta es peligrosa.
// ----------------------------------------------------------------------------
// Protege este repo (motor que manda órdenes REALES) de acciones que solo debe autorizar el dueño:
//   push-main      empujar/fusionar en main/master (git, y GitHub vía MCP)
//   force-push     push --force / --force-with-lease / +refspec
//   exec-live      poner EXEC_MODE=live (comando, archivo de configuración o variable de Railway)
//   hard-reset, discard-changes, git-clean, rm-rf, no-verify, drop-db, chmod-777, sudo-rm,
//   docker-prune, kubectl-delete, npm-publish
//   railway-risky  borrar servicios/volúmenes/dominios en Railway o aceptar despliegues
//   secret-in-file escribir una clave privada en un archivo
// Excepción deliberada y visible: anteponer `SAFETY_GUARD_ALLOW=<regla>` al comando Bash (o exportarla en el
// entorno del dueño). Solo debe usarse con orden expresa del dueño; queda registrado en el log.
// Límite honesto: es una barrera contra descuidos, no un sandbox; quien pueda editar .claude/ puede quitarla.
// ============================================================================
import { execFileSync } from 'node:child_process';

const RULES = {
  'push-main': 'Empujar o fusionar en main/master solo con orden expresa del dueño.',
  'force-push': 'Un push forzado reescribe la historia del remoto.',
  'exec-live': 'EXEC_MODE=live manda órdenes REALES a los exchanges; solo con orden expresa del dueño y tras validar en paper.',
  'hard-reset': 'git reset --hard descarta cambios sin posibilidad de volver.',
  'discard-changes': 'Descartar todos los cambios del árbol de trabajo.',
  'git-clean': 'git clean -f borra archivos sin seguimiento.',
  'rm-rf': 'rm -rf sobre la raíz, el HOME, el proyecto o todo un directorio.',
  'no-verify': '--no-verify se salta los controles previos al commit.',
  'drop-db': 'DROP TABLE/DATABASE destruye datos.',
  'chmod-777': 'chmod 777 deja archivos abiertos a todo el mundo.',
  'sudo-rm': 'sudo rm borra con privilegios de administrador.',
  'docker-prune': 'docker system prune borra imágenes y volúmenes.',
  'kubectl-delete': 'kubectl delete borra recursos del clúster.',
  'npm-publish': 'npm publish publica un paquete públicamente.',
  'railway-risky': 'Borrar/aceptar cosas en Railway afecta a producción.',
  'secret-in-file': 'No se escriben claves privadas en archivos del repo.',
};

// ---- utilidades de análisis del comando -----------------------------------------------------------------
const stripHeredocs = c => c.replace(/(<<-?\s*(['"]?)(\w+)\2)([^\n]*)\n[\s\S]*?\n\s*\3(?=\s|$)/g, '$4 ');
const stripQuotes = c => c.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
const segments = c => c.split(/&&|\|\||;|\||\n/).map(s => s.trim()).filter(Boolean);
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

function parseGit(tokens) {
  let i = 0;
  while (i < tokens.length && (ENV_ASSIGN.test(tokens[i]) || tokens[i] === 'sudo' || tokens[i] === 'command')) i++;
  if (tokens[i] !== 'git') return null;
  i++;
  while (i < tokens.length && tokens[i].startsWith('-')) i += (tokens[i] === '-c' || tokens[i] === '-C') ? 2 : 1;
  return { sub: tokens[i], args: tokens.slice(i + 1) };
}

const MAIN_REF = /^\+?(?:[^:]*:)?(?:refs\/heads\/)?(main|master)$/;

function branchNow(ctx) {
  if (ctx.currentBranch !== undefined) return ctx.currentBranch;
  try { return execFileSync('git', ['branch', '--show-current'], { cwd: ctx.cwd || process.cwd(), encoding: 'utf8', timeout: 3000 }).trim(); }
  catch { return ''; }
}

function checkGit(g, ctx) {
  const { sub, args } = g;
  if (sub === 'push') {
    const flags = args.filter(a => a.startsWith('-')), pos = args.filter(a => !a.startsWith('-'));
    const refs = pos.slice(1);
    if (flags.some(a => /^--force(-with-lease(=.*)?|-if-includes)?$/.test(a) || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a)) || refs.some(r => r.startsWith('+'))) return 'force-push';
    if (flags.includes('--mirror') || flags.includes('--all')) return 'push-main';
    if (refs.some(r => MAIN_REF.test(r))) return 'push-main';
    if (refs.length === 0 || refs.includes('HEAD')) { const b = branchNow(ctx); if (b === 'main' || b === 'master') return 'push-main'; }
  }
  if (sub === 'reset' && args.includes('--hard')) return 'hard-reset';
  if ((sub === 'checkout' && args.length && args[args.length - 1] === '.') || (sub === 'restore' && args.includes('.') && !args.includes('--staged'))) return 'discard-changes';
  if (sub === 'clean' && args.some(a => /^-[a-zA-Z]*f/.test(a) || a === '--force')) return 'git-clean';
  if (args.includes('--no-verify')) return 'no-verify';
  return null;
}

const DANGEROUS_RM_TARGET = /^(\/|\/\*|~|~\/|~\/\*|\$HOME|\$\{HOME\}|\.|\.\/|\.\.|\.\/\*|\*|\/home|\/home\/\w+|\/root)$/;
function checkNonGit(tokens, ctx) {
  let i = 0;
  while (i < tokens.length && (ENV_ASSIGN.test(tokens[i]) || tokens[i] === 'command')) i++;
  let sudo = false; if (tokens[i] === 'sudo') { sudo = true; i++; }
  const cmd = tokens[i], args = tokens.slice(i + 1);
  if (cmd === 'rm') {
    if (sudo) return 'sudo-rm';
    const flags = args.filter(a => a.startsWith('-')).join('');
    if (/r|R/.test(flags) && /f/.test(flags)) {
      const targets = args.filter(a => !a.startsWith('-')).map(a => a.replace(/^"+|"+$/g, ''));
      const root = (ctx.cwd || process.cwd()).replace(/\/+$/, '');
      if (targets.some(t => DANGEROUS_RM_TARGET.test(t) || (root && (t === root || t === root + '/')))) return 'rm-rf';
    }
  }
  if (cmd === 'chmod' && args.some(a => /^[0-7]*777$/.test(a)) ) return 'chmod-777';
  if (cmd === 'docker' && args[0] === 'system' && args[1] === 'prune') return 'docker-prune';
  if (cmd === 'kubectl' && args[0] === 'delete') return 'kubectl-delete';
  if (cmd === 'npm' && args[0] === 'publish') return 'npm-publish';
  return null;
}

const EXEC_LIVE = /\bEXEC_MODE['"]?\s*[=:]\s*['"]?live\b/i;   // cubre EXEC_MODE=live, EXEC_MODE="live" y "EXEC_MODE": "live" (JSON)
const CONFIG_FILE = /(^|\/)(\.env[^/]*|[^/]*\.(ya?ml|toml|json)|Dockerfile|Procfile|railway[^/]*)$/i;

// ---- evaluación ---------------------------------------------------------------------------------------------
// input: { tool_name, tool_input }   ctx: { env?, cwd?, currentBranch? }
// Devuelve null (permitido) o { rule, reason, allowed } (allowed=true si hay excepción explícita).
export function evaluate(input, ctx = {}) {
  const env = ctx.env || process.env;
  if (env.SAFETY_GUARD === 'off') return null;
  const name = String((input && input.tool_name) || ''), ti = (input && input.tool_input) || {};
  const allowEnv = String(env.SAFETY_GUARD_ALLOW || '').split(',').map(s => s.trim()).filter(Boolean);
  const hit = (rule, extra = '', inline = []) => ({ rule, reason: RULES[rule] + (extra ? ' ' + extra : ''), allowed: allowEnv.includes(rule) || inline.includes(rule) });

  if (name === 'Bash') {
    const raw = String(ti.command || '');
    const noDocs = stripHeredocs(raw);
    const isCommit = /\bgit\b[^\n]*\bcommit\b/.test(noDocs);
    const inline = [...noDocs.matchAll(/\bSAFETY_GUARD_ALLOW=([\w,-]+)/g)].flatMap(m => m[1].split(','));
    const clean = stripQuotes(noDocs);
    for (const seg of segments(clean)) {
      const tokens = seg.split(/\s+/);
      const g = parseGit(tokens);
      const rule = g ? checkGit(g, ctx) : checkNonGit(tokens, ctx);
      if (rule) return hit(rule, '', inline);
    }
    // EXEC_MODE=live: en el comando, salvo dentro del mensaje de un commit
    const liveText = isCommit ? clean : noDocs;
    if (EXEC_LIVE.test(liveText) || (/\bEXEC_MODE\b/.test(liveText) && /\blive\b/.test(liveText) && />>?\s*\S*\.env|sed\s+-i/.test(liveText))) return hit('exec-live', '', inline);
    if (/\bDROP\s+(TABLE|DATABASE)\b/i.test(noDocs) && !isCommit) return hit('drop-db', '', inline);
    return null;
  }

  if (name === 'Write' || name === 'Edit' || name === 'MultiEdit') {
    const file = String(ti.file_path || '');
    const texts = [ti.content, ti.new_string, ...(Array.isArray(ti.edits) ? ti.edits.map(e => e && e.new_string) : [])].filter(t => typeof t === 'string');
    if (texts.some(t => /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(t))) return hit('secret-in-file');
    if (CONFIG_FILE.test(file) && texts.some(t => EXEC_LIVE.test(t))) return hit('exec-live', `(archivo ${file})`);
    return null;
  }

  if (name.startsWith('mcp__Railway__')) {
    const tool = name.slice('mcp__Railway__'.length);
    if (tool === 'set-variables' && EXEC_LIVE.test(JSON.stringify(ti)) || (tool === 'set-variables' && /EXEC_MODE/i.test(JSON.stringify(ti)) && /\blive\b/i.test(JSON.stringify(ti)))) return hit('exec-live', '(variable de Railway)');
    if (/^delete-/.test(tool) || tool === 'accept-deploy' || tool === 'reset-bucket-credentials') return hit('railway-risky', `(${tool})`);
    return null;
  }

  if (name.startsWith('mcp__github__')) {
    const tool = name.slice('mcp__github__'.length);
    if (['push_files', 'create_or_update_file', 'delete_file'].includes(tool) && /^(main|master)$/.test(String(ti.branch || ''))) return hit('push-main', `(${tool} en ${ti.branch})`);
    if (tool === 'merge_pull_request') return hit('push-main', '(fusionar una PR puede escribir en main)');
    return null;
  }
  return null;
}

export const RULE_IDS = Object.keys(RULES);
