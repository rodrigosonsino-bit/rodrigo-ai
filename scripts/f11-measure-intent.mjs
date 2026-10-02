/**
 * F11 H11.1 — mede a detecção de intenção PONTA A PONTA, como o produto a executa:
 * mightBeMutation (filtro) -> detectMutation (LLM) ; senão mightBeTemporal -> detectTool.
 * Rejeição do filtro conta como falso negativo. Reservada: só agregados.
 * Uso: node scripts/f11-measure-intent.mjs <dev|dev2|heldout> [--show]
 */
import fs from 'node:fs';
import path from 'node:path';
import { MlxWorkerEngine } from '../dist/server/backend/voice/mlxWorkerEngine.js';
import { mightBeMutation } from '../dist/server/backend/tools/mutatingTools.js';
import { mightBeTemporal } from '../dist/server/backend/tools/systemTools.js';

const split = process.argv[2] || 'dev';
const show = process.argv.includes('--show') && split !== 'heldout';
const root = process.cwd();
const engine = new MlxWorkerEngine({
  pythonBin: path.join(root, '.runtime/.venv/bin/python3'),
  workerScript: path.join(root, 'scripts/worker/worker.py'),
  hfCacheDir: path.join(root, '.runtime/hf-cache')
});
await engine.waitUntilReady(180000);

const rows = fs.readFileSync(`docs/audits/f11/raw/${split}.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  .filter((r) => !r.label.startsWith('CONF_'));
const MUT = new Set(['LEMBRETE_CRIAR','LEMBRETE_EDITAR','LEMBRETE_APAGAR','NOTA_CRIAR','NOTA_EDITAR','NOTA_APAGAR','MEMORIA_GUARDAR','MEMORIA_EDITAR','MEMORIA_ESQUECER']);
let n = 0;
async function predict(text) {
  const id = `m${n++}`;
  if (mightBeMutation(text)) {
    const [action] = await engine.detectMutation(id, 0, text);
    if (action !== 'NENHUMA') return { pred: action, gate: true };
  }
  if (mightBeTemporal(text)) {
    const t = await engine.detectTool(id, 0, text);
    if (t !== 'NENHUMA') return { pred: t, gate: true };
  }
  return { pred: 'NENHUMA', gate: mightBeMutation(text) || mightBeTemporal(text) };
}
const norm = (l) => (l.startsWith('NENHUMA') ? 'NENHUMA' : l);

const cat = {};
const group = (l) => (MUT.has(l) ? 'mutacao' : l === 'HORA' || l === 'DATA' ? 'tempo' : 'nenhuma');
let bTp = 0, bFp = 0, bPos = 0;
const tp = { mutacao: 0, tempo: 0 }, fp = { mutacao: 0, tempo: 0 }, fn = { mutacao: 0, tempo: 0 }, pos = { mutacao: 0, tempo: 0 };
for (const r of rows) {
  const { pred } = await predict(r.text);
  const want = norm(r.label);
  const c = (cat[r.label] ??= { n: 0, ok: 0 });
  c.n++;
  if (pred === want) c.ok++;
  const gw = group(want), gp = group(pred);
  if (gw === 'mutacao') { bPos++; if (gp === 'mutacao') bTp++; }
  if (gp === 'mutacao' && gw !== 'mutacao') bFp++;
  if (gw !== 'nenhuma') pos[gw]++;
  if (gw !== 'nenhuma' && pred === want) tp[gw]++;
  if (gw !== 'nenhuma' && pred !== want) fn[gw]++;
  if (gp !== 'nenhuma' && pred !== want) fp[gp]++;
  if (show && pred !== want) console.log(`[${r.label}] -> ${pred} :: "${r.text}"`);
}
console.log(JSON.stringify(cat, null, 1));
for (const g of ['mutacao', 'tempo']) {
  const prec = tp[g] / Math.max(1, tp[g] + fp[g]);
  const rec = tp[g] / Math.max(1, pos[g]);
  console.log(`${g}: positivas=${pos[g]} acerto-exato(recall)=${(100*rec).toFixed(1)}% precisao=${(100*prec).toFixed(1)}% (tp=${tp[g]} fp=${fp[g]} fn=${fn[g]})`);
}
console.log(`mutacao BINARIA (detectou alguma mutação): recall=${(100*bTp/bPos).toFixed(1)}% precisao=${(100*bTp/Math.max(1,bTp+bFp)).toFixed(1)}% (tp=${bTp} fp=${bFp} pos=${bPos})`);
await engine.shutdown();
