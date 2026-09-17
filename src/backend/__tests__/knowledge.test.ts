import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  chunkMarkdown,
  KnowledgeRetriever,
  normalize,
  buildKnowledgeBlock,
  KNOWLEDGE_PREAMBLE,
  ALIAS_FAMILIES_FOR_TEST
} from '../knowledge/index.js';
import { KNOWLEDGE_LIMITS } from '../../shared/voiceProtocol.js';

/**
 * Corpus sintético. Os testes NUNCA dependem de docs/research/, que o usuário edita à mão —
 * uma revisão do material dele não pode quebrar a suíte.
 */
const FIXTURE = `# Título nível 1 ignorado

## 1. Alfa

Parágrafo de alfa com conteúdo suficiente para passar do mínimo de caracteres exigido pelo
chunker, falando de gravitação e de órbitas planetárias em detalhe razoável.

### 1.1 Alfa interno

Subseção de alfa, com texto próprio longo o bastante para virar um trecho de verdade e não
ser descartada pelo limite mínimo de tamanho estabelecido.

## 2. Beta ##

Beta trata de fotossíntese e de cloroplastos, com corpo suficientemente extenso para que o
segmentador o converta num trecho válido sem qualquer dificuldade aparente.
`;

describe('Conhecimento (Fase 5a) — segmentação', () => {
  it('compõe headingPath de H3 com o H2 corrente e aceita cabeçalho atx fechado', () => {
    const chunks = chunkMarkdown('t', FIXTURE);
    const paths = chunks.map((c) => c.headingPath);
    assert.ok(paths.includes('1. Alfa'), 'H2 simples');
    assert.ok(paths.includes('1. Alfa > 1.1 Alfa interno'), 'H3 composto com o H2 corrente');
    assert.ok(paths.includes('2. Beta'), 'atx fechado não deixa # residual no headingPath');
  });

  it('trata CRLF exatamente como LF', () => {
    const lf = chunkMarkdown('t', FIXTURE);
    const crlf = chunkMarkdown('t', FIXTURE.replace(/\n/g, '\r\n'));
    assert.deepEqual(crlf, lf);
  });

  it('descarta cabeçalho-pai sem corpo próprio', () => {
    const chunks = chunkMarkdown('t', '## Pai\n\n### Filho\n\n' + 'x'.repeat(200) + '\n');
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].headingPath, 'Pai > Filho');
  });

  // --- PROPRIEDADES, não exemplos. As duas falharam em versões anteriores do plano com
  // --- entradas que os exemplos escolhidos à mão não cobriam.
  it('PROPRIEDADE: nenhum trecho excede MAX_CHUNK_CHARS, em entrada aleatória', () => {
    let seed = 12345;
    let grandes = 0; // guarda anti-vacuidade: o teste precisa PROVAR que exercitou o caso difícil
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let i = 0; i < 500; i += 1) {
      const paras: string[] = [];
      for (let p = 0; p <= rnd(5); p += 1) {
        const size = [10, 50, 200, 900, 1199, 1200, 1201, 2500, 4000][rnd(9)];
        // O gerador anterior juntava frases de até 300 chars e cortava em `size`; o join
        // quase nunca alcançava `size`, então NENHUM parágrafo passava de 1200 e o caminho
        // de hardSplit nunca era exercitado — a propriedade passava por vacuidade (achado
        // ALTA da auditoria de código, 2026-09-17). Agora o parágrafo tem `size` de verdade:
        // metade das vezes com pontuação (exercita a divisão por frase), metade sem
        // (força a fatia dura).
        let para = '';
        if (rnd(2) === 0) {
          const sentences: string[] = [];
          while (para.length < size) {
            sentences.push('x'.repeat(1 + rnd(300)));
            para = sentences.join('. ');
          }
          para = para.slice(0, size);
        } else {
          para = 'x'.repeat(size);
        }
        paras.push(para);
      }
      if (paras.some((p) => p.length > KNOWLEDGE_LIMITS.MAX_CHUNK_CHARS)) grandes += 1;
      const md = `## Seção\n\n${paras.join('\n\n')}\n`;
      for (const chunk of chunkMarkdown('t', md)) {
        assert.ok(
          chunk.body.length <= KNOWLEDGE_LIMITS.MAX_CHUNK_CHARS,
          `trecho de ${chunk.body.length} chars excede o teto de ${KNOWLEDGE_LIMITS.MAX_CHUNK_CHARS} (iteração ${i})`
        );
      }
    }
    // Sem isto, a propriedade acima passa mesmo que o gerador nunca produza o caso que
    // hardSplit existe para tratar — que foi exatamente o defeito encontrado.
    assert.ok(
      grandes >= 20,
      `o gerador produziu apenas ${grandes} iterações com parágrafo acima do teto — teste vácuo`
    );
  });

  it('PROPRIEDADE: não perde conteúdo — parágrafo curto no fim vira trecho em vez de sumir', () => {
    const body = `${'A'.repeat(1190)}\n\n${'B'.repeat(40)}`;
    const chunks = chunkMarkdown('t', `## S\n\n${body}\n`);
    const joined = chunks.map((c) => c.body).join('');
    assert.ok(joined.includes('A'.repeat(1190)), 'o parágrafo grande foi preservado');
    // A sobra de 40 chars não cabe no anterior (1190 + 2 + 40 > 1200) e fica abaixo de
    // MIN_CHUNK_CHARS. A versão anterior deste teste asseria só o parágrafo grande, e por isso
    // passava enquanto o código PERDIA a sobra (achado ALTA da auditoria de código).
    assert.ok(
      joined.includes('B'.repeat(40)),
      'a sobra curta tem de sobreviver — preservar conteúdo vale mais que o tamanho mínimo'
    );
    for (const c of chunks) {
      assert.ok(c.body.length <= KNOWLEDGE_LIMITS.MAX_CHUNK_CHARS);
    }
  });

  it('fatia parágrafo único gigante sem estourar o teto', () => {
    const chunks = chunkMarkdown('t', `## S\n\n${'Y'.repeat(3000)}\n`);
    assert.ok(chunks.length >= 3, 'um parágrafo de 3000 chars precisa virar vários trechos');
    for (const c of chunks) assert.ok(c.body.length <= KNOWLEDGE_LIMITS.MAX_CHUNK_CHARS);
  });

  it('texto precedendo uma fatia dura não é concatenado nela (estouro real da 5ª auditoria)', () => {
    const chunks = chunkMarkdown('t', `## S\n\nFrase curta. ${'Y'.repeat(2500)}\n`);
    for (const c of chunks) {
      assert.ok(
        c.body.length <= KNOWLEDGE_LIMITS.MAX_CHUNK_CHARS,
        `trecho de ${c.body.length} chars — a concatenação com a fatia voltou`
      );
    }
  });
});

