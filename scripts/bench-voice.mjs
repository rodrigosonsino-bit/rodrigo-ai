import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const QUESTIONS = [
  'Quanto é dois mais dois?',
  'Que horas são agora?',
  'Qual é a capital do Brasil?',
  'Me diga um número entre um e dez.',
  'Como você está?',
  'Qual é o seu nome?',
  'Quanto é dez vezes cinco?',
  'Explique o que é uma maçã.',
  'Qual é o dia da semana hoje?',
  'Diga olá em uma frase curta.'
];

const BASE_URL = process.env.RODRIGO_BENCH_URL || 'http://127.0.0.1:3000';

async function synthesizeQuestionWav(text, index) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rodrigo-bench-'));
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
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';
      for (const part of parts) {
        const line = part.split('\n').find((l) => l.startsWith('data: '));
        if (line) {
          events.push({ t: performance.now(), event: JSON.parse(line.slice(6)) });
        }
      }
    }
  }).catch(() => {});

  return { events, close: () => controller.abort(), promise };
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}

async function runOneTurn(sessionId, token, wavPath, sse) {
  const audioBuffer = fs.readFileSync(wavPath);
  const tSent = performance.now();

  const res = await fetch(`${BASE_URL}/api/voice/session/audio`, {
    method: 'POST',
    headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' },
    body: audioBuffer
  });
  if (!res.ok) {
    throw new Error(`Falha ao enviar áudio: ${res.status} ${await res.text()}`);
  }
  const { turnId } = await res.json();

  const deadline = Date.now() + 30_000;
  let tTranscript = null;
  let tFirstAudio = null;
  let tDone = null;

  const startLen = sse.events.length;
  while (Date.now() < deadline) {
    for (let i = startLen; i < sse.events.length; i += 1) {
      const { t, event } = sse.events[i];
      if (event.turnId && event.turnId !== turnId) continue;
      if (event.type === 'transcript' && tTranscript === null) tTranscript = t;
      if (event.type === 'sentence_audio_ready' && tFirstAudio === null) tFirstAudio = t;
      if (event.type === 'turn_done') tDone = t;
    }
    if (tDone !== null) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  if (tFirstAudio === null) {
    throw new Error(`Turno ${turnId} não produziu áudio dentro do timeout de 30s.`);
  }

  return {
    sttMs: tTranscript ? tTranscript - tSent : null,
    firstAudioMs: tFirstAudio - tSent,
    totalMs: (tDone || tFirstAudio) - tSent
  };
}

async function main() {
  console.log(`[bench] Conectando em ${BASE_URL} — certifique-se que "npm start" ou "npm run dev" já está rodando com o runtime de voz configurado.`);

  const createRes = await fetch(`${BASE_URL}/api/voice/session`, { method: 'POST' });
  if (!createRes.ok) {
    console.error(`[bench] Não foi possível criar sessão (${createRes.status}). Voz local está configurada? Rode "npm run setup:voice".`);
    process.exit(1);
  }
  const { sessionId, token } = await createRes.json();

  const sse = readSse(`${BASE_URL}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
  await new Promise((r) => setTimeout(r, 300));

  console.log('[bench] Sintetizando perguntas de teste com "say" (entrada sintética, não é o teste humano de verdade)...');
  const wavPaths = [];
  for (let i = 0; i < QUESTIONS.length; i += 1) {
    wavPaths.push(await synthesizeQuestionWav(QUESTIONS[i], i));
  }

  console.log('[bench] Aquecendo (1ª pergunta, ignorada nas métricas — pode levar até 2min)...');
  await runOneTurn(sessionId, token, wavPaths[0], sse);

  const results = [];
  for (let i = 1; i < wavPaths.length; i += 1) {
    console.log(`[bench] Turno ${i}/${wavPaths.length - 1}: "${QUESTIONS[i]}"`);
    const r = await runOneTurn(sessionId, token, wavPaths[i], sse);
    console.log(`  STT: ${r.sttMs?.toFixed(0) ?? 'n/d'}ms | 1º áudio: ${r.firstAudioMs.toFixed(0)}ms | total: ${r.totalMs.toFixed(0)}ms`);
    results.push(r);
    await new Promise((res) => setTimeout(res, 500));
  }

  sse.close();
  await fetch(`${BASE_URL}/api/voice/session/end`, {
    method: 'POST',
    headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token }
  }).catch(() => {});

  const firstAudioValues = results.map((r) => r.firstAudioMs);
  const median = percentile(firstAudioValues, 50);
  const p95 = percentile(firstAudioValues, 95);

  const report = {
    date: new Date().toISOString(),
    turns: results.length,
    firstAudioMedianMs: median,
    firstAudioP95Ms: p95,
    target: { medianMs: 4000, p95Ms: 8000 },
    passed: median <= 4000 && p95 <= 8000,
    raw: results
  };

  console.log('\n[bench] Resultado:');
  console.log(`  Mediana (fim da fala -> 1º áudio): ${median.toFixed(0)}ms (meta: <=4000ms)`);
  console.log(`  p95: ${p95.toFixed(0)}ms (meta: <=8000ms)`);
  console.log(`  Veredito: ${report.passed ? 'DENTRO DA META' : 'FORA DA META — ver candidatas de otimização no adendo do plano'}`);

  fs.mkdirSync('docs/audits', { recursive: true });
  fs.writeFileSync('docs/audits/voice-benchmark-latest.json', JSON.stringify(report, null, 2));
  console.log('[bench] Relatório salvo em docs/audits/voice-benchmark-latest.json');
}

main().catch((err) => {
  console.error('[bench] Falhou:', err);
  process.exit(1);
});
