/**
 * Ponto de extensão para ferramentas do sistema (Fase 4).
 * Não implementado na Fase 1.
 */
export interface ITool {
  readonly name: string;
  readonly description: string;
  isAvailable(): boolean;
}
