import fs from 'node:fs';
import path from 'node:path';
import { ExtensionRegistry } from '../../shared/extensions/registry.js';
import { createSpecialistAgents } from '../agents/specialistAgents.js';
import { AudioStore } from './audioStore.js';
import { MlxWorkerEngine } from './mlxWorkerEngine.js';
import { SessionManager } from './sessionManager.js';
import { selectVoiceProvider } from './ttsProviders.js';
import { VOICE_LIMITS } from '../../shared/voiceProtocol.js';

export interface VoiceRuntime {
  available: boolean;
  reason?: string;
  sessionManager?: SessionManager;
  audioStore?: AudioStore;
  shutdown: () => Promise<void>;
}

/**
 * Monta o runtime de voz se — e só se — o setup local (`npm run setup:voice`) já rodou.
 * Ausência de qualquer peça (venv, worker script, modelos) é diagnosticada honestamente
 * em PT-BR; a base da Fase 1 continua funcionando sem depender de Python (B2).
 */
export function createVoiceRuntime(rootDir: string): VoiceRuntime {
  // Usado pela suíte de testes automatizada: garante que `npm test` nunca depende de
  // Python/MLX estarem instalados ou aquecidos, mesmo que .runtime já exista na máquina
  // de quem está rodando os testes (B2: "retorno à base não depende de Python").
  if (process.env.RODRIGO_VOICE_DISABLE === '1') {
    return {
      available: false,
      reason: 'Voz desabilitada explicitamente (RODRIGO_VOICE_DISABLE=1).',
      shutdown: async () => {}
    };
  }

  const venvPython = path.join(rootDir, '.runtime', '.venv', 'bin', 'python3');
  const workerScript = path.join(rootDir, 'scripts', 'worker', 'worker.py');
  const manifestPath = path.join(rootDir, '.runtime', 'models-manifest.json');
  const hfCacheDir = path.join(rootDir, '.runtime', 'hf-cache');

  if (!fs.existsSync(venvPython)) {
    return {
      available: false,
      reason: 'Runtime de voz não configurado: rode "npm run setup:voice" primeiro (cria o ambiente Python local e baixa os modelos).',
      shutdown: async () => {}
    };
  }
  if (!fs.existsSync(workerScript)) {
    return {
      available: false,
      reason: `Worker de voz não encontrado em ${workerScript}.`,
      shutdown: async () => {}
    };
  }
  if (!fs.existsSync(manifestPath)) {
    return {
      available: false,
      reason: 'Modelos de voz não baixados: rode "npm run setup:voice" para materializá-los localmente.',
      shutdown: async () => {}
    };
  }

  const engine = new MlxWorkerEngine({ pythonBin: venvPython, workerScript, hfCacheDir });
  const ttsProvider = selectVoiceProvider();
  ExtensionRegistry.getInstance().registerVoiceProvider(ttsProvider);

  const agents = createSpecialistAgents();
  for (const agent of agents) {
    ExtensionRegistry.getInstance().registerAgent(agent);
  }

  const audioStore = new AudioStore(path.join(rootDir, '.runtime', 'tmp'));
  const sessionManager = new SessionManager(engine, ttsProvider, audioStore, agents);

  return {
    available: true,
    sessionManager,
    audioStore,
    shutdown: async () => {
      await sessionManager.shutdownAll();
      await engine.shutdown();
    }
  };
}

export { VOICE_LIMITS };
