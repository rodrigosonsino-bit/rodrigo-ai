import type { StoredItem } from '../storage/jsonStore.js';

// Palavras que carregam zero informação de tópico para memórias de preferência pessoal —
// inclui verbos comuns de preferência/posse, porque o que importa pra deduplicar é o OBJETO
// ("café", "açúcar"), não o verbo ("gosto" vs "tomo" vs "prefiro") nem a negação ("sem").
// Isto é deliberado: o objetivo é agrupar por ASSUNTO pra decidir qual é mais recente, não
// entender a relação semântica entre as duas — essa segunda tarefa ficaria genuinamente mais
// cara (exigiria embeddings ou chamada a LLM) e não está no escopo desta fase.
const TOPIC_STOPWORDS = new Set([
  'eu', 'o', 'a', 'os', 'as', 'de', 'da', 'do', 'das', 'dos', 'que', 'e', 'é', 'um', 'uma',
  'com', 'sem', 'para', 'por', 'em', 'no', 'na', 'meu', 'minha', 'me', 'nao', 'não',
  'gosto', 'gosta', 'prefiro', 'prefere', 'quero', 'quer', 'tomo', 'toma', 'bebo', 'bebe',
  'como', 'come', 'uso', 'usa', 'sou', 'é', 'tenho', 'tem'
]);

export interface SuppressionLogEntry {
  timestamp: string;   // ISO, momento da supressão
  topicKey: string;    // chave retornada por deriveTopicKey
  suppressed: { text: string; createdAt: string };
  kept: { text: string; createdAt: string };
  reason: 'preference_update' | 'cumulative_false_positive' | 'unknown';
}

// Sink injetável para o registro obrigatório de supressões (achado r2 N1 da Fase 16).
// Padrão: console.warn. Produção pode ligar aqui o ExecutionTrace / armazenamento durável
// sem acoplar este módulo ao SubAgentCoordinator.
export type SuppressionLogger = (entry: SuppressionLogEntry) => void;

let suppressionLogger: SuppressionLogger = (entry) => {
  console.warn('[memory] supressão por conflito:', entry);
};

export function setSuppressionLogger(logger: SuppressionLogger): void {
  suppressionLogger = logger;
}

function logSuppression(key: string, suppressed: StoredItem, kept: StoredItem): void {
  const entry: SuppressionLogEntry = {
    timestamp: new Date().toISOString(),
    topicKey: key,
    suppressed: { text: suppressed.text, createdAt: suppressed.createdAt },
    kept: { text: kept.text, createdAt: kept.createdAt },
    reason: 'unknown' // classificação do motivo fica para heurística futura
  };
  // Best-effort: falha no log nunca quebra o dedupe (o dedupe de memória não pode falhar
  // por causa do log de auditoria do próprio dedupe).
  try {
    suppressionLogger(entry);
  } catch {
    /* noop deliberado */
  }
}

export function deriveTopicKey(text: string): string {
  const normalize = (s: string) =>
    s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s]/g, '');
  const words = normalize(text)
    .split(/\s+/)
    .filter((w) => w.length > 0 && !TOPIC_STOPWORDS.has(w));
  // Fallback (achado r2 N3): aplica a MESMA normalização no texto-cru — antes, frases só de
  // stopwords com grafias acentuadas diferentes ("não é" vs "nao e") não colidiam por engano.
  if (words.length === 0) return normalize(text).trim();
  return words.slice(0, 4).sort().join('_'); // ordenado: ordem de palavras na frase não deveria mudar o agrupamento
}

/** Agrupa por tópico derivado, mantém só a entrada mais recente (createdAt maior) de cada grupo.
 *  Determinístico: mesma entrada, mesmo resultado, sempre — sem chamada de rede nem de LLM.
 *  REGISTRO OBRIGATÓRIO (achado r2 N1): toda entrada suprimida é logada via SuppressionLogger
 *  com a chave e o createdAt, para auditoria e para responder "por que você esqueceu X?" —
 *  a supressão não é silenciosa. */
export function resolveConflicts(items: readonly StoredItem[]): StoredItem[] {
  const byKey = new Map<string, StoredItem>();
  for (const it of items) {
    const key = deriveTopicKey(it.text);
    const existing = byKey.get(key);
    if (!existing || it.createdAt > existing.createdAt) {
      if (existing) logSuppression(key, existing, it); // suprimiu `existing` em favor de `it`
      byKey.set(key, it);
    } else {
      logSuppression(key, it, existing); // suprimiu `it` em favor de `existing`
    }
  }
  return Array.from(byKey.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