describe('Conhecimento (Fase 5a) — normalização', () => {
  it('remove acento, pontuação, stopword e termo curto', () => {
    assert.deepEqual(normalize('Explique a Aceitação dentro da Virtologia'), [
      'aceitacao',
      'virtologia'
    ]);
  });

  it('remove as stopwords conversacionais que a 5ª auditoria apontou', () => {
    for (const w of ['voce', 'meu', 'minha', 'dar', 'sem', 'seja']) {
      assert.deepEqual(normalize(w), [], `"${w}" deveria ser stopword`);
    }
  });

  it('EXAUSTIVO: toda variante da tabela de apelidos normaliza para a canônica', () => {
    for (const [canonical, variants] of ALIAS_FAMILIES_FOR_TEST) {
      for (const v of variants) {
        assert.deepEqual(
          normalize(v),
          [canonical],
          `apelido "${v}" deveria normalizar para "${canonical}"`
        );
      }
    }
  });
});

describe('Conhecimento (Fase 5a) — recuperação', () => {
  const chunks = chunkMarkdown('t', FIXTURE);
  const retriever = new KnowledgeRetriever(chunks);

  it('recupera o trecho cujo cabeçalho e corpo casam a consulta', () => {
    const got = retriever.retrieve('t', 'fotossíntese e cloroplastos');
    assert.equal(got.length, 1, 'MAX_CHUNKS é 1');
    assert.equal(got[0].headingPath, '2. Beta');
  });

  it('devolve vazio quando nenhum termo casa', () => {
    assert.deepEqual(retriever.retrieve('t', 'receita de bolo de cenoura'), []);
  });

  it('devolve vazio para agente sem corpus', () => {
    assert.deepEqual(retriever.retrieve('inexistente', 'gravitação'), []);
  });

  it('é determinístico: a mesma consulta duas vezes devolve a mesma ordem', () => {
    const a = retriever.retrieve('t', 'gravitação órbitas');
    const b = retriever.retrieve('t', 'gravitação órbitas');
    assert.deepEqual(a.map((c) => c.headingPath), b.map((c) => c.headingPath));
  });

  it('desempata por headingPath quando os scores são iguais', () => {
    const twin = [
      { agentId: 'z', headingPath: 'B seção', body: `zeta ${'w'.repeat(200)}` },
      { agentId: 'z', headingPath: 'A seção', body: `zeta ${'w'.repeat(200)}` }
    ];
    const r = new KnowledgeRetriever(twin);
    assert.equal(r.retrieve('z', 'zeta')[0].headingPath, 'A seção');
  });
});

describe('Conhecimento (Fase 5a) — bloco injetado', () => {
  it('bloco vazio quando não há trecho', () => {
    assert.equal(buildKnowledgeBlock([]), '');
  });

  it('bloco contém preâmbulo, cabeçalho e corpo', () => {
    const block = buildKnowledgeBlock([{ headingPath: 'H', body: 'CORPO', score: 1 }]);
    assert.ok(block.startsWith(KNOWLEDGE_PREAMBLE));
    assert.ok(block.includes('[H]'));
    assert.ok(block.includes('CORPO'));
  });

  it('o preâmbulo neutraliza instrução operacional vinda do corpus', () => {
    assert.match(KNOWLEDGE_PREAMBLE, /nunca instrução/);
    assert.match(KNOWLEDGE_PREAMBLE, /não substitui as regras de voz/);
  });
});
