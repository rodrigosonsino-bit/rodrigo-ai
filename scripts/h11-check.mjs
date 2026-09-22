/**
 * Verificação manual de H11 (docs/phase-5b-v5.md §7) com áudio real, mesmo espírito de
 * matrix-c6.mjs: submete cada frase da amostra selada em
 * docs/audits/phase-5b-v5-h11-sample-2026-09-22.md como áudio sintetizado (say+ffmpeg)
 * para um servidor real já rodando, e classifica o resultado pelo TEXTO da resposta falada
 * (evento sentence_audio_ready.text) — não pelo evento `routing`, que emite o mesmo
 * label:'GERAL'/handled:true tanto no caminho de ferramenta quanto no caminho normal.
 *
 * Requer o servidor real já rodando com o runtime de voz configurado.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const BASE_URL = process.env.RODRIGO_BENCH_URL || 'http://127.0.0.1:3000';
const OUT_PATH = 'docs/audits/phase-5b-v6-h11-result-2026-09-22.json';

// Amostra selada em docs/audits/phase-5b-v5-h11-sample-2026-09-22.md — verbatim, sem edição.
// "expected" é a leitura mais natural de cada frase (HORA ou DATA); duas marcadas ambiguous:true
// porque a própria sessão que revisou a amostra já observou ambiguidade de superfície nelas —
// contam para a nota mas são reportadas separadamente para o usuário julgar.
const CASES = [
  { n: 1, text: 'Que horas são?', expected: 'HORA' },
  { n: 2, text: 'Qual é a data de hoje?', expected: 'DATA' },
  { n: 3, text: 'Me fala a hora aí?', expected: 'HORA' },
  { n: 4, text: 'Hoje é dia quanto?', expected: 'DATA' },
  { n: 5, text: 'Tá marcando quanto agora?', expected: 'HORA' },
  { n: 6, text: 'Já passou do meio-dia?', expected: 'HORA' },
  { n: 7, text: 'Em que dia a gente tá mesmo?', expected: 'DATA' },
  { n: 8, text: 'Ainda é cedo ou já tá ficando tarde?', expected: 'HORA' },
  { n: 9, text: 'Hoje caiu em qual dia do mês?', expected: 'DATA' },
  { n: 10, text: 'A gente já chegou no dia vinte e dois?', expected: 'DATA', ambiguous: true },
  { n: 11, text: 'Tô meio perdido aqui, você consegue me dizer que horas tá dando agora?', expected: 'HORA' },
  { n: 12, text: 'Eu tava preenchendo um negócio aqui e esqueci, qual é a data de hoje mesmo?', expected: 'DATA' },
  { n: 13, text: 'Nossa, parece que esse dia não acaba… quanto tá dando no relógio?', expected: 'HORA' },
  { n: 14, text: 'Preciso colocar a data aqui antes de mandar isso, hoje é quanto?', expected: 'DATA' },
  { n: 15, text: 'Tô organizando meus compromissos e me embananei todo, em que dia nós estamos?', expected: 'DATA' },
  { n: 16, text: 'Ô, vê pra mim quanto é que tá dando aí?', expected: 'HORA', ambiguous: true },
  { n: 17, text: 'Mano, hoje é dia quanto mesmo?', expected: 'DATA' },
  { n: 18, text: 'Eita, já são quantas?', expected: 'HORA' },
  { n: 19, text: 'Rapaz, nós tá em que dia hoje?', expected: 'DATA' },
  { n: 20, text: 'Peraí, hoje é vinte e dois já ou eu tô viajando?', expected: 'DATA' }
];

function classifyResponse(response) {
  if (/^(É|São)\s+\d+\s+hora/i.test(response)) return 'HORA';
  if (/^Hoje é/i.test(response)) return 'DATA';
  return 'NENHUMA'; // caiu no caminho normal (LLM gerou algo que não é a frase determinística)
}

async function synthesizeWav(text, index) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rodrigo-h11-'));
  const aiff = path.join(tmpDir, `q${index}.aiff`);
  const wav = path.join(tmpDir, `q${index}.wav`);
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

async function runOneTurn(sessionId, token, wavPath, sse) {
  const audioBuffer = fs.readFileSync(wavPath);
  const res = await fetch(`${BASE_URL}/api/voice/session/audio`, {
    method: 'POST',
    headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' },
    body: audioBuffer
  });
  if (!res.ok) throw new Error(`Falha ao enviar áudio: ${res.status} ${await res.text()}`);
  const { turnId } = await res.json();

  const deadline = Date.now() + 45_000;
  let transcript = null, routingLabel = null, handled = null, done = false;
  const sentences = [];
  let cursor = sse.events.length; // cursor avança — nunca reescanear de um índice fixo (achado conhecido)
  while (Date.now() < deadline) {
    for (; cursor < sse.events.length; cursor += 1) {
      const { event } = sse.events[cursor];
      if (event.turnId && event.turnId !== turnId) continue;
      if (event.type === 'transcript') transcript = event.text;
      if (event.type === 'routing') { routingLabel = event.label; handled = event.handled; }
      if (event.type === 'sentence_audio_ready') sentences.push(event.text);
      if (event.type === 'turn_done') done = true;
      if (event.type === 'error') throw new Error(`Turno retornou erro: ${event.message}`);
    }
    if (done) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  for (const text of sentences) {
    await fetch(`${BASE_URL}/api/voice/session/played`, {
      method: 'POST',
      headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnId, text })
    }).catch(() => {});
  }

  return { transcript, routingLabel, handled, response: sentences.join(' ') };
}

async function main() {
  console.log(`[h11] Conectando em ${BASE_URL} — servidor real com runtime de voz precisa já estar rodando.`);
  const createRes = await fetch(`${BASE_URL}/api/voice/session`, { method: 'POST' });
  if (!createRes.ok) {
    console.error(`[h11] Não foi possível criar sessão (${createRes.status}).`);
    process.exit(1);
  }
  const { sessionId, token } = await createRes.json();
  const sse = readSse(`${BASE_URL}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
  await new Promise((r) => setTimeout(r, 300));

  console.log('[h11] Aquecendo (turno descartado das métricas, pode levar até 2min)...');
  const warmWav = await synthesizeWav('Olá, isso é um aquecimento.', 0);
  await runOneTurn(sessionId, token, warmWav, sse);

  const results = [];
  for (const c of CASES) {
    const wav = await synthesizeWav(c.text, c.n);
    process.stdout.write(`[h11] ${c.n}/20 "${c.text}" -> `);
    const r = await runOneTurn(sessionId, token, wav, sse);
    const detected = classifyResponse(r.response);
    const correct = detected === c.expected;
    console.log(`transcrito="${r.transcript}" | resposta="${r.response}" | detectado=${detected} (esperado=${c.expected}${c.ambiguous ? ', AMBÍGUA' : ''}) -> ${correct ? 'OK' : 'FALHOU'}`);
    results.push({ ...c, transcript: r.transcript, response: r.response, detected, correct });
    await new Promise((res) => setTimeout(res, 500));
  }

  sse.close();
  await fetch(`${BASE_URL}/api/voice/session/end`, {
    method: 'POST',
    headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token }
  }).catch(() => {});

  const total = results.length;
  const correctCount = results.filter((r) => r.correct).length;
  const coverage = (correctCount / total) * 100;
  const ambiguousResults = results.filter((r) => r.ambiguous);

  const report = {
    date: new Date().toISOString(),
    sample: 'docs/audits/phase-5b-v5-h11-sample-2026-09-22.md',
    total,
    correctCount,
    coveragePct: coverage,
    threshold: 80,
    passed: coverage >= 80,
    results
  };

  console.log('\n[h11] === RESULTADO ===');
  console.log(`Cobertura: ${correctCount}/${total} = ${coverage.toFixed(1)}% (meta: >=80%)`);
  console.log(`Veredito: ${report.passed ? 'PASSOU' : 'NÃO PASSOU'}`);
  if (ambiguousResults.length > 0) {
    console.log(`\nCasos marcados ambíguos (revisar manualmente, não contam automaticamente):`);
    for (const r of ambiguousResults) {
      console.log(`  #${r.n} "${r.text}" -> detectado=${r.detected}, resposta="${r.response}"`);
    }
  }
  const failed = results.filter((r) => !r.correct && !r.ambiguous);
  if (failed.length > 0) {
    console.log(`\nFalhas:`);
    for (const r of failed) {
      console.log(`  #${r.n} "${r.text}" -> esperado=${r.expected}, detectado=${r.detected}, resposta="${r.response}"`);
    }
  }

  fs.mkdirSync('docs/audits', { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));
  console.log(`\n[h11] Relatório salvo em ${OUT_PATH}`);
}

main().catch((err) => {
  console.error('[h11] Falhou:', err);
  process.exit(1);
});
