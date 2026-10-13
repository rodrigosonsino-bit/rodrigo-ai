import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { effectivePrivacy } from '../privacy.js';
import { describePrivacy } from '../../shared/privacyText.js';
import {
  scanText,
  guardText,
  guardMessages,
  luhnValid,
  cpfValid,
  cnpjValid,
  maskFor,
  getOutboundCounts,
  resetOutboundCounts,
  isOutboundGuardMode,
  OutboundBlockedError,
  type FindingKind
} from '../privacy/outboundGuard.js';

// Valores sintéticos conhecidos como VÁLIDOS pelos dígitos verificadores (nenhum é de pessoa real).
const CPF = '529.982.247-25';
const CNPJ = '11.222.333/0001-81';
const CARD = '4111 1111 1111 1111'; // cartão de teste público (Luhn válido)
const API_KEY = 'AIzaSyD' + 'x'.repeat(32); // formato de chave Google, 39 caracteres, FALSA
const OPENAI_STYLE = 'sk-' + 'a1B2c3D4'.repeat(4);
const PRIV = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\n-----END PRIVATE KEY-----';

function kinds(text: string): FindingKind[] {
  return scanText(text).map((f) => f.kind);
}

describe('outboundGuard: verificadores', () => {
  it('Luhn, CPF e CNPJ: aceitam válidos e rejeitam inválidos e sequências repetidas', () => {
    assert.equal(luhnValid('4111111111111111'), true);
    assert.equal(luhnValid('4111111111111112'), false);
    assert.equal(cpfValid('52998224725'), true);
    assert.equal(cpfValid('52998224726'), false);
    assert.equal(cpfValid('11111111111'), false, 'sequência repetida passa na conta mas não é CPF');
    assert.equal(cnpjValid('11222333000181'), true);
    assert.equal(cnpjValid('11222333000182'), false);
    assert.equal(cnpjValid('00000000000000'), false);
  });
});

describe('outboundGuard: detecção (primeira rodada de padrões)', () => {
  it('cada tipo é detectado', () => {
    assert.deepEqual(kinds(`a chave é ${API_KEY} ok`), ['api-key']);
    assert.deepEqual(kinds(`token ${OPENAI_STYLE}`), ['api-key']);
    assert.deepEqual(kinds(`meu cpf é ${CPF}`), ['cpf']);
    assert.deepEqual(kinds(`cnpj ${CNPJ}`), ['cnpj']);
    assert.deepEqual(kinds(`cartão ${CARD} validade`), ['credit-card']);
    assert.deepEqual(kinds(`Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123`), ['bearer-token']);
    assert.deepEqual(kinds(`aqui ${PRIV} fim`), ['private-key']);
    assert.deepEqual(kinds('a minha senha é Jacaranda2026'), ['spoken-password']);
    assert.deepEqual(kinds('a senha do wifi é azul-verde-77'), ['spoken-password']);
  });

  it('falsos positivos comuns de fala NÃO são marcados (matriz de controle negativo)', () => {
    const limpos = [
      'ligar para 11 98765-4321 amanhã',
      'o pedido 12345678 chega dia 15/10/2026',
      'preciso trocar a senha amanhã',
      'a senha é importante',
      'lembrete: pagar 1.234,56 reais',
      'o código 4111 não é um cartão',
      'minha idade é 41 anos e moro no 1203',
      'Bearer é uma palavra em inglês',
      'sk-curto',
      'AIza curto demais'
    ];
    for (const t of limpos) assert.deepEqual(kinds(t), [], `não deveria marcar: ${JSON.stringify(t)}`);
  });

  it('limite declarado: senha ditada só com letras minúsculas não é pega (preferimos não marcar fala comum)', () => {
    assert.deepEqual(kinds('a senha é jacaranda'), []);
  });

  it('CPF e cartão inválidos (dígito verificador errado) NÃO são marcados', () => {
    assert.deepEqual(kinds('cpf 529.982.247-26'), []);
    assert.deepEqual(kinds('cartão 4111 1111 1111 1112'), []);
  });

  it('CNPJ não vira também CPF (sem dupla marcação)', () => {
    assert.deepEqual(kinds(`cnpj ${CNPJ}`), ['cnpj']);
  });
});

