/**
 * Ponto de extensão para provedores de voz (Fase 2).
 */
export interface IVoiceProvider {
  readonly id: string;
  readonly name: string;
  isAvailable(): boolean;
  /**
   * Sintetiza texto em áudio e grava um arquivo WAV em outputPath.
   * Nunca reproduz áudio diretamente (sem alto-falante do backend) — apenas grava o arquivo.
   * `signal`, se fornecido, aborta o subprocesso de síntese (usado na preempção de sessão
   * — Achado v2-1: matar TTS em andamento antes de apagar os arquivos temporários).
   */
  synthesize(text: string, outputPath: string, signal?: AbortSignal): Promise<void>;
}
