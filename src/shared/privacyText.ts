import type { PrivacyStatus } from './types.js';

/**
 * Fase 12 (docs/phase-12-v2.md §2.3): texto do cartão de privacidade, em PT-BR simples, derivado de
 * GET /api/privacy. Função pura — usada pela tela e pelos testes, então a tela nunca diverge do que
 * foi testado. Mostra a CONFIGURAÇÃO em vigor, não uma medição do tráfego (a medição é o teste H12.2).
 */
export interface PrivacyCardText {
  headline: string;
  stays: string[];
  goes: string[];
  warnings: string[];
  footnote: string;
}

export const PRIVACY_FOOTNOTE =
  'Isto mostra a configuração em vigor, não uma medição do tráfego. Mude com as variáveis RODRIGO_* no arquivo .env e reinicie.';

/**
 * Fato verificado em 2026-10-07 nos termos da API (ai.google.dev/gemini-api/terms, atualizados em 2026-04-28): no nível
 * GRATUITO o Google usa o conteúdo para melhorar produtos e revisores humanos podem lê-lo; no PAGO afirma que não usa.
 * A tela não sabe o nível do projeto, então diz isso de forma condicional e manda conferir.
 */
export const FREE_TIER_NOTICE =
  'Atenção: no nível gratuito da API do Gemini, o Google pode usar o conteúdo enviado para melhorar seus produtos e pessoas podem revisá-lo; no nível pago, o Google afirma que não usa. Confira o nível do seu projeto no Google AI Studio e os termos em ai.google.dev/gemini-api/terms.';

export const PRIVACY_UNAVAILABLE_TEXT =
  'Não foi possível ler a configuração de privacidade. Assuma que, com a geração em nuvem ligada, o texto das suas falas vai ao Gemini.';

export function describePrivacy(status: PrivacyStatus): PrivacyCardText {
  const stays = [
    'Seu áudio é transcrito neste computador e nunca é enviado a nenhum serviço.',
    'Notas, lembretes e memórias ficam salvos só neste computador.'
  ];
  const goes: string[] = [];
  const warnings: string[] = [];

  if (status.mode === 'local-only') {
    return {
      headline: 'Modo sem nuvem: nada é enviado ao Gemini.',
      stays: [
        ...stays,
        'Hora, data, lembretes e notas funcionam; perguntas que precisam de uma resposta gerada recebem o aviso de que a geração está desligada.'
      ],
      goes: [],
      warnings: [],
      footnote: PRIVACY_FOOTNOTE
    };
  }

  goes.push(
    status.sends.history
      ? `O texto da conversa recente (as últimas ${status.sends.historyTurns} trocas) vai ao Gemini para gerar cada resposta. Isso inclui o que você disse e o que o assistente repetiu nesta sessão, mesmo que seja conteúdo de uma nota ou memória.`
      : 'Só a sua fala atual (sem o histórico da conversa) vai ao Gemini para gerar a resposta.'
  );
  goes.push(
    status.sends.utteranceForIntent
      ? 'O texto de falas sobre hora, data, lembretes e notas também vai ao Gemini, só para entender o pedido.'
      : 'Pedidos de hora, data, lembretes e notas são entendidos neste computador.'
  );
  goes.push(
    status.sends.memories
      ? 'As memórias que você salvou são enviadas ao Gemini junto com cada resposta.'
      : 'As memórias que você salvou não são enviadas ao Gemini.'
  );
  goes.push(
    status.sends.knowledgeSnippet
      ? 'Trechos dos seus textos de pesquisa (Teologia e Virtologia) são enviados ao Gemini quando relevantes.'
      : 'Os seus textos de pesquisa (Teologia e Virtologia) não são enviados ao Gemini.'
  );

  warnings.push(FREE_TIER_NOTICE);
  if (!status.keyPresent) {
    warnings.push('Não há chave do Gemini configurada (GEMINI_API_KEY): as respostas geradas em nuvem não vão funcionar.');
  }

  return {
    headline: 'Esta conversa usa a nuvem (Gemini) para gerar as respostas.',
    stays,
    goes,
    warnings,
    footnote: PRIVACY_FOOTNOTE
  };
}
