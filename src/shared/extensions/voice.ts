/**
 * Ponto de extensão para provedores de voz (Fase 2).
 */

/** Fase 13a: de onde vem o texto que será falado (decide se pode ir à voz em nuvem; ver docs/phase-13a-v3.md §3, D-b). */
export type SpeechKind = 'generated' | 'dictated' | 'local';

export interface SynthesizeOptions {
  /** Turno ao qual a frase pertence (reserva de cota e disjuntor são por turno). */
  turnId?: string;
  kind?: SpeechKind;
  /** É a primeira frase falada do turno (prazo local mais curto: o usuário espera em silêncio). */
  isFirstOfTurn?: boolean;
}

export interface IVoiceProvider {
  readonly id: string;
  readonly name: string;
  isAvailable(): boolean;
  /**
   * Fase 13a: true se o provedor ganha em receber frases agrupadas (menos pedidos a uma cota limitada). O gerenciador de
   * sessão só agrupa frases de índice >= 1 de uma resposta gerada; nunca perguntas de mutação, reprompts ou ferramentas.
   */
  readonly prefersCoalescing?: boolean;
  /**
   * Sintetiza texto em áudio e grava um arquivo WAV em outputPath.
   * Nunca reproduz áudio diretamente (sem alto-falante do backend) — apenas grava o arquivo.
   * `signal`, se fornecido, aborta o subprocesso de síntese (usado na preempção de sessão
   * — Achado v2-1: matar TTS em andamento antes de apagar os arquivos temporários).
   */
  synthesize(text: string, outputPath: string, signal?: AbortSignal, options?: SynthesizeOptions): Promise<void>;
  /** Fase 13a: o turno terminou (ou foi superado); libera o que o provedor reservou para ele. */
  endTurn?(turnId: string): void;
  /**
   * T9-política (a): chamado quando uma voz em nuvem cai para a do sistema POR INDISPONIBILIDADE (cota ou falha).
   * Não é chamado quando a voz do sistema foi escolhida por privacidade (conteúdo ditado, guarda em block) nem por
   * configuração. `reason` é um código curto, nunca texto de frase.
   */
  onFallback?: (info: { turnId?: string; reason: string }) => void;
}
