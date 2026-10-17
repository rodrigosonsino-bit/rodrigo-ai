#!/usr/bin/env node
/**
 * Audição curta: Rápido TTS vs Kokoro vs Gemini Charon.
 * Saída: .runtime/audicao-tts-rapido/ (gitignorado via .runtime)
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.runtime', 'audicao-tts-rapido');
const RAPIDO_ROOT = path.join(os.homedir(), '.venvs', 'rapido-tts');
const RAPIDO_PY = path.join(RAPIDO_ROOT, '.venv', 'bin', 'python');

const PHRASES = [
  { id: 'p1', text: 'Olá. Que horas são agora?' },
  { id: 'p2', text: 'Anote pra mim: comprar pão amanhã de manhã.' },
  { id: 'p3', text: 'O boleto de R$ 1.299,90 vence no dia 05/11/2026, às 14h30.' },
  { id: 'p4', text: 'Tudo bem, depois a gente vê isso com calma.' }
];

function loadDotEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

function synthKokoro(text, outWav) {
  const py = path.join(os.homedir(), '.venvs', 'tts-say', 'bin', 'python3');
  const script = path.join(ROOT, 'scripts', 'worker', 'kokoro_synth.py');
  const r = spawnSync(py, [script, outWav], { input: text, encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0) throw new Error(r.stderr || 'kokoro falhou');
}

function synthRapido(text, outWav) {
  const py = `
import sys, time
from rapido import Rapido, Config
text = sys.stdin.read()
out = sys.argv[1]
tts = Rapido(Config(device="cpu", steps=8, guidance=4.0, seed=0, cpu_threads=8))
t0 = time.time()
r = tts.synthesize(text)
r.save(out)
print(int((time.time()-t0)*1000))
`;
  const r = spawnSync(RAPIDO_PY, ['-c', py, outWav], {
    input: text,
    env: { ...process.env, PYTHONPATH: RAPIDO_ROOT },
    cwd: RAPIDO_ROOT,
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024
  });
  if (r.status !== 0) throw new Error((r.stderr && r.stderr.toString()) || 'rapido falhou');
  return parseInt((r.stdout || '').toString().trim().split(/\n/).pop() || '0', 10);
}

function synthGemini(text, outWav) {
  const key = process.env.GEMINI_API_KEY;
  if (!key || key === 'sua_chave_aqui') throw new Error('GEMINI_API_KEY ausente');
  const venvPy = path.join(ROOT, '.runtime', '.venv', 'bin', 'python3');
  const py = fs.existsSync(venvPy) ? venvPy : 'python3';
  const script = `
import os, sys, wave
from google import genai
from google.genai import types
text = sys.stdin.read()
out = sys.argv[1]
client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
config = types.GenerateContentConfig(
  response_modalities=["AUDIO"],
  speech_config=types.SpeechConfig(
    voice_config=types.VoiceConfig(
      prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name="Charon")
    )
  ),
)
chunks=[]; rate=24000
for chunk in client.models.generate_content_stream(model="gemini-3.8-flash-lite-tts", contents=text, config=config):
  for cand in (chunk.candidates or []):
    content = cand.content
    if not content: continue
    for part in (content.parts or []):
      inline = part.inline_data
      if inline and inline.data:
        chunks.append(inline.data)
pcm = b"".join(chunks)
with wave.open(out, "wb") as w:
  w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate); w.writeframes(pcm)
`;
  const r = spawnSync(py, ['-c', script, outWav], {
    input: text,
    env: { ...process.env, GEMINI_API_KEY: key },
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024
  });
  if (r.status !== 0) throw new Error((r.stderr && r.stderr.toString()) || 'gemini falhou');
}

loadDotEnv();
ensureDir(OUT);

if (!fs.existsSync(RAPIDO_PY)) {
  console.error('Rápido não instalado em', RAPIDO_ROOT);
  process.exit(1);
}

const systems = [
  { id: 'rapido', label: 'Rápido TTS (pt-BR)', synth: async (t, o) => synthRapido(t, o) },
  { id: 'kokoro', label: 'Kokoro pf_dora', synth: async (t, o) => synthKokoro(t, o) },
  { id: 'gemini_charon', label: 'Gemini Charon', synth: async (t, o) => synthGemini(t, o) }
];

const order = shuffle(systems);
const letters = 'ABC'.slice(0, order.length).split('');
const key = order.map((s, i) => ({ letter: letters[i], systemId: s.id, label: s.label }));
const latency = {};

for (let i = 0; i < order.length; i++) {
  const sys = order[i];
  const letter = letters[i];
  const dir = path.join(OUT, letter);
  ensureDir(dir);
  console.log(`Gerando ${letter} (${sys.id})…`);
  for (const p of PHRASES) {
    const out = path.join(dir, `${p.id}.wav`);
    const t0 = Date.now();
    await sys.synth(p.text, out);
    const ms = Date.now() - t0;
    latency[`${sys.id}:${p.id}`] = ms;
    console.log(`  ${p.id}: ${ms}ms, ${fs.statSync(out).size} B`);
  }
}

fs.writeFileSync(
  path.join(OUT, 'key.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), key, latency, phrases: PHRASES }, null, 2)
);
fs.writeFileSync(
  path.join(OUT, 'index.html'),
  `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="utf-8"/><title>Audição Rápido TTS</title>
<style>body{font-family:system-ui;max-width:48rem;margin:2rem auto;padding:0 1rem;line-height:1.45}
h1{font-size:1.35rem} section{margin:1.4rem 0;padding-top:1rem;border-top:1px solid #ccc}
audio{width:100%;margin:.3rem 0}.hint{color:#555;font-size:.9rem}</style></head><body>
<h1>Audição às cegas — Rápido vs controles</h1>
<p class="hint">Ouça A–C sem abrir <code>key.json</code>. Compare naturalidade em PT-BR (incluindo a frase com R$ e data). Depois diga qual letra ganhou.</p>
${letters
  .map(
    (L) => `<section><h2>Sistema ${L}</h2>
${PHRASES.map((p) => `<div><strong>${p.id}</strong> — ${p.text}<br/><audio controls src="${L}/${p.id}.wav"></audio></div>`).join('\n')}
</section>`
  )
  .join('\n')}
</body></html>`
);

console.log('\nPronto:', path.join(OUT, 'index.html'));
console.log(JSON.stringify(key, null, 2));
