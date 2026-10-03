/**
 * F11 H11.1 — mede a detecção de intenção PONTA A PONTA, como o produto a executa:
 * mightBeMutation (filtro) -> detectMutation (LLM) ; senão mightBeTemporal -> detectTool.
 * Rejeição do filtro conta como falso negativo. Reservada: só agregados.
 * Uso: node scripts/f11-measure-intent.mjs <dev|dev2|heldout> [--show]
 */
import fs from 'node:fs';
import path2 from 'node:path';
import path from 'node:path';
import { MlxWorkerEngine } from '../dist/server/backend/voice/mlxWorkerEngine.js';
import { mightBeMutation } from '../dist/server/backend/tools/mutatingTools.js';
import { mightBeTemporal } from '../dist/server/backend/tools/systemTools.js';

const split = process.argv[2] || 'dev';
const show = process.argv.includes('--show') && !split.startsWith('heldout');
const root = process.cwd();
const engine = new MlxWorkerEngine({
  pythonBin: path.join(root, '.runtime/.venv/bin/python3'),
  workerScript: path.join(root, 'scripts/worker/worker.py'),
  hfCacheDir: path.join(root, '.runtime/hf-cache')
});
await engine.waitUntilReady(180000);

const devTexts = new Set();
for (const f of fs.readdirSync('docs/audits/f11/raw')) {
  if (/^dev\d*\.jsonl$/.test(f)) for (const l of fs.readFileSync(path2.join('docs/audits/f11/raw', f), 'utf8').trim().split('\n')) devTexts.add(JSON.parse(l).text.trim().toLowerCase());
}
const isNovel = (r) => !devTexts.has(r.text.trim().toLowerCase());
const origRows = fs.readFileSync(`docs/audits/f11/raw/${split}.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const rows = origRows.filter((r) => !r.label.startsWith('CONF_'));
if (process.env.F11_NOVEL === '1') { const k = rows.filter(isNovel); rows.length = 0; rows.push(...k); console.log(`(apenas itens INÉDITOS: ${k.length})`); }
const MUT = new Set(['LEMBRETE_CRIAR','LEMBRETE_EDITAR','LEMBRETE_APAGAR','NOTA_CRIAR','NOTA_EDITAR','NOTA_APAGAR','MEMORIA_GUARDAR','MEMORIA_EDITAR','MEMORIA_ESQUECER']);
let n = 0;
let timeouts = 0, cloudAnswered = 0, cloudNull = 0, lastCloud = 0;
const models = new Set();
const noGate = process.env.F11_NO_GATE === '1'; // oracle: filtro perfeito (todas as falas vão à nuvem)
const useCloud = process.env.RODRIGO_CLOUD_INTENT !== '0';
async function predict(text) {
  try { return await predictRaw(text); } catch (e) { timeouts++; return { pred: 'NENHUMA', gate: true }; } // como o produto: falha de detecção => caminho normal
}
async function predictRaw(text) {
  const id = `m${n++}`;
  if (useCloud && (noGate || mightBeMutation(text) || mightBeTemporal(text))) {
    // Cota gratuita do Gemini: ~10-15 req/min. Espaça as chamadas SÓ na medição (o uso real é humano-paced).
    const gap = Number(process.env.F11_CLOUD_GAP_MS || 6200);
    const wait = lastCloud + gap - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCloud = Date.now();
    const cloud = await engine.detectIntent(id, 0, text);
    if (cloud) { cloudAnswered++; if (cloud.model) models.add(cloud.model); return { pred: cloud.intent, gate: true }; }
    cloudNull++; // indisponível => cadeia local, como o sessionManager
  }
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
let bTp = 0, bFp = 0, bPos = 0, eTp = 0, ePos = 0, iTp = 0, iPos = 0, aTp = 0, aPos = 0;
const contentFile = `docs/audits/f11/raw/${split}.content.json`;
const hasContent = fs.existsSync(contentFile) ? JSON.parse(fs.readFileSync(contentFile, 'utf8')) : null;
let rowIdx = -1;
// Pedido explícito: tem verbo/indício de comando de edição, apagar, guardar, avisar, anotar... Correção
// implícita ('na real eu tenho 32, não 35') NÃO é pedido de mutação por decisão de segurança.
const CUE = /(lembr|anot|guard|escrev|salv|apag|esquec|delet|some |avis|registr|grava|memor|nota|lembrete|corrig|errad|errei|muda|troca|edita|atualiz|alter|reescrev|no lugar|nunca disse|nao foi isso|tira|remove)/;
const flat = (t) => t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const tp = { mutacao: 0, tempo: 0 }, fp = { mutacao: 0, tempo: 0 }, fn = { mutacao: 0, tempo: 0 }, pos = { mutacao: 0, tempo: 0 };
for (const r of rows) {
  rowIdx++;
  const { pred } = await predict(r.text);
  const want = norm(r.label);
  const c = (cat[r.label] ??= { n: 0, ok: 0 });
  c.n++;
  if (pred === want) c.ok++;
  const gw = group(want), gp = group(pred);
  const origIdx = origRows.indexOf(r);
  const actionable = !hasContent || hasContent[origIdx] !== false; // sem rótulo => acionável
  if (gw === 'mutacao' && actionable) { aPos++; if (gp === 'mutacao') aTp++; }
  if (gw === 'mutacao') { bPos++; if (gp === 'mutacao') bTp++; if (CUE.test(flat(r.text))) { ePos++; if (gp === 'mutacao') eTp++; } else { iPos++; if (gp === 'mutacao') iTp++; } }
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
console.log(`mutacao BINARIA so pedidos EXPLICITOS: recall=${(100*eTp/Math.max(1,ePos)).toFixed(1)}% (${eTp}/${ePos}); implicitos: recall=${(100*iTp/Math.max(1,iPos)).toFixed(1)}% (${iTp}/${iPos})`);
console.log(`mutacao BINARIA so pedidos ACIONAVEIS (com conteudo): recall=${(100*aTp/Math.max(1,aPos)).toFixed(1)}% (${aTp}/${aPos})`);
console.log(`nuvem respondeu=${cloudAnswered} indisponivel(fallback local)=${cloudNull} taxa de fallback=${(100*cloudNull/Math.max(1,cloudAnswered+cloudNull)).toFixed(1)}% modelos=${[...models].join(',')} filtro=${noGate ? 'PERFEITO(oracle)' : 'real'}`);
console.log(`timeouts/erros de detecção (contados como NENHUMA): ${timeouts}`);
await engine.shutdown();
