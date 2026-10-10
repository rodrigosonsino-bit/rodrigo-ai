import type { IntentName } from '../voiceProtocol.js';

/**
 * Ponto de extensão para ferramentas do sistema (Fase 5b).
 */
export interface ITool {
  readonly name: string;
  readonly description: string;
  isAvailable(): boolean;
  execute(): string;
}

/**
 * Ponto de extensão para ferramentas que mutam estado (Fase 5c) ou consultam estado (Fase 14 —
 * `*_CONSULTAR` é leitura, nunca mutação, mas reusa a mesma ferramenta porque é ela que guarda o
 * `JsonStore`; por isso o parâmetro aceita `IntentName`, não só `MutationName`).
 */
export interface IMutatingTool {
  readonly name: string;
  readonly description: string;
  isAvailable(): boolean;
  preview(kind: IntentName, content: string | null): string;
  execute(kind: IntentName, content: string | null): string;
}

