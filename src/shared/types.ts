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
  };
  models: { generation: string | null; intent: string | null };
  neverSends: readonly ['audio'];
}
