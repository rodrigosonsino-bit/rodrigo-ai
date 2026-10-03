/**
 * F11 — rotula, via modelo gratuito INDEPENDENTE do sistema, quais positivos de CRIAR/EDITAR/GUARDAR trazem
 * o conteúdo acionável (o texto a gravar). Pedidos sem conteúdo ("guarda isso pra mim") não são acionáveis.
 * Uso: node scripts/f11-label-content.mjs <split>   -> docs/audits/f11/raw/<split>.content.json
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const split = process.argv[2];
const rows = fs.readFileSync(`docs/audits/f11/raw/${split}.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const needs = rows.map((r, i) => ({ i, r })).filter(({ r }) => /_(CRIAR|EDITAR)$|^MEMORIA_GUARDAR$/.test(r.label));
const prompt = 'Para cada frase numerada, responda se ela traz o CONTEÚDO concreto a ser gravado/escrito (o texto da tarefa, nota, fato ou o texto novo), ' +
  'ou se é só o comando sem conteúdo ("guarda isso pra mim", "corrige a nota", "anota rapidinho"). ' +
  'Responda SOMENTE um array JSON de objetos {"i":<número>,"conteudo":true|false}.\n\n' +
  needs.map(({ i, r }) => `${i}. ${r.text}`).join('\n');
const out = spawnSync('opencode', ['run', prompt, '-m', 'nvidia/moonshotai/kimi-k3'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 600000, maxBuffer: 1 << 24 });
const m = out.stdout.match(/\[[\s\S]*\]/);
const arr = JSON.parse(m[0]);
const map = {};
for (const o of arr) map[o.i] = !!o.conteudo;
fs.writeFileSync(`docs/audits/f11/raw/${split}.content.json`, JSON.stringify(map));
console.log(`rotulados ${Object.keys(map).length}/${needs.length}; sem conteúdo: ${Object.values(map).filter((v) => !v).length}`);
