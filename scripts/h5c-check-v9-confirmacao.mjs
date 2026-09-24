/**
 * Verificação manual da Fase 5c (docs/phase-5c-v5.md §7) com MLX real — mesmo espírito de
 * h11-check.mjs, adaptado para o fluxo de DOIS turnos que mutação exige:
 *
 *   Turno N   (pedido de mutação) -> pergunta de confirmação falada -> /played real (só isso
 *             promove armedMutation a pendingMutation, sessionManager.ts markPlayed())
 *   Turno N+1 (confirmação/negação) -> resposta final + mutação executada ou cancelada
 *
 * Mede dois critérios, ambos definidos em docs/phase-5c-v5.md §7:
 *   H-mutação:     >=80% das frases da amostra de detecção resultam numa pergunta de
 *                  confirmação de mutação (armedMutation setado, ou seja: routing handled
 *                  + resposta reconhecida como pergunta "Posso ... ?").
 *   H-confirmação: >=90% de acerto geral na amostra de confirmação, E ZERO falsos "SIM" sobre
 *                  negação clara (tolerância zero — um único caso reprova a fase inteira,
 *                  independente da porcentagem global).
 *
 * O teste de H-confirmação usa um lembrete-isca criado antes de cada caso via /api dedicado
 * de teste (armado diretamente pela pergunta real "cria um lembrete de teste") para não
 * depender de estado deixado por casos anteriores, e confere o resultado tanto pela fala
 * quanto pelo arquivo data/lembretes.json real (RODRIGO_DATA_DIR aponta pra um diretório
 * isolado, nunca data/ de produção — ver voiceRuntime.ts).
 *
 * Requer o servidor real já rodando com o runtime de voz configurado e
 * RODRIGO_DATA_DIR apontando para um diretório temporário dedicado a esta bateria.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const BASE_URL = process.env.RODRIGO_BENCH_URL || 'http://127.0.0.1:3000';
const DATA_DIR = process.env.RODRIGO_DATA_DIR;
if (!DATA_DIR) {
  console.error('[h5c] RODRIGO_DATA_DIR não definido — aponte para um diretório isolado antes de rodar.');
  process.exit(1);
}

const CONFIRMATION_SAMPLE_PATH = process.env.RODRIGO_H5C_CONFIRMATION_SAMPLE
  || 'docs/audits/phase-5c-v9-h-confirmacao-sample-2026-09-24.md';
const OUT_PATH = 'docs/audits/phase-5c-v9-result-2026-09-24.json';

/**
 * Isola só a seção "## As N frases (...)" do arquivo — o resto do arquivo (proveniência,
 * prompt usado para gerar a amostra) também contém linhas "N. texto" (o próprio prompt pede
 * uma lista numerada como exemplo de formato), e um parser sem escopo pegaria essas linhas
 * também. Bug real encontrado na primeira execução desta bateria: o parser sem escopo leu
 * "1. DIRETA E CURTA — ..." de dentro do bloco ```prompt``` como se fosse um 18º caso real.
 */
