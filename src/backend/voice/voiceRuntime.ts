import fs from 'node:fs';
import { parsePrivacyConfig, workerPrivacyEnv } from '../privacy.js';
import path from 'node:path';
import { ExtensionRegistry } from '../../shared/extensions/registry.js';
import { createSpecialistAgents } from '../agents/specialistAgents.js';
import { AudioStore } from './audioStore.js';
import { MlxWorkerEngine } from './mlxWorkerEngine.js';
import { SessionManager } from './sessionManager.js';
import { selectVoiceProvider } from './ttsProviders.js';
import { loadKnowledgeCorpus, KnowledgeRetriever } from '../knowledge/index.js';
import { createSystemTools } from '../tools/systemTools.js';
import { createMutatingTools } from '../tools/mutatingTools.js';
import { ReminderScheduler } from '../tools/reminderScheduler.js';
import { VOICE_LIMITS } from '../../shared/voiceProtocol.js';

export interface VoiceRuntime {
  available: boolean;
  reason?: string;
  sessionManager?: SessionManager;
  audioStore?: AudioStore;
  scheduler?: ReminderScheduler;
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

  // Fase 12: a mesma configuração de privacidade governa o Node e o worker. Valor inválido lança
  // aqui (falhar alto em privacidade), e o mestre RODRIGO_CLOUD chega ao worker como defesa em profundidade.
  const privacy = parsePrivacyConfig(process.env);
  const engine = new MlxWorkerEngine({
    pythonBin: venvPython,
    workerScript,
    hfCacheDir,
    env: workerPrivacyEnv(privacy)
  });
  const ttsProvider = selectVoiceProvider();
  ExtensionRegistry.getInstance().registerVoiceProvider(ttsProvider);

  const agents = createSpecialistAgents();
  for (const agent of agents) {
    ExtensionRegistry.getInstance().registerAgent(agent);
  }

  // Fase 5a: o corpus é carregado SOMENTE neste caminho — ou seja, só quando a voz está de fato
  // disponível. Mesma regra de honestidade que a Fase 4 aplica ao registro dos agentes: nada é
  // reportado como disponível antes de existir.
  // Fase 12 (D1): com RODRIGO_SEND_KNOWLEDGE=0 (padrão) o trecho nunca iria ao prompt, então o corpus
  // pessoal nem é carregado em memória — e o módulo se declara desligado em vez de "ativo".
  const knowledgeChunks = privacy.sendKnowledge ? loadKnowledgeCorpus(rootDir) : [];
  const retriever = knowledgeChunks.length > 0 ? new KnowledgeRetriever(knowledgeChunks) : null;
  ExtensionRegistry.getInstance().registerKnowledge(knowledgeChunks.length);
  ExtensionRegistry.getInstance().registerKnowledgeDisabledByPrivacy(!privacy.sendKnowledge);

  const tools = createSystemTools();
  for (const tool of tools) ExtensionRegistry.getInstance().registerTool(tool);

  // RODRIGO_DATA_DIR permite isolar a persistência de lembretes/notas em testes manuais
  // (ex. scripts/h5c-check.mjs) sem tocar data/ de produção — mesma lógica de injeção de
  // baseDir que AudioStore/JsonStore já usam, só que também respeitável via env var aqui
  // porque createVoiceRuntime() não recebe esse parâmetro do chamador (server.ts).
  const dataDir = process.env.RODRIGO_DATA_DIR
    ? path.resolve(process.env.RODRIGO_DATA_DIR)
    : path.join(rootDir, 'data');
  // Factory retorna as ferramentas, a instância única do agendador e o store de memórias
  const { tools: mutatingTools, scheduler: reminderScheduler, memoriaStore } = createMutatingTools(dataDir);
  for (const mTool of mutatingTools) ExtensionRegistry.getInstance().registerMutatingTool(mTool);

  // Inicializa o agendador carregando lembretes persistidos
  reminderScheduler.bootstrap();

  const audioStore = new AudioStore(path.join(rootDir, '.runtime', 'tmp'));
  const sessionManager = new SessionManager(
    engine, ttsProvider, audioStore, agents, retriever, tools, mutatingTools, memoriaStore, privacy
  );

  return {
    available: true,
    sessionManager,
    audioStore,
    scheduler: reminderScheduler,
    shutdown: async () => {
      reminderScheduler.shutdown(); // Cancela timers pendentes na finalização do runtime
      await sessionManager.shutdownAll();
      await engine.shutdown();
    }
  };
}

export { VOICE_LIMITS };
