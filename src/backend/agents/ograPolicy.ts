/**
 * Fase 1 da camada Ogra: o que o endpoint POST /api/ogra/tool pode propor.
 *
 * A Ogra propõe; o app executa. Leituras locais seguem na hora, pelo coordenador
 * (orçamento, capacidades, auditoria de mutação não se aplica). Mutações de
 * lembrete/nota/memória NÃO executam aqui: o app fala a pergunta e só
 * `recordMutationConfirmation` + `consumeMutationToken` depois do SIM ouvido.
 *
 * TODO (fases seguintes — não implementar neste arquivo): coordenar o cursor entre
 * editor de texto, notas, chat de IA, WhatsApp e outros apps; automação de desktop;
 * qualquer envio de mensagem para fora do app. Esses pedidos são recusados.
 */

export const OGRA_PHASE1_READS = [
  'HORA',
  'DATA',
  'LEMBRETE_CONSULTAR',
  'NOTA_CONSULTAR',
  'MEMORIA_CONSULTAR'
] as const;

export const OGRA_PHASE1_MUTATIONS = [
  'LEMBRETE_CRIAR',
  'LEMBRETE_EDITAR',
  'LEMBRETE_APAGAR',
  'LEMBRETE_REAGENDAR',
  'NOTA_CRIAR',
  'NOTA_EDITAR',
  'NOTA_APAGAR',
  'MEMORIA_GUARDAR',
  'MEMORIA_EDITAR',
  'MEMORIA_ESQUECER'
] as const;

export type OgraToolClass = 'read' | 'mutation' | 'deferred' | 'unknown';

/** Recusa estável para o que a fase 1 documenta e não aplica. */
export const OGRA_PHASE1_REFUSAL =
  'Nesta fase a Ogra não mexe em desktop, cursor, WhatsApp nem envia mensagens. Posso usar hora, data, lembretes, notas e memórias, e mutação só com o seu sim.';

const DEFERRED_RE = /^(DESKTOP|DIGITAR|DITADO|CONFIGURAR|AUTO_|AUTOMACAO|DELEGAR_)/;

export function classifyOgraTool(name: string): OgraToolClass {
  const tool = name.trim().toUpperCase();
  if ((OGRA_PHASE1_READS as readonly string[]).includes(tool)) return 'read';
  if ((OGRA_PHASE1_MUTATIONS as readonly string[]).includes(tool)) return 'mutation';
  if (DEFERRED_RE.test(tool)) return 'deferred';
  return 'unknown';
}
