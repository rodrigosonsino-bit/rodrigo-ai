#!/usr/bin/env node
/**
 * Gera audição às cegas OSS (.runtime/audicao-tts-oss/) para a fase TTS-OSS.
 * Sistemas: say Felipe, Kokoro (se disponível), VoxCPM loopback, Gemini Charon (se chave).
 * Rótulos A/B/C/D aleatórios — o mapa fica em key.json (não abrir antes de ouvir).
 *
 * Uso: node scripts/audicao-tts-oss.mjs
 * Requer: /usr/bin/say, ffmpeg; opcionalmente servidor VoxCPM em RODRIGO_VOXCPM_URL
 * e Kokoro em ~/.venvs/tts-say; GEMINI_API_KEY no ambiente ou .env para Charon.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.runtime', 'audicao-tts-oss');

const PHRASES = [
  { id: 'p1', text: 'Olá. Que horas são agora?' },
  { id: 'p2', text: 'Anote pra mim: comprar pão amanhã de manhã.' },
  { id: 'p3', text: 'Em poucas palavras, o que a graça significa na prática?' },
  { id: 'p4', text: 'Tudo bem, depois a gente vê isso com calma.' },
  { id: 'p5', text: 'Pronto. Lembrete criado para daqui a dez minutos.' }
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

function synthSay(text, outWav) {
  const aiff = `${outWav}.aiff`;
  execFileSync('/usr/bin/say', ['-v', 'Felipe (Enhanced)', '-o', aiff, '--', text], { timeout: 30_000 });
  execFileSync('ffmpeg', ['-y', '-nostdin', '-i', aiff, outWav], { timeout: 30_000, stdio: 'ignore' });
  fs.unlinkSync(aiff);
}

function synthKokoro(text, outWav) {
  const py = path.join(os.homedir(), '.venvs', 'tts-say', 'bin', 'python3');
  const script = path.join(ROOT, 'scripts', 'worker', 'kokoro_synth.py');
  if (!fs.existsSync(py) || !fs.existsSync(script)) throw new Error('kokoro indisponível');
  const r = spawnSync(py, [script, outWav], { input: text, encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0) throw new Error(r.stderr || 'kokoro falhou');
}

function httpPostJson(urlStr, body, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
        timeout: timeoutMs
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if ((res.statusCode || 0) >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${buf.toString('utf8').slice(0, 200)}`));
            return;
          }
          resolve(buf);
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.write(data);
    req.end();
  });
}

function assertLoopbackBase(raw) {
  const base = (raw || 'http://127.0.0.1:5077').replace(/\/$/, '');
  const u = new URL(base);
  const host = u.hostname.toLowerCase();
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new Error(`RODRIGO_VOXCPM_URL deve ser loopback; recebido: ${host}`);
  }
  // Preferir IP literal na chamada (evita /etc/hosts apontando localhost para fora).
  if (host === 'localhost') {
    return `${u.protocol}//127.0.0.1${u.port ? `:${u.port}` : ''}`;
  }
  return `${u.protocol}//${u.host}`;
}

async function synthVoxcpm(text, outWav) {
  const base = assertLoopbackBase(process.env.RODRIGO_VOXCPM_URL);
  const control =
    process.env.RODRIGO_VOXCPM_CONTROL ||
    'Homem brasileiro adulto, voz calma, clara e natural, tom conversacional';
  const t0 = Date.now();
  const buf = await httpPostJson(`${base}/v1/audio/speech`, {
    input: text,
    response_format: 'wav',
    control,
    inference_timesteps: 7
  });
  fs.writeFileSync(outWav, buf);
  return Date.now() - t0;
}

async function synthGemini(text, outWav) {
  // Usa o worker Python se existir; senão chama a API REST TTS via generateContent stream é complexo —
  // para a audição, pedimos ao worker via um one-shot se disponível, ou usamos curl-like via google-genai no venv.
  const venvPy = path.join(ROOT, '.runtime', '.venv', 'bin', 'python3');
  const py = fs.existsSync(venvPy) ? venvPy : 'python3';
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY ausente');
  const script = `
import os, sys, wave, struct
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
  if (r.status !== 0) {
    const err = r.stderr ? r.stderr.toString('utf8') : '';
    throw new Error(err || `gemini falhou (status ${r.status})`);
  }
}

function probeVoxcpm() {
  try {
    const base = assertLoopbackBase(process.env.RODRIGO_VOXCPM_URL);
    const r = spawnSync('curl', ['-sS', '-m', '2', `${base}/`], { encoding: 'utf8' });
    return r.status === 0 && /voxcpm|ok/i.test(r.stdout || '');
  } catch {
    return false;
  }
}

loadDotEnv();
ensureDir(OUT);

const systems = [
  { id: 'say_felipe', label: 'say Felipe (Enhanced)', synth: async (t, o) => { synthSay(t, o); } },
  {
    id: 'kokoro',
    label: 'Kokoro pf_dora',
    synth: async (t, o) => {
      synthKokoro(t, o);
    }
  }
];

if (probeVoxcpm()) {
  systems.push({
    id: 'voxcpm',
    label: 'VoxCPM2-MLX (control PT-BR)',
    synth: async (t, o) => {
      const ms = await synthVoxcpm(t, o);
      console.log(`  voxcpm ${ms}ms`);
    }
  });
} else {
  console.warn('[audicao] VoxCPM não responde em RODRIGO_VOXCPM_URL — pulando.');
}

if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'sua_chave_aqui') {
  systems.push({
    id: 'gemini_charon',
    label: 'Gemini Charon',
    synth: async (t, o) => {
      await synthGemini(t, o);
    }
  });
} else {
  console.warn('[audicao] GEMINI_API_KEY ausente — pulando Charon.');
}

const order = shuffle(systems);
const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.slice(0, order.length).split('');
const key = order.map((s, i) => ({ letter: letters[i], systemId: s.id, label: s.label }));

const latency = {};
const results = [];

for (let i = 0; i < order.length; i++) {
  const sys = order[i];
  const letter = letters[i];
  const dir = path.join(OUT, letter);
  ensureDir(dir);
  console.log(`Gerando ${letter} (${sys.id})…`);
  for (const p of PHRASES) {
    const out = path.join(dir, `${p.id}.wav`);
    const t0 = Date.now();
    try {
      await sys.synth(p.text, out);
      const ms = Date.now() - t0;
      latency[`${sys.id}:${p.id}`] = ms;
      const size = fs.statSync(out).size;
      if (size < 1000) console.warn(`  AVISO: ${out} muito pequeno (${size} B) — possível áudio mudo`);
      console.log(`  ${p.id}: ${ms}ms, ${size} B`);
    } catch (err) {
      console.error(`  FALHA ${p.id}:`, err instanceof Error ? err.message : err);
      results.push({ letter, systemId: sys.id, phrase: p.id, error: String(err) });
    }
  }
}

fs.writeFileSync(path.join(OUT, 'key.json'), JSON.stringify({ generatedAt: new Date().toISOString(), key, latency, phrases: PHRASES }, null, 2));
fs.writeFileSync(
  path.join(OUT, 'index.html'),
  `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8"/>
<title>Audição TTS OSS (cega)</title>
<style>
body{font-family:system-ui;max-width:52rem;margin:2rem auto;padding:0 1rem;line-height:1.45}
h1{font-size:1.4rem} section{margin:1.5rem 0;padding:1rem 0;border-top:1px solid #ccc}
audio{width:100%;margin:.35rem 0} .hint{color:#555;font-size:.9rem}
</style>
</head>
<body>
<h1>Audição às cegas — TTS OSS</h1>
<p class="hint">Ouça A–${letters[letters.length - 1]} sem abrir <code>key.json</code>. Anote qual letra soa mais humana/natural em português. Depois registre o vencedor em <code>docs/phase-tts-oss-v1.md</code> §8.</p>
${letters
  .map(
    (L) => `<section>
<h2>Sistema ${L}</h2>
${PHRASES.map((p) => `<div><strong>${p.id}</strong> — ${p.text}<br/><audio controls src="${L}/${p.id}.wav"></audio></div>`).join('\n')}
</section>`
  )
  .join('\n')}
</body>
</html>`
);

console.log(`\nPronto: ${OUT}/index.html`);
console.log('Mapa (não olhar antes): key.json');
console.log(JSON.stringify(key, null, 2));
