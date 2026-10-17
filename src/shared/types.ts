/**
 * Resposta estrita do endpoint GET /api/health.
 * Campos restritos e sem exposição de ambiente ou segredos.
 */
export interface HealthResponse {
  status: 'ok';
  version: '0.3.0';
}

/**
 * Status descritivo dos módulos da arquitetura para a interface.
 */
export interface ModuleStatus {
  id: string;
  name: string;
  phase: number;
  available: boolean;
  description: string;
}

/**
 * Configurações validadas da aplicação.
 */
export interface AppConfig {
  port: number;
  host: string;
  clientPort: number;
}

/**
 * Fase 12 — GET /api/privacy: configuração em vigor do que o sistema envia ao Gemini.
 * Declarativa (derivada das variáveis de ambiente); a medição do tráfego real é o teste H12.2.
 * Nunca contém segredos: só se a chave existe, jamais valor ou tamanho.
 */
/** T1: modo do guarda de saída (RODRIGO_OUTBOUND_GUARD). */
export type OutboundGuardModeName = 'off' | 'warn' | 'redact' | 'block';

export interface PrivacyStatus {
  mode: 'cloud' | 'local-only';
  intent: 'gemini' | 'local';
  keyPresent: boolean;
  sends: {
    utteranceForIntent: boolean;
    history: boolean;
    historyTurns: number | null;
    memories: boolean;
    knowledgeSnippet: boolean;
    /** Fase 13a: o texto de cada frase falada vai ao Gemini para virar voz. */
    ttsText: boolean;
    /** Fase V: imagem da tela enviada ao Gemini somente com autorização explícita. */
    visionImage: boolean;
    /** Fase 15: busca web autônoma via OpenClaw (mestre + RODRIGO_WEB_SEARCH). */
    webSearch: boolean;
    /** Fase 17: ordem (e arquivos lidos pelo claude -p) podem ir à Anthropic. */
    claudeCodeOrder: boolean;
    /** Camada Ogra: o texto da fala vai ao webhook quando RODRIGO_OGRA=1. O áudio não. */
    ograUtterance: boolean;
  };
  models: { generation: string | null; intent: string | null; tts: string | null };
  /** Fase 13a: estado EFETIVO do TTS em nuvem (a flag sozinha não basta; ver ttsCloudEffective). */
  tts: {
    cloud: boolean;
    reason: 'master-off' | 'channel-off' | 'history-off' | null;
    dictatedViaCloud: boolean;
  };
  /** Fase 15: estado EFETIVO da busca web (mestre + canal; ver webSearchEffective). */
  webSearch: {
    enabled: boolean;
    reason: 'master-off' | 'channel-off' | null;
  };
  /** Fase 17: estado EFETIVO do Claude Code (mestre + RODRIGO_CLAUDE_CODE). */
  claudeCode: {
    enabled: boolean;
    reason: 'master-off' | 'channel-off' | null;
  };
  /**
   * Automação desktop (computer-use): controla apps locais sem SIM por passo.
   * Texto/AX não saem salvo pelos canais de geração/visão já configurados.
   */
  autoDesktop: {
    enabled: boolean;
    reason: 'flag-off' | 'desktop-control-off' | null;
  };
  /** Camada Ogra. Padrão desligado. Não depende do mestre Gemini. */
  ogra: {
    enabled: boolean;
  };
  neverSends: readonly ['audio'];
  /** T1: modo do guarda que varre o TEXTO antes de sair (não varre imagem). */
  outboundGuard: OutboundGuardModeName;
  /** T1: contadores por TIPO de achado desde que o app iniciou; nunca o conteúdo. Preenchido só pela rota. */
  outboundGuardCounts?: Record<string, number>;
}

/**
 * Fase 13a — GET /api/voice/tts-status: qual voz fala e quanto da cota do dia já foi usada. Só números e o nome da voz;
 * nunca texto de conversa.
 */
export interface TtsStatus {
  engine: string;
  name: string;
  /** null quando a voz é a do sistema (não há orçamento a mostrar). */
  budget: { used: number; limit: number; minuteUsed: number; rpm: number; exhausted: boolean; blockedForMs: number } | null;
  counters: { gemini: number; fallback: number; failures: number } | null;
}

/**
 * GET /api/usage: gasto PRÓPRIO com o Gemini no dia (livro-caixa local, UsageLedger).
 * Só números agregados por (fonte, modelo); nenhum texto de conversa, transcrição ou frase.
 * É "o que o app consumiu", não a conta da chave (outras ferramentas com a mesma chave não entram).
 */
export type UsageSourceName = 'geracao' | 'intencao' | 'visao' | 'tts';

export interface UsageModelRow {
  source: UsageSourceName;
  model: string;
  req: number;
  inTokens: number;
  outTokens: number;
  cap: number;
  pct: number;
}

export interface UsageStatus {
  day: string;
  resetInMs: number;
  models: UsageModelRow[];
}
