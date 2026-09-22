/**
 * Ponto de extensão para ferramentas do sistema (Fase 5b).
 */
export interface ITool {
  readonly name: string;
  readonly description: string;
  isAvailable(): boolean;
  execute(): string;
}

