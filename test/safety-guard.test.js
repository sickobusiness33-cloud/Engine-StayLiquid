import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { evaluate, RULE_IDS } from '../.claude/hooks/safety-guard-rules.mjs';

const ctx = { env: {}, cwd: '/home/user/engine-stayliquid', currentBranch: 'version-victor' };
const bash = command => ({ tool_name: 'Bash', tool_input: { command } });
const rule = (input, c = ctx) => { const r = evaluate(input, c); return r && !r.allowed ? r.rule : null; };

test('bloquea empujar a main/master por cualquier vía', () => {
  for (const c of [
    'git push origin main', 'git push origin version-victor:main', 'git push origin HEAD:main', 'git push origin HEAD:refs/heads/main',
    'git -c push.negotiate=true push origin version-victor:main', 'git push origin master', 'git push origin --delete main', 'git push --mirror origin', 'git push --all origin',
    'cd x && git push origin main',
  ]) assert.equal(rule(bash(c)), 'push-main', c);
});

test('bloquea git push sin destino si la rama actual es main', () => {
  const onMain = { ...ctx, currentBranch: 'main' };
  assert.equal(rule(bash('git push'), onMain), 'push-main');
  assert.equal(rule(bash('git push origin'), onMain), 'push-main');
  assert.equal(rule(bash('git push origin HEAD'), onMain), 'push-main');
  assert.equal(rule(bash('git push'), ctx), null, 'en version-victor es normal');
});

test('bloquea push forzado', () => {
  for (const c of ['git push --force origin version-victor', 'git push -f origin x', 'git push --force-with-lease', 'git push origin +version-victor', 'git push -fu origin x'])
    assert.equal(rule(bash(c)), 'force-push', c);
});

test('permite los push normales a version-victor', () => {
  for (const c of ['git push -u origin version-victor', 'git -c push.negotiate=true push origin version-victor', 'git push origin version-victor:version-victor', 'git push origin feature/main-menu'])
    assert.equal(rule(bash(c)), null, c);
});

test('bloquea EXEC_MODE=live en comandos y en archivos de configuración', () => {
  for (const c of ['EXEC_MODE=live npm start', 'export EXEC_MODE=live', 'echo "EXEC_MODE=live" >> .env', 'cd x && EXEC_MODE="live" node engine.js'])
    assert.equal(rule(bash(c)), 'exec-live', c);
  assert.equal(rule(bash('EXEC_MODE=paper npm start')), null);
  assert.equal(rule({ tool_name: 'Write', tool_input: { file_path: '/p/.env', content: 'A=1\nEXEC_MODE=live\n' } }), 'exec-live');
  assert.equal(rule({ tool_name: 'Edit', tool_input: { file_path: '/p/railway.json', new_string: '"EXEC_MODE": "live"' } }), 'exec-live');
  assert.equal(rule({ tool_name: 'Write', tool_input: { file_path: '/p/README.md', content: 'Pon EXEC_MODE=live cuando todo esté validado' } }), null, 'la documentación puede mencionarlo');
  assert.equal(rule({ tool_name: 'Edit', tool_input: { file_path: '/p/.env.example', new_string: 'EXEC_MODE=paper' } }), null);
});

test('un mensaje de commit que menciona comandos peligrosos NO se bloquea', () => {
  const c = `git add -A && git commit -q -F - <<'EOF'\nfix: no empujar con git push origin main ni EXEC_MODE=live\nrm -rf / y DROP TABLE son ejemplos\nEOF\ngit status`;
  assert.equal(rule(bash(c)), null);
  assert.equal(rule(bash('git commit -m "docs: ejemplo git push origin main y EXEC_MODE=live"')), null);
});

test('bloquea las operaciones destructivas habituales', () => {
  const cases = {
    'git reset --hard HEAD~1': 'hard-reset', 'git checkout .': 'discard-changes', 'git checkout -- .': 'discard-changes', 'git restore .': 'discard-changes',
    'git clean -fd': 'git-clean', 'git commit --no-verify -m x': 'no-verify', 'rm -rf /': 'rm-rf', 'rm -rf ~': 'rm-rf', 'rm -rf .': 'rm-rf', 'rm -rf *': 'rm-rf',
    'rm -rf /home/user/engine-stayliquid': 'rm-rf', 'sudo rm -rf /tmp/x': 'sudo-rm', 'chmod 777 data': 'chmod-777', 'chmod -R 777 .': 'chmod-777',
    'docker system prune -a': 'docker-prune', 'kubectl delete pod x': 'kubectl-delete', 'npm publish': 'npm-publish', 'psql -c "DROP TABLE engine_kv"': 'drop-db',
  };
  for (const [c, r] of Object.entries(cases)) assert.equal(rule(bash(c)), r, c);
});

