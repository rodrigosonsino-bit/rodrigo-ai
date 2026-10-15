/**
 * Modo viva-voz (plano docs/plans/modo-viva-voz-v3-min.md).
 * Funções puras — testáveis no `npm test` sem WebAudio.
 */

export const SPEAKERPHONE_STORAGE_KEY = 'rodrigo.voice.speakerphone';

/** Limiares atuais (toggle off) — não alterar sem medição T8. */
export const DEFAULT_VAD = {
  rmsListen: 0.012,
  rmsWhileOutput: 0.045,
  bargeInHysteresisMs: 250
} as const;

/**
 * Limiares provisórios do viva-voz (a calibrar na T8).
 * Mais altos para reduzir falso barge-in / turno por eco de alto-falante.
 */
export const SPEAKERPHONE_VAD = {
  rmsListen: 0.02,
  rmsWhileOutput: 0.07,
  bargeInHysteresisMs: 350
} as const;

export function vadThresholds(speakerphone: boolean): {
  rmsListen: number;
  rmsWhileOutput: number;
  bargeInHysteresisMs: number;
} {
  return speakerphone ? { ...SPEAKERPHONE_VAD } : { ...DEFAULT_VAD };
}

/**
 * Com viva-voz ligado: qualquer indício de saída de áudio (playback real OU SSE ainda
 * em "falando" entre frases) usa o limiar elevado. Com toggle off: só o estado SSE
 * (comportamento histórico).
 */
export function speakingForVad(
  speakerphone: boolean,
  playbackActive: boolean,
  sseStateIsSpeaking: boolean
): boolean {
  if (speakerphone) return playbackActive || sseStateIsSpeaking;
  return sseStateIsSpeaking;
}

/** Duck leve (~1,4 dB). Não vender como mitigação principal de eco. */
export function playbackDuckGain(speakerphone: boolean): number {
  return speakerphone ? 0.85 : 1;
}

/**
 * Mensagem honesta sobre AEC. `undefined` / false = risco (WKWebView pode omitir o campo).
 * Nunca afirma que o eco está "filtrado".
 */
export function aecStatusMessage(echoCancellation: boolean | undefined): string {
  if (echoCancellation === true) {
    return 'Viva-voz: cancelamento de eco pedido ao sistema (não prova filtragem acústica).';
  }
  return 'Viva-voz sem cancelamento de eco confirmado pelo sistema — risco alto de eco no alto-falante.';
}

export function parseSpeakerphoneFlag(raw: unknown): boolean {
  if (raw === true || raw === 1) return true;
  if (typeof raw === 'string') {
    const v = raw.trim();
    if (v === '1' || v.toLowerCase() === 'true') return true;
    if (v === '0' || v.toLowerCase() === 'false' || v === '') return false;
  }
  return false;
}

/** Só limpa currentSource se o nó que terminou é o que ainda está ativo (corrida onended). */
export function shouldClearSource(
  endedSource: unknown,
  currentSource: unknown
): boolean {
  return endedSource != null && endedSource === currentSource;
}