describe('outboundGuard: modos', () => {
  beforeEach(() => resetOutboundCounts());
  const texto = `meu cpf é ${CPF} e a chave ${API_KEY}`;

  it('off: devolve idêntico e não conta nada', () => {
    const r = guardText(texto, 'off');
    assert.equal(r.text, texto);
    assert.equal(r.findings.length, 0);
    assert.deepEqual(getOutboundCounts(), {});
  });

  it('warn: devolve idêntico, mas conta os achados', () => {
    const r = guardText(texto, 'warn');
    assert.equal(r.text, texto);
    assert.equal(r.blocked, false);
    assert.deepEqual(getOutboundCounts(), { cpf: 1, 'api-key': 1 });
  });

  it('redact: troca cada achado pelo marcador do TIPO e preserva o resto do texto', () => {
    const r = guardText(texto, 'redact');
    assert.equal(r.text, `meu cpf é ${maskFor('cpf')} e a chave ${maskFor('api-key')}`);
    assert.equal(r.text.includes(CPF), false);
    assert.equal(r.text.includes(API_KEY), false);
  });

  it('redact de senha ditada e Bearer mascara só o valor, mantendo a frase', () => {
    assert.equal(guardText('a minha senha é Jacaranda2026 ok', 'redact').text, `a minha senha é ${maskFor('spoken-password')} ok`);
    assert.equal(
      guardText('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123', 'redact').text,
      `Authorization: Bearer ${maskFor('bearer-token')}`
    );
  });

  it('block: marca como bloqueado e devolve os achados', () => {
    const r = guardText(texto, 'block');
    assert.equal(r.blocked, true);
    assert.equal(r.findings.length, 2);
  });

  it('texto sem segredo passa idêntico em todos os modos, sem contadores', () => {
    for (const mode of ['off', 'warn', 'redact', 'block'] as const) {
      const r = guardText('oi, tudo bem? marque dentista dia 20', mode);
      assert.equal(r.text, 'oi, tudo bem? marque dentista dia 20');
      assert.equal(r.blocked, false);
    }
    assert.deepEqual(getOutboundCounts(), {});
  });

  it('os contadores guardam só TIPO e quantidade, nunca o conteúdo', () => {
    guardText(texto, 'redact');
    guardText(`outro ${CPF}`, 'warn');
    const c = getOutboundCounts();
    assert.deepEqual(c, { cpf: 2, 'api-key': 1 });
    const blob = JSON.stringify(c);
    for (const secret of [CPF, API_KEY, '529982247']) assert.equal(blob.includes(secret), false);
  });

  it('isOutboundGuardMode aceita exatamente os quatro modos', () => {
    for (const m of ['off', 'warn', 'redact', 'block']) assert.equal(isOutboundGuardMode(m), true);
    for (const m of ['', 'REDACT', 'on', 'true', '1', 'redact ']) assert.equal(isOutboundGuardMode(m), false);
  });
});

describe('outboundGuard: guardMessages (prompt de geração)', () => {
  beforeEach(() => resetOutboundCounts());
  const msgs = [
    { role: 'system', content: `memória: a chave do serviço é ${API_KEY}` },
    { role: 'user', content: `meu cpf ${CPF}` },
    { role: 'assistant', content: 'anotado' }
  ];

  it('redact: nenhum segredo sobra em nenhuma mensagem e as originais não são alteradas', () => {
    const out = guardMessages(msgs, 'redact');
    const blob = JSON.stringify(out);
    assert.equal(blob.includes(API_KEY), false);
    assert.equal(blob.includes(CPF), false);
    assert.equal(out[2].content, 'anotado');
    assert.ok(msgs[0].content.includes(API_KEY), 'a entrada original permanece intacta');
  });

  it('controle positivo: com o guarda em off o segredo SAI (o teste enxerga a diferença)', () => {
    const out = guardMessages(msgs, 'off');
    assert.ok(JSON.stringify(out).includes(API_KEY));
    assert.ok(JSON.stringify(out).includes(CPF));
  });

  it('block: lança OutboundBlockedError citando só os TIPOS', () => {
    assert.throws(
      () => guardMessages(msgs, 'block'),
      (e: unknown) => {
        assert.ok(e instanceof OutboundBlockedError);
        assert.deepEqual([...e.kinds].sort(), ['api-key', 'cpf']);
        assert.equal(e.message.includes(API_KEY), false);
        assert.equal(e.message.includes(CPF), false);
        return true;
      }
    );
  });

  it('block sem achado não lança', () => {
    assert.doesNotThrow(() => guardMessages([{ role: 'user', content: 'oi' }], 'block'));
  });
});

describe('cartão de privacidade mostra o modo do guarda (T1)', () => {
  const card = (mode: string) => describePrivacy(effectivePrivacy({ GEMINI_API_KEY: 'x', RODRIGO_OUTBOUND_GUARD: mode }));
  const text = (mode: string) => {
    const c = card(mode);
    return [...c.goes, ...c.warnings].join('\n');
  };
  it('redact e block descrevem o que fazem e declaram que imagem não é varrida; warn e off viram AVISO', () => {
    assert.match(text('redact'), /troca cada achado por um aviso/);
    assert.match(text('redact'), /Imagens não são varridas/);
    assert.match(text('block'), /não envia nada ao Gemini/);
    assert.match(text('warn'), /só avisando/);
    assert.match(text('off'), /desligado/);
    assert.ok(card('warn').warnings.some((w) => /só avisando/.test(w)));
    assert.ok(card('off').warnings.some((w) => /desligado/.test(w)));
  });
  it('modo sem nuvem não fala do guarda (nada sai)', () => {
    const c = describePrivacy(effectivePrivacy({ RODRIGO_CLOUD: '0' }));
    assert.equal([...c.goes, ...c.warnings, ...c.stays].some((l) => /guarda de saída|RODRIGO_OUTBOUND_GUARD/.test(l)), false);
  });
});
