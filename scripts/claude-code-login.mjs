#!/usr/bin/env node
// Fase 17 — N2 da reauditoria 2: o filho NÃO usa mais o Keychain (negado no sandbox). Ele se autentica por um token
// dedicado e revogável (`claude setup-token`) passado só no env do filho como CLAUDE_CODE_OAUTH_TOKEN.
// Este script NÃO gera nem lê o valor do token: só confere o arquivo (dono, 0600, sem symlink) e mostra os passos.
import os from 'node:os';
import path from 'node:path';
import { CLAUDE_OAUTH_TOKEN_FILE, loadClaudeOAuthToken } from '../dist/server/backend/agents/claudeCode.js';

const file = path.join(os.homedir(), CLAUDE_OAUTH_TOKEN_FILE);
const r = loadClaudeOAuthToken();
if (r.ok) {
  console.log(`OK: token dedicado presente em ${file} (0600). Agora rode  node scripts/claude-code-selftest.mjs`);
  process.exit(0);
}
console.log(`Token dedicado: ${r.reason}.`);
console.log('Passos (no Terminal do Mac, fora do app):');
console.log('  1) claude setup-token            # abre o login da Anthropic e mostra um token de longa duração');
console.log(`  2) mkdir -p "${path.dirname(file)}" && chmod 700 "${path.dirname(file)}"`);
console.log(`  3) copie o token mostrado e rode:  pbpaste > "${file}" && chmod 600 "${file}"`);
console.log('  4) limpe a área de transferência (copie qualquer outro texto)');
console.log('  5) node scripts/claude-code-selftest.mjs   # tem de terminar em APROVADO');
console.log('Para revogar: apague o arquivo e revogue o token em claude.ai (Configurações > Claude Code).');
process.exit(1);