function extractSampleSection(text) {
  const startIdx = text.search(/^##\s+As\s+\d+\s+frases/m);
  if (startIdx === -1) throw new Error('Seção "## As N frases" não encontrada na amostra.');
  const afterStart = text.slice(startIdx);
  const nextHeadingRel = afterStart.slice(1).search(/^##\s/m);
  return nextHeadingRel === -1 ? afterStart : afterStart.slice(0, nextHeadingRel + 1);
}

function parseNumberedSample(mdPath) {
  const section = extractSampleSection(fs.readFileSync(mdPath, 'utf8'));
  const cases = [];
  for (const line of section.split('\n')) {
    const m = line.match(/^(\d+)\.\s+(.+)$/);
    if (m) cases.push({ n: Number(m[1]), text: m[2].trim() });
  }
  return cases;
}

/** Amostra de confirmação: cada linha traz a etiqueta [SIM]/[NAO] com o veredito esperado. */
function parseTaggedSample(mdPath) {
  const section = extractSampleSection(fs.readFileSync(mdPath, 'utf8'));
  const cases = [];
  for (const line of section.split('\n')) {
    const m = line.match(/^(\d+)\.\s+\[(SIM|NAO)\]\s+(.+)$/);
    if (m) cases.push({ n: Number(m[1]), expected: m[2], text: m[3].trim() });
  }
  return cases;
}

async function synthesizeWav(text, tag) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rodrigo-h5c-'));
  const aiff = path.join(tmpDir, `${tag}.aiff`);
  const wav = path.join(tmpDir, `${tag}.wav`);
  await execFileAsync('/usr/bin/say', ['-v', 'Luciana', '-o', aiff, '--', text]);
  await execFileAsync('ffmpeg', ['-y', '-nostdin', '-i', aiff, '-ar', '16000', '-ac', '1', wav]);
  return wav;
}

function readSse(url) {
  const events = [];
  const controller = new AbortController();
  const promise = fetch(url, { signal: controller.signal }).then(async (res) => {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';
      for (const part of parts) {
        const line = part.split('\n').find((l) => l.startsWith('data: '));
        if (line) events.push({ t: performance.now(), event: JSON.parse(line.slice(6)) });
      }
    }
  }).catch(() => {});
  return { events, close: () => controller.abort(), promise };
}

/** Envia um turno de áudio e aguarda turn_done, marcando played real em cada frase falada. */
async function runOneTurn(sessionId, token, wavPath, sse) {
  const audioBuffer = fs.readFileSync(wavPath);
  const res = await fetch(`${BASE_URL}/api/voice/session/audio`, {
    method: 'POST',
    headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' },
    body: audioBuffer
  });
  if (!res.ok) throw new Error(`Falha ao enviar áudio: ${res.status} ${await res.text()}`);
  const { turnId } = await res.json();

  // 130s: cobre a espera do próprio servidor por WARMUP_TIMEOUT_MS (120s, voiceProtocol.ts)
  // no primeiro turno se o worker MLX ainda não tiver terminado de carregar o modelo.
  const deadline = Date.now() + 130_000;
  let transcript = null, routingLabel = null, handled = null, done = false, errorMsg = null;
  const sentences = [];
  let cursor = sse.events.length; // cursor avança — nunca reescanear de um índice fixo (armadilha conhecida)
  while (Date.now() < deadline) {
    for (; cursor < sse.events.length; cursor += 1) {
      const { event } = sse.events[cursor];
      if (event.turnId && event.turnId !== turnId) continue;
      if (event.type === 'transcript') transcript = event.text;
      if (event.type === 'routing') { routingLabel = event.label; handled = event.handled; }
      if (event.type === 'sentence_audio_ready') sentences.push(event.text);
      if (event.type === 'turn_done') done = true;
      if (event.type === 'error') { errorMsg = event.message; done = true; }
    }
    if (done) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  if (errorMsg) throw new Error(`Turno retornou erro: ${errorMsg}`);

  // /played real — é isso que promove armedMutation -> pendingMutation (markPlayed()).
  // Sem isso o turno seguinte nunca vê nada pendente, por design da Fase 5c.
  for (const text of sentences) {
    await fetch(`${BASE_URL}/api/voice/session/played`, {
      method: 'POST',
      headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnId, text })
    }).catch(() => {});
  }

  return { turnId, transcript, routingLabel, handled, response: sentences.join(' ') };
}

function readStoreCount(fileName) {
  const p = path.join(DATA_DIR, fileName);
  if (!fs.existsSync(p)) return 0;
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(parsed.items) ? parsed.items.length : 0;
  } catch {
    return -1; // arquivo corrompido — nunca tratar como "0 itens"
  }
}

/** Turno N: pedido de mutação. Detecta se armou uma pergunta de confirmação. */
function classifyMutationTurn(response) {
  // Fase 5c: as duas preview() de LembreteTool/NotaTool sempre começam com "Posso ".
  const armed = /^Posso\s/i.test(response);
  return armed ? 'ARMADA' : 'NAO_ARMADA';
}

