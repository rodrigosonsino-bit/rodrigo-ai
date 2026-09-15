/**
 * Ponto de extensão para agentes especialistas (Fase 4). Cada agente é um objeto
 * estático (identidade + metodologia + limites) sem dependência externa — isAvailable()
 * sempre true. O efeito prático só existe dentro do pipeline classify()->generate(),
 * então o registro real acontece junto com o runtime de voz (ver voiceRuntime.ts).
 */
export interface IAgent {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  isAvailable(): boolean;
  getSystemPrompt(): string;
}
