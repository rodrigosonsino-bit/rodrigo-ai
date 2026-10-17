/**
 * Eco do alto-falante. O servidor deixa o estado `falando` assim que a síntese
 * termina; o cliente ainda está tocando. Com o viva-voz desligado,
 * `speakingForVad` ignora `playbackActive` de propósito (H-VV.M2). Este módulo
 * é a trava à parte: o microfone não abre turno enquanto a saída toca, nem por
 * um rabo curto depois, e um texto igual ao que acabou de ser falado não vira
 * pedido novo.
 */

/** Rabo depois do fim da reprodução, para o som da sala não reabrir o turno. */
export const OUTPUT_TAIL_MS = 1200;

/**
 * Frase falada longa o bastante para valer como eco mesmo com uma palavra a
 * mais na transcrição. Abaixo disso só casa igualdade (ou a frase repetida),
 * para "pensando" não engolir "estou pensando em sair".
 */
export const MIN_CONTAINED_ECHO_CHARS = 12;

export const RECENT_SPOKEN_LIMIT = 8;

export function normalizeTtsEcho(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isRepeatedShortPhrase(heard: string, said: string): boolean {
  if (!said || said.includes(' ')) return false;
  const words = heard.split(' ');
  return words.length > 1 && words.every((word) => word === said);
}

export function isTtsEchoTranscript(transcript: string, spoken: readonly string[]): boolean {
  const heard = normalizeTtsEcho(transcript);
  if (!heard) return false;
  for (const line of spoken) {
    const said = normalizeTtsEcho(line);
    if (!said) continue;
    if (heard === said) return true;
    if (said.length >= MIN_CONTAINED_ECHO_CHARS && heard.includes(said)) return true;
    if (isRepeatedShortPhrase(heard, said)) return true;
  }
  return false;
}

/**
 * Ignora o microfone enquanto o Ork fala ou toca o sinal, e no rabo.
 * `sseSpeaking` é o estado SSE `falando`. `playbackActive` cobre o áudio que
 * ainda toca depois que o servidor já voltou a `processando`/`ouvindo`.
 */
export function micIgnoredWhileOutput(input: {
  playbackActive: boolean;
  sseSpeaking: boolean;
  tailUntil: number;
  now: number;
}): boolean {
  if (input.playbackActive || input.sseSpeaking) return true;
  return input.now < input.tailUntil;
}
