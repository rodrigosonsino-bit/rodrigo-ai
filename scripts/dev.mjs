import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';

// Carregamento simples de .env se existir
function loadDotEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    try {
      const content = fs.readFileSync(envPath, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx !== -1) {
          const key = trimmed.slice(0, eqIdx).trim();
          const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
          if (!(key in process.env) && key.length > 0) {
            process.env[key] = val;
          }
        }
      }
    } catch {}
  }
}

loadDotEnv();

// Validador estrito de porta (rejeita 3000abc, 3.5, números <= 0, > 65535)
function parseStrictPort(value, paramName, defaultVal) {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    return defaultVal;
  }
  const str = String(value).trim();
  if (!/^\d+$/.test(str)) {
    console.error(`[Rodrigo AI Dev] Configuração inválida: ${paramName} deve ser um número inteiro positivo entre 1 e 65535. Recebido: "${value}"`);
    process.exit(1);
  }
  const port = parseInt(str, 10);
  if (port < 1 || port > 65535) {
    console.error(`[Rodrigo AI Dev] Configuração inválida: ${paramName} deve ser um número inteiro positivo entre 1 e 65535. Recebido: "${value}"`);
    process.exit(1);
  }
  return port;
}

function parseStrictHost(value, defaultHost = '127.0.0.1') {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    return defaultHost;
  }
  const trimmed = String(value).trim().toLowerCase();
  if (trimmed !== '127.0.0.1' && trimmed !== 'localhost') {
    console.error(`[Rodrigo AI Dev] Configuração inválida: HOST deve ser 127.0.0.1 ou localhost. Recebido: "${value}"`);
    process.exit(1);
  }
  return trimmed;
}

const PORT = parseStrictPort(process.env.PORT, 'PORT', 3000);
const CLIENT_PORT = parseStrictPort(process.env.CLIENT_PORT, 'CLIENT_PORT', 5173);
const HOST = parseStrictHost(process.env.HOST, '127.0.0.1');

if (PORT === CLIENT_PORT) {
  console.error(`[Rodrigo AI Dev] Configuração inválida: PORT (${PORT}) e CLIENT_PORT (${CLIENT_PORT}) devem ser portas distintas.`);
  process.exit(1);
}

// Checagem de disponibilidade de porta em loopback
function checkPortAvailable(port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const tester = net.createServer();
    tester.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`A porta ${port} já está ocupada em ${host}. Encerre o processo anterior ou utilize outra porta.`));
      } else {
        reject(err);
      }
    });
    tester.once('listening', () => {
      tester.close(() => resolve());
    });
    tester.listen(port, host);
  });
}

// Localização de binários locais para execução direta via process.execPath sem shell
const tscBin = path.resolve('node_modules/typescript/bin/tsc');
const viteBin = path.resolve('node_modules/vite/bin/vite.js');

if (!fs.existsSync(tscBin)) {
  console.error(`[Rodrigo AI Dev] Binário do TypeScript não encontrado em ${tscBin}. Execute npm ci.`);
  process.exit(1);
}
if (!fs.existsSync(viteBin)) {
  console.error(`[Rodrigo AI Dev] Binário do Vite não encontrado em ${viteBin}. Execute npm ci.`);
  process.exit(1);
}

// Gerenciamento de processos filhos e encerramento limpo sem órfãos
const activeChildren = new Set();
let isShuttingDown = false;

function cleanupAndExit(code = 0) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  process.exitCode = code;

  console.log('\n[Rodrigo AI Dev] Encerrando processos filhos de desenvolvimento...');

  for (const child of activeChildren) {
    try {
      child.kill('SIGTERM');
    } catch {}
  }

  // 3500ms: dá tempo do backend encerrar o worker Python de voz (Fase 2) com sua
  // própria janela de 3s de graça antes do SIGKILL forçado aqui (Achado v2-6).
  const forceKillTimer = setTimeout(() => {
    for (const child of activeChildren) {
      try {
        child.kill('SIGKILL');
      } catch {}
    }
    process.exit(code);
  }, 3500);

  forceKillTimer.unref();

  if (activeChildren.size === 0) {
    process.exit(code);
  }
}

// Registrar interceptadores de sinais antes de iniciar subprocessos
process.on('SIGINT', () => cleanupAndExit(130));
process.on('SIGTERM', () => cleanupAndExit(143));

async function main() {
  try {
    await checkPortAvailable(PORT, HOST);
    await checkPortAvailable(CLIENT_PORT, HOST);
  } catch (err) {
    console.error(`[Rodrigo AI Dev] Erro de porta: ${err.message}`);
    process.exit(1);
  }

  console.log(`[Rodrigo AI Dev] Iniciando ambiente de desenvolvimento...`);
  console.log(`[Rodrigo AI Dev] API Backend: http://${HOST}:${PORT}`);
  console.log(`[Rodrigo AI Dev] Frontend Vite: http://${HOST}:${CLIENT_PORT}`);

  // 1. Compilar backend TypeScript via node direto sem shell
  const buildProc = spawn(process.execPath, [tscBin, '-p', 'tsconfig.server.json'], {
    stdio: 'inherit'
  });
  activeChildren.add(buildProc);

  buildProc.on('exit', (code) => {
    activeChildren.delete(buildProc);

    if (code !== 0) {
      console.error(`[Rodrigo AI Dev] Falha na compilação TypeScript (código ${code}).`);
      cleanupAndExit(code || 1);
      return;
    }

    if (isShuttingDown) return;

    // 2. Iniciar servidor backend
    const validatedEnv = {
      ...process.env,
      PORT: String(PORT),
      HOST: HOST,
      CLIENT_PORT: String(CLIENT_PORT)
    };

    const serverProc = spawn(process.execPath, ['dist/server/backend/index.js'], {
      stdio: 'inherit',
      env: validatedEnv
    });
    activeChildren.add(serverProc);

    serverProc.on('exit', (code) => {
      activeChildren.delete(serverProc);
      if (!isShuttingDown) {
        console.log(`[Rodrigo AI Dev] Processo do backend finalizou com código ${code}.`);
        cleanupAndExit(code || 1);
      }
    });

    // 3. Iniciar Vite dev server
    const viteProc = spawn(process.execPath, [viteBin], {
      stdio: 'inherit',
      env: validatedEnv
    });
    activeChildren.add(viteProc);

    viteProc.on('exit', (code) => {
      activeChildren.delete(viteProc);
      if (!isShuttingDown) {
        console.log(`[Rodrigo AI Dev] Processo do Vite finalizou com código ${code}.`);
        cleanupAndExit(code || 1);
      }
    });
  });
}

main();
