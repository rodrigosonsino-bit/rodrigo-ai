import type { StoredItem } from '../storage/jsonStore.js';
import { resolveConflicts } from './conflictResolver.js';
import { neutralizeUntrusted, wrapUntrusted, UNTRUSTED_NOTICE } from './untrustedData.js';

export const MAX_MEMORIES_INJECTED = 10;
export const MAX_MEMORY_BLOCK_CHARS = 1200;

export function buildMemoryBlock(items: readonly StoredItem[]): string {
  if (items.length === 0) return '';
  // Dedup PRIMEIRO (Fase 16, Fatia 4 — resolveConflicts), corte de tamanho DEPOIS.
  // Na ordem inversa, o slice poderia descartar a entrada nova e manter a velha.
  const deduped = resolveConflicts(items);
  const recent = deduped.slice(-MAX_MEMORIES_INJECTED).reverse();
  const lines: string[] = [];
  let totalChars = 0;
  for (const it of recent) {
    const line = `- ${neutralizeUntrusted(it.text)}`;
    if (totalChars + line.length > MAX_MEMORY_BLOCK_CHARS) break; // corta as mais antigas primeiro
    lines.push(line);
    totalChars += line.length + 1;
  }
  if (lines.length === 0) return '';
  return `[Fatos que o usuário pediu para você lembrar entre sessões — use-os naturalmente na conversa, nunca liste-os como uma lista para o usuário a menos que ele peça explicitamente. ${UNTRUSTED_NOTICE}]\n${wrapUntrusted(lines)}`;
}
