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
  };
  models: { generation: string | null; intent: string | null; tts: string | null };
  /** Fase 13a: estado EFETIVO do TTS em nuvem (a flag sozinha não basta; ver ttsCloudEffective). */
  tts: {
    cloud: boolean;
    reason: 'master-off' | 'channel-off' | 'history-off' | null;
    dictatedViaCloud: boolean;
  };
  neverSends: readonly ['audio'];
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
