/**
 * F11 H11.2 — mede o classificador de confirmação contra uma amostra rotulada.
 * Uso: node scripts/f11-measure-confirm.mjs <dev|heldout> [--show]
 * Na amostra RESERVADA nunca imprime frases individuais (só agregados): inspecionar falhas
 * a transformaria em amostra de desenvolvimento.
 */
import fs from 'node:fs';
import path2 from 'node:path';
import { classifyConfirmation } from '../dist/server/backend/voice/confirmationClassifier.js';

const split = process.argv[2] || 'dev';
const show = process.argv.includes('--show') && !split.startsWith('heldout');

// Validação do harness contra casos conhecidos escritos à mão (lição da "repetição fantasma").
const known = [['sim', 'SIM'], ['não', 'NAO'], ['hum', 'AMBIGUO'], ['pode sim', 'SIM'], ['nem, depois eu faço', 'NAO']];
for (const [t, want] of known) {
  const got = classifyConfirmation(t).verdict;
  if (got !== want) { console.error(`HARNESS INVÁLIDO: "${t}" -> ${got}, esperado ${want}`); process.exit(2); }
}

const devTexts = new Set();
for (const f of fs.readdirSync('docs/audits/f11/raw')) {
  if (/^dev\d*\.jsonl$/.test(f)) for (const l of fs.readFileSync(path2.join('docs/audits/f11/raw', f), 'utf8').trim().split('\n')) devTexts.add(JSON.parse(l).text.trim().toLowerCase());
}
const isNovel = (r) => !devTexts.has(r.text.trim().toLowerCase());
const rows = fs.readFileSync(`docs/audits/f11/raw/${split}.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  .filter((r) => r.label.startsWith('CONF_'));
const onlyNovel = process.env.F11_NOVEL === '1';
if (onlyNovel) { const k = rows.filter(isNovel); rows.length = 0; rows.push(...k); console.log(`(apenas itens INÉDITOS, ausentes de qualquer amostra dev: ${k.length})`); }
const by = {};
let falseSim = 0;
for (const r of rows) {
  const v = classifyConfirmation(r.text).verdict;
  // segurança: SIM com ação pendente de criar/editar conta como execução indevida nas não-afirmativas.
  // (Verbo de apagar como resposta a pendente de APAGAR é afirmação legítima, não negação.)
  const anySim = ['LEMBRETE_CRIAR', 'LEMBRETE_EDITAR'].some((k) => classifyConfirmation(r.text, k).verdict === 'SIM');
  const b = (by[r.label] ??= { n: 0, SIM: 0, NAO: 0, AMBIGUO: 0 });
  b.n++; b[v]++;
  if (r.label !== 'CONF_SIM' && anySim) { falseSim++; if (show) console.log(`FALSO SIM [${r.label}] "${r.text}"`); }
  if (show && r.label === 'CONF_SIM' && v !== 'SIM') console.log(`PERDA [${v}] "${r.text}"`);
  if (show && r.label === 'CONF_NAO_CLARA' && v !== 'NAO') console.log(`NAO_CLARA->${v} "${r.text}"`);
}
console.log(JSON.stringify(by, null, 1));
const sim = by.CONF_SIM;
const neg = rows.filter((r) => r.label !== 'CONF_SIM').length;
console.log(`split=${split} afirmativas aceitas na 1a resposta: ${sim.SIM}/${sim.n} = ${(100 * sim.SIM / sim.n).toFixed(1)}%`);
console.log(`falsos SIM em ${neg} negações/ambiguidades/ruídos: ${falseSim}`);
