import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const RUNTIME_DIR = path.join(ROOT, '.runtime');
const VENV_DIR = path.join(RUNTIME_DIR, '.venv');
const HF_CACHE_DIR = path.join(RUNTIME_DIR, 'hf-cache');
const UV_CACHE_DIR = path.join(RUNTIME_DIR, 'uv-cache');
const TMP_DIR = path.join(RUNTIME_DIR, 'tmp');
const LOCK_PATH = path.join(RUNTIME_DIR, 'voice-requirements.lock.txt');
const MANIFEST_PATH = path.join(RUNTIME_DIR, 'models-manifest.json');

function run(cmd, args, options = {}) {
  console.log(`[setup:voice] $ ${cmd} ${args.join(' ')}`);
  const result = spawnSync(cmd, args, {
    stdio: 'inherit',
    shell: false,
    ...options
  });
  if (result.error) {
    console.error(`[setup:voice] Falha ao executar ${cmd}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[setup:voice] Comando falhou (código ${result.status}): ${cmd} ${args.join(' ')}`);
    process.exit(result.status || 1);
  }
}

function which(cmd) {
  const result = spawnSync('which', [cmd], { encoding: 'utf-8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function main() {
  console.log('[setup:voice] Configurando runtime de voz local (Fase 2) — sem API paga, sem chaves.');

  const uvPath = which('uv');
  if (!uvPath) {
    console.error('[setup:voice] "uv" não encontrado no PATH. Instale uv (https://docs.astral.sh/uv/) e rode de novo.');
    process.exit(1);
  }

  for (const dir of [RUNTIME_DIR, HF_CACHE_DIR, UV_CACHE_DIR, TMP_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (!fs.existsSync(VENV_DIR)) {
    run(uvPath, ['venv', '--python', '3.12', VENV_DIR]);
  } else {
    console.log('[setup:voice] venv já existe, reaproveitando.');
  }

  const requirementsIn = path.join(ROOT, 'scripts', 'worker', 'requirements.in');
  run(uvPath, ['pip', 'install', '--python', path.join(VENV_DIR, 'bin', 'python3'), '-r', requirementsIn], {
    env: { ...process.env, UV_CACHE_DIR }
  });

  const freezeResult = spawnSync(uvPath, ['pip', 'freeze', '--python', path.join(VENV_DIR, 'bin', 'python3')], {
    encoding: 'utf-8',
    env: { ...process.env, UV_CACHE_DIR }
  });
  if (freezeResult.status === 0) {
    fs.writeFileSync(LOCK_PATH, freezeResult.stdout);
    console.log(`[setup:voice] Versões resolvidas gravadas em ${LOCK_PATH}`);
  }

  console.log('[setup:voice] Verificando tamanho projetado e baixando modelos (teto: 8 GiB)...');
  const pythonBin = path.join(VENV_DIR, 'bin', 'python3');
  const setupModelsScript = path.join(ROOT, 'scripts', 'worker', 'setup_models.py');

  run(pythonBin, [setupModelsScript], {
    env: {
      ...process.env,
      RODRIGO_VOICE_SETUP: '1',
      RODRIGO_VOICE_MANIFEST_PATH: MANIFEST_PATH,
      HF_HOME: HF_CACHE_DIR,
      HF_HUB_OFFLINE: '0',
      TRANSFORMERS_OFFLINE: '0'
    }
  });

  console.log('[setup:voice] Concluído. Modelos e dependências prontos em .runtime/ (offline a partir daqui).');
  if (fs.existsSync(MANIFEST_PATH)) {
    console.log(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
  }
}

main();