async function newSession() {
  const createRes = await fetch(`${BASE_URL}/api/voice/session`, { method: 'POST' });
  if (!createRes.ok) throw new Error(`Não foi possível criar sessão (${createRes.status}).`);
  const { sessionId, token } = await createRes.json();
  const sse = readSse(`${BASE_URL}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
  await new Promise((r) => setTimeout(r, 300));
  return { sessionId, token, sse };
}

async function endSession(sessionId, token, sse) {
  sse.close();
  await fetch(`${BASE_URL}/api/voice/session/end`, {
    method: 'POST',
    headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token }
  }).catch(() => {});
}

async function runMutationBattery() {
  const cases = parseNumberedSample(MUTATION_SAMPLE_PATH);
  console.log(`\n[h5c] === H-MUTAÇÃO (${cases.length} frases, meta >=80%) ===`);
  const results = [];
  for (const c of cases) {
    const { sessionId, token, sse } = await newSession();
    const wav = await synthesizeWav(c.text, `mut${c.n}`);
    process.stdout.write(`[h5c] mutação ${c.n}/${cases.length} "${c.text}" -> `);
    const r = await runOneTurn(sessionId, token, wav, sse);
    const detected = classifyMutationTurn(r.response);
    console.log(`transcrito="${r.transcript}" | resposta="${r.response}" | ${detected}`);
    results.push({ ...c, transcript: r.transcript, response: r.response, detected });
    await endSession(sessionId, token, sse);
    await new Promise((res) => setTimeout(res, 300));
  }
  const armedCount = results.filter((r) => r.detected === 'ARMADA').length;
  const coverage = (armedCount / results.length) * 100;
  console.log(`[h5c] H-mutação: ${armedCount}/${results.length} = ${coverage.toFixed(1)}% (meta >=80%) -> ${coverage >= 80 ? 'PASSOU' : 'NÃO PASSOU'}`);
  return { results, armedCount, total: results.length, coveragePct: coverage, passed: coverage >= 80 };
}

async function runConfirmationBattery() {
  const cases = parseTaggedSample(CONFIRMATION_SAMPLE_PATH);
  console.log(`\n[h5c] === H-CONFIRMAÇÃO (${cases.length} frases, meta >=90% geral, 0 falso SIM sobre negação) ===`);
  const results = [];
  for (const c of cases) {
    const { sessionId, token, sse } = await newSession();

    // Turno N: pedido de mutação simples, só para armar uma pendingMutation real — o objeto
    // do teste é a CONFIRMAÇÃO no turno N+1, não a detecção de mutação aqui. O número do caso
    // entra no conteúdo para garantir texto único a cada rodada: LembreteTool.execute()
    // deduplica quando o conteúdo extraído bate com o último item salvo (mutatingTools.ts),
    // e todos os casos escrevem no mesmo arquivo — conteúdo repetido produziria um "mutou=false"
    // falso mesmo quando a confirmação real foi SIM.
    const armWav = await synthesizeWav(`Cria um lembrete de teste número ${c.n} da bateria da fase cinco c.`, `armN${c.n}`);
    const armTurn = await runOneTurn(sessionId, token, armWav, sse);
    const armed = classifyMutationTurn(armTurn.response) === 'ARMADA';
    if (!armed) {
      console.log(`[h5c] confirmação ${c.n}/${cases.length}: FALHA AO ARMAR ("${armTurn.response}") — caso descartado, não conta na nota`);
      results.push({ ...c, skipped: true, reason: 'não armou pendingMutation no turno de preparo' });
      await endSession(sessionId, token, sse);
      continue;
    }

    const countBefore = readStoreCount('lembretes.json');
    const wav = await synthesizeWav(c.text, `conf${c.n}`);
    process.stdout.write(`[h5c] confirmação ${c.n}/${cases.length} "${c.text}" (esperado=${c.expected}) -> `);
    const r = await runOneTurn(sessionId, token, wav, sse);
    const countAfter = readStoreCount('lembretes.json');
    const mutated = countAfter === countBefore + 1;
    const cancelledText = /não fiz nada|tudo bem/i.test(r.response);
    const detected = mutated ? 'SIM' : (cancelledText ? 'NAO' : 'INDEFINIDO');
    const correct = detected === c.expected;
    const falseYesOnNegation = c.expected === 'NAO' && detected === 'SIM';
    console.log(`transcrito="${r.transcript}" | resposta="${r.response}" | mutou=${mutated} | detectado=${detected} -> ${correct ? 'OK' : 'FALHOU'}${falseYesOnNegation ? ' *** FALSO SIM SOBRE NEGAÇÃO ***' : ''}`);
    results.push({ ...c, transcript: r.transcript, response: r.response, detected, correct, falseYesOnNegation, countBefore, countAfter });
    await endSession(sessionId, token, sse);
    await new Promise((res) => setTimeout(res, 300));
  }

  const scored = results.filter((r) => !r.skipped);
  const correctCount = scored.filter((r) => r.correct).length;
  const coverage = scored.length > 0 ? (correctCount / scored.length) * 100 : 0;
  const falsePositives = scored.filter((r) => r.falseYesOnNegation);
  const passed = coverage >= 90 && falsePositives.length === 0;
  console.log(`[h5c] H-confirmação: ${correctCount}/${scored.length} = ${coverage.toFixed(1)}% (meta >=90%), falsos SIM sobre negação: ${falsePositives.length} (meta 0) -> ${passed ? 'PASSOU' : 'NÃO PASSOU'}`);
  return { results, correctCount, total: scored.length, coveragePct: coverage, falsePositiveCount: falsePositives.length, passed };
}

async function main() {
  console.log(`[h5c] Conectando em ${BASE_URL} — servidor real com runtime de voz e RODRIGO_DATA_DIR=${DATA_DIR} precisa já estar rodando.`);
  fs.mkdirSync(DATA_DIR, { recursive: true });

  console.log('[h5c] Aquecendo (turno descartado das métricas, pode levar até 2min — worker MLX carregando)...');
  const warm = await newSession();
  const warmWav = await synthesizeWav('Olá, isso é um aquecimento.', 'warm');
  await runOneTurn(warm.sessionId, warm.token, warmWav, warm.sse);
  await endSession(warm.sessionId, warm.token, warm.sse);

  // H-mutação (76.5%) está fora de escopo desta remedição — docs/phase-5c-v8.md §6, item 6.
  // Só H-confirmação é remedido aqui, contra a amostra hold-out nova congelada em
  // docs/audits/phase-5c-v9-h-confirmacao-sample-2026-09-24.md.
  const confirmation = await runConfirmationBattery();

  const report = {
    date: new Date().toISOString(),
    confirmationSample: CONFIRMATION_SAMPLE_PATH,
    dataDir: DATA_DIR,
    confirmation,
    overallPassed: confirmation.passed,
    note: 'H-mutação fora de escopo desta remedição (docs/phase-5c-v8.md §6, item 6) — não medido aqui.'
  };

  console.log('\n[h5c] === RESULTADO FINAL (H-confirmação, v9) ===');
  console.log(`H-confirmação: ${confirmation.coveragePct.toFixed(1)}% geral, ${confirmation.falsePositiveCount} falso(s) SIM sobre negação -> ${confirmation.passed ? 'PASSOU' : 'NÃO PASSOU'}`);
  console.log(`Veredito: ${report.overallPassed ? 'H-CONFIRMAÇÃO APROVADA (MLX real, v9)' : 'H-CONFIRMAÇÃO NÃO PASSOU — ver falhas acima'}`);

  fs.mkdirSync('docs/audits', { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));
  console.log(`\n[h5c] Relatório salvo em ${OUT_PATH}`);
}

main().catch((err) => {
  console.error('[h5c] Falhou:', err);
  process.exit(1);
});
