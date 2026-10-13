import type { PrivacyStatus, TtsStatus } from './types.js';

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

  if (status.webSearch.enabled) {
    goes.push(
      'Pedidos de busca na web podem sair deste computador via OpenClaw (canal RODRIGO_WEB_SEARCH ligado).'
    );
  } else if (status.webSearch.reason === 'channel-off') {
    stays.push('A busca na web está desligada (RODRIGO_WEB_SEARCH=0).');
  } else if (status.webSearch.reason === 'master-off') {
    // modo local-only já retornou acima; este ramo é defensivo
    stays.push('A busca na web está desligada porque a nuvem está desligada.');
  }

  if (status.sends.visionImage) {
    goes.push(
      'A imagem da tela só vai ao Gemini quando você autoriza na própria fala, naquele pedido (canal RODRIGO_CLOUD_VISION ligado).'
    );
  } else {
    stays.push('A imagem da tela não é enviada ao Gemini (RODRIGO_CLOUD_VISION desligado, que é o padrão).');
  }

  if (status.tts.cloud) {
    goes.push(
      'O texto de cada frase que o assistente vai falar vai ao Gemini para virar voz (o seu áudio nunca vai). Isso inclui frases que você interromper antes de ouvir até o fim.'
    );
    goes.push(
      status.tts.dictatedViaCloud
        ? 'Confirmações que repetem o que você ditou (notas, lembretes, memórias) também são enviadas ao Gemini para virar voz.'
        : 'Confirmações que repetem o que você ditou (notas, lembretes, memórias) são faladas com a voz do sistema, sem sair deste computador.'
    );
  } else if (status.tts.reason === 'history-off') {
    stays.push('As respostas são faladas com a voz do sistema, neste computador, porque o histórico da conversa não é enviado (RODRIGO_SEND_HISTORY=0).');
  } else if (status.tts.reason === 'channel-off') {
    stays.push('As respostas são faladas com a voz do sistema, neste computador (RODRIGO_CLOUD_TTS=0).');
  }

  // T1: o guarda de saída varre o TEXTO antes de enviar. Não varre imagem (ver o canal de visão acima).
  if (status.outboundGuard === 'redact') {
    goes.push('Antes de enviar texto ao Gemini, o app procura chaves de API, senhas ditadas, CPF, CNPJ e cartão e troca cada achado por um aviso (RODRIGO_OUTBOUND_GUARD=redact). Imagens não são varridas.');
  } else if (status.outboundGuard === 'block') {
    goes.push('Se o app encontrar chave de API, senha ditada, CPF, CNPJ ou cartão no texto, ele não envia nada ao Gemini e avisa (RODRIGO_OUTBOUND_GUARD=block). Imagens não são varridas.');
  } else if (status.outboundGuard === 'warn') {
    warnings.push('O guarda de saída está só avisando (RODRIGO_OUTBOUND_GUARD=warn): chaves, senhas ditadas, CPF, CNPJ e cartão são contados, mas ainda são enviados ao Gemini.');
  } else {
    warnings.push('O guarda de saída está desligado (RODRIGO_OUTBOUND_GUARD=off): nada varre o texto antes de ele ir ao Gemini.');
  }

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

/**
 * Fase 13a: uma linha, em PT-BR simples, sobre a voz que está falando e a cota do dia. Função pura (a tela e os testes
 * usam a mesma). Nunca promete que o texto fica neste computador: quando a voz é a do Gemini, o texto das frases vai a ele
 * (isso está no cartão de privacidade acima).
 */
export function describeTtsStatus(status: TtsStatus | null): string | null {
  if (!status) return null;
  const b = status.budget;
  if (status.engine !== 'gemini' || !b) return 'Voz do sistema (macOS) falando as respostas.';
  if (b.exhausted) {
    return `Voz natural (Gemini) esgotada por hoje (${b.used} de ${b.limit} pedidos). As respostas saem com a voz do sistema até a cota renovar.`;
  }
  if (b.blockedForMs > 0) {
    return `Voz natural (Gemini) em pausa por cerca de ${Math.ceil(b.blockedForMs / 1000)} s. Enquanto isso, a voz do sistema fala as respostas.`;
  }
  return `Voz natural (Gemini): ${b.used} de ${b.limit} pedidos usados hoje.`;
}
