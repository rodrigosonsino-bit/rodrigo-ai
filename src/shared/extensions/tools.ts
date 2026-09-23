import type { MutationName } from '../voiceProtocol.js';

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
 * Ponto de extensão para ferramentas que mutam estado (Fase 5c).
 */
export interface IMutatingTool {
  readonly name: string;
  readonly description: string;
  isAvailable(): boolean;
  preview(kind: MutationName, content: string | null): string;
  execute(kind: MutationName, content: string | null): string;
}