test('permite los comandos normales de trabajo', () => {
  for (const c of ['npm test', 'node --test test/close.test.js', 'git status -sb', 'git log --oneline -3', 'git checkout version-victor', 'git reset --soft HEAD~1', 'git restore --staged x.js',
    'rm -rf node_modules', 'rm -f data/orders.log', 'rm -rf /tmp/claude-0/x/smoke', 'curl -sS https://x.example/api/bot/health', 'git diff 4ab4e8e..HEAD --stat', 'chmod +x run.sh'])
    assert.equal(rule(bash(c)), null, c);
});

test('GitHub MCP: bloquea escribir/fusionar en main y permite version-victor', () => {
  assert.equal(rule({ tool_name: 'mcp__github__push_files', tool_input: { branch: 'main', files: [] } }), 'push-main');
  assert.equal(rule({ tool_name: 'mcp__github__create_or_update_file', tool_input: { branch: 'master', path: 'a' } }), 'push-main');
  assert.equal(rule({ tool_name: 'mcp__github__merge_pull_request', tool_input: { pullNumber: 1 } }), 'push-main');
  assert.equal(rule({ tool_name: 'mcp__github__push_files', tool_input: { branch: 'version-victor', files: [] } }), null);
  assert.equal(rule({ tool_name: 'mcp__github__get_file_contents', tool_input: { path: 'a' } }), null);
});

test('Railway MCP: bloquea EXEC_MODE=live y los borrados; permite lecturas', () => {
  assert.equal(rule({ tool_name: 'mcp__Railway__set-variables', tool_input: { variables: { EXEC_MODE: 'live' } } }), 'exec-live');
  assert.equal(rule({ tool_name: 'mcp__Railway__set-variables', tool_input: { variables: { EXEC_MODE: 'paper' } } }), null);
  assert.equal(rule({ tool_name: 'mcp__Railway__set-variables', tool_input: { variables: { POLL: '5000' } } }), null);
  for (const t of ['delete-service', 'delete-volume', 'delete-domain', 'accept-deploy', 'reset-bucket-credentials'])
    assert.equal(rule({ tool_name: 'mcp__Railway__' + t, tool_input: {} }), 'railway-risky', t);
  for (const t of ['get-logs', 'list-deployments', 'list-variables', 'list-projects'])
    assert.equal(rule({ tool_name: 'mcp__Railway__' + t, tool_input: {} }), null, t);
});

test('bloquea escribir una clave privada en un archivo', () => {
  assert.equal(rule({ tool_name: 'Write', tool_input: { file_path: '/p/k.txt', content: '-----BEGIN RSA PRIVATE KEY-----\nabc' } }), 'secret-in-file');
});

test('excepción explícita: SAFETY_GUARD_ALLOW=<regla> en el comando o en el entorno permite y queda marcada', () => {
  const r = evaluate(bash('SAFETY_GUARD_ALLOW=push-main git push origin version-victor:main'), ctx);
  assert.equal(r.rule, 'push-main'); assert.equal(r.allowed, true);
  const env = evaluate(bash('git push origin main'), { ...ctx, env: { SAFETY_GUARD_ALLOW: 'push-main,force-push' } });
  assert.equal(env.allowed, true);
  assert.equal(evaluate(bash('SAFETY_GUARD_ALLOW=push-main git push --force origin x'), ctx).allowed, false, 'la excepción solo vale para SU regla');
  assert.equal(evaluate(bash('git push origin main'), { ...ctx, env: { SAFETY_GUARD: 'off' } }), null, 'el dueño puede apagarlo');
});

test('el hook (proceso real): bloquea con código 2 y deja pasar con 0', () => {
  const run = input => spawnSync('node', ['.claude/hooks/safety-guard.mjs'], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, HOME: '/tmp/sl-guard-test-home' } });
  const bad = run(bash('git push origin version-victor:main'));
  assert.equal(bad.status, 2); assert.match(bad.stderr, /SAFETY-GUARD bloqueó.*push-main/);
  assert.equal(run(bash('npm test')).status, 0);
  assert.equal(spawnSync('node', ['.claude/hooks/safety-guard.mjs'], { input: 'no es json', encoding: 'utf8' }).status, 0, 'entrada ilegible: no bloquea');
});

test('todas las reglas declaradas tienen explicación', () => { assert.ok(RULE_IDS.length >= 15); });
