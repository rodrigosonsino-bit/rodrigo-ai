import { StringDecoder } from 'node:string_decoder';
import { redact } from '../redact.js';

/** Quanto do fim do buffer é retido ao forçar a saída por tamanho: uma chave (≈40 chars) nunca é cortada ao meio. */
export const TAIL_OVERLAP = 128;
export const MAX_BUFFERED = 8192;

/**
 * Fase 12 (§2.6): converte o stderr do worker (blocos de bytes de tamanho arbitrário) em LINHAS completas e só
 * então aplica redact(). Sem isso, uma chave partida entre dois eventos 'data' vazaria em duas fatias (reproduzido
 * pelo agy na rodada 3). Linha sem '\n' é emitida só no flush() (fim do stream); se passar de MAX_BUFFERED,
 * emite o começo e retém os últimos TAIL_OVERLAP caracteres para não cortar um segredo no limite.
 */
export function createLineSink(emit: (line: string) => void, maxBuffered = MAX_BUFFERED) {
  const decoder = new StringDecoder('utf8'); // não quebra caractere multibyte entre blocos
  let buffer = '';

  function out(line: string): void {
    const clean = redact(line).trimEnd();
    if (clean.length > 0) emit(clean);
  }

  return {
    push(chunk: Buffer | string): void {
      buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        out(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf('\n');
      }
      if (buffer.length > maxBuffered) {
        // MASCARA O BUFFER INTEIRO ANTES de cortar: uma chave que atravessa o ponto de corte já virou
        // [REDACTED]. A cauda retida (TAIL_OVERLAP > tamanho de uma chave) cobre só o segredo AINDA INCOMPLETO
        // no fim do buffer, que será completado — e mascarado — no próximo bloco.
        const clean = redact(buffer);
        if (clean.length > TAIL_OVERLAP) {
          out(clean.slice(0, clean.length - TAIL_OVERLAP));
          buffer = clean.slice(clean.length - TAIL_OVERLAP);
        } else {
          buffer = clean;
        }
      }
    },
    flush(): void {
      buffer += decoder.end();
      if (buffer.length > 0) out(buffer);
      buffer = '';
    }
  };
}
