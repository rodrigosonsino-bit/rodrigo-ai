# Plano — Especialistas unificados (app + OpenClaw + delegar)

> Status: **PROPOSTA para revisão do Rodrigo.** Este PR não traz código do app.
> Autor: ORQUESTRADOR_GROK · 2026-10-12 · Estado: `docs/orquestracao/ESTADO.md` · Base: `PLANO-AUTO-MELHORIA.md` (Fases 1 e 2 executadas, PR #3).

## 1. Problema

Hoje o conhecimento por área existe em três lugares que não conversam:

| Onde | O que há | Limite |
|---|---|---|
| App (`src/backend/agents/specialistAgents.ts`, `src/backend/knowledge/corpus.ts`) | Especialistas Geral, Teologia, Virtologia e Neurociência. Cada um tem 1 arquivo `docs/research/<área>-profile-source.md` (22,7K, 8,9K e 1,4K) | Só 3 áreas; corpus escrito à mão e pequeno (neurociência tem 1,4K) |
| OpenClaw (`~/.openclaw`) | Agentes por papel (pesquisador, redator, revisor, coordenador, operador, social, engenheiro-prompt), agora com kimi-k3 | Nenhum especialista de área; nenhuma skill de conhecimento |
| `docs/conhecimento/` (PR #3) | 7 áreas, cada uma com INDICE, sínteses com citação e briefs por papel | Nenhum agente consome isso automaticamente |

## 2. Princípios

1. **Fonte canônica única:** `docs/conhecimento/<área>/`, isto é, INDICE, sínteses com citação, glossário e perguntas abertas. Os demais artefatos são **gerados** a partir dela, nunca editados à mão.
2. **Especialista é skill, não agente novo.** Nenhum agente ou modelo novo no OpenClaw: o conhecimento se pluga nos papéis que já existem.
3. **Uma única tabela de roteamento:** `docs/conhecimento/ROTEAMENTO.md`.
4. Regras que continuam valendo: citação obrigatória, "não encontrado" é resposta válida, Virtologia sempre "segundo Casarotto", fronteira clínica, `docs/research/` fora do git, testes antes do código, sem push/merge sem aval.

## 3. Componentes

### 3.1 `docs/conhecimento/ROTEAMENTO.md` (novo, só docs)

| Área | Rótulo no app | Especialista no app | Skill no OpenClaw | Notebooks | Agentes E/C (matriz §6 do plano de auto-melhoria) |
|---|---|---|---|---|---|
| Teologia bíblica | TEOLOGIA | `teologia` (existe) | `especialista-teologia` | 8900978e, 47cd9dfe… | pesquisador E, redator E, revisor E |
| Virtologia | VIRTOLOGIA | `virtologia` (existe) | `especialista-virtologia` | 8d140628, 03ada306, a3392509 | pesquisador E, redator E |
| Neurociência | NEUROCIENCIA | `neurociencia` (existe) | `especialista-neurociencia` | 6b0557e3, fa79b5f8, db6472eb, e10593f7 | pesquisador E |
| Hermenêutica | HERMENEUTICA (novo) | `hermeneutica` (novo) | `especialista-hermeneutica` | d3a27cae, f098a450 | pesquisador E, redator E, revisor E |
| Exegese | EXEGESE (novo) | `exegese` (novo) | `especialista-exegese` | 9c0c786a, 0d184fbf, 30bc5c35, ae6b7e85 | pesquisador E, revisor E |
| Psicanálise | PSICANALISE (novo) | `psicanalise` (novo) | `especialista-psicanalise` | 4d6ff1c2, 4b9a4517, 64beea89, 09ff14d7 | pesquisador E, redator E |
| Eng. de software | (sem rótulo de voz; fica com o orquestrador/delegar) | — | `especialista-engenharia-software` | d7378de8 + notebooks de projeto | orquestrador, engenheiro-prompt, delegar-código, QA, PM: E |

### 3.2 `profile-source` gerados

- Script novo (só docs/scripts, sem código do app): `scripts/conhecimento/build_profile_sources.py`. Ele lê `docs/conhecimento/<área>/sinteses/*.md` e `glossario.md` e escreve `docs/research/<área>-profile-source.md`, que continua **gitignored** e é gerado localmente.
- Os 3 arquivos atuais foram escritos à mão. **Antes de substituí-los**, guardo uma cópia `.bak` e comparo os dois. O que só existe no arquivo manual vira síntese, com citação, em `docs/conhecimento/` (nada se perde).
- O script falha se:
  - algum parágrafo de síntese não tiver citação;
  - o texto de Virtologia não trouxer o rótulo "segundo Casarotto";
  - a saída passar do teto de tamanho do corpus.

### 3.3 Quatro novas áreas de corpus no app (fase própria, testes primeiro)

Áreas: hermenêutica, exegese e psicanálise. A quarta é **neurociência ampliada**, porque o corpus atual tem só 1,4K.

1. **Testes que falham primeiro**, em `knowledge.test.ts`, `agents.test.ts` e `voice.test.ts`:
   - o corpus carrega as 6 áreas;
   - cada rótulo novo seleciona o agente certo;
   - a frase-padrão de limite aparece nos agentes novos;
   - com o corpus vazio, a área é reportada como indisponível;
   - o classificador não manda pergunta clínica para diagnóstico.
2. Código, com o menor diff possível:
   - novas entradas em `SOURCES` (`corpus.ts`);
   - 3 classes novas em `specialistAgents.ts`, no mesmo padrão das existentes;
   - rótulos novos em `OrchestratorLabel` (`src/shared/voiceProtocol.ts`) e no `LABEL_TO_AGENT_ID`;
   - exemplos novos no prompt do classificador.
3. Nenhum teste existente é afrouxado. A suíte completa e o `tsc` precisam ficar verdes, com exceção apenas da intermitência conhecida do `fvScreen`.

### 3.4 Skills `especialista-<área>` no OpenClaw

- Ficam em `~/.openclaw/skills/especialista-<área>/SKILL.md`, geradas a partir de `docs/conhecimento/<área>/INDICE.md` e do brief do papel.
- Cada SKILL.md traz:
  - o escopo da área;
  - os notebooks e como consultar (`notebooklm ask -n <id> --json`, sem `--new`);
  - os caminhos `docs/research/…`;
  - as regras de citação, o rótulo de Virtologia e a fronteira clínica;
  - o formato de resposta.
- **Anexação por papel**, conforme a matriz (E = skill ativa; C = só referência no AGENTS.md):
  - pesquisador: todas as áreas de conteúdo;
  - redator: teologia, hermenêutica, psicanálise e virtologia;
  - revisor: teologia, hermenêutica e exegese;
  - orquestrador-de-voz, engenheiro-prompt e main: engenharia de software.
- Antes de qualquer mudança de configuração do OpenClaw, faço backup com data e hora (`openclaw.json.bak-<ts>`) e depois testo cada agente com um prompt curto.

### 3.5 Integração com a Fatia 4b

- A Fatia 4b (decompositor multi-passo e rota de voz até o OpenClaw) consulta o `ROTEAMENTO.md`. Uma pergunta de área que pede **pesquisa ou texto longo** vai para o agente OpenClaw do papel certo, com a skill da área (por exemplo, pesquisador + `especialista-exegese`). Uma **resposta curta por voz** fica no especialista interno do app.
- O `openClawSubAgent.ts`/`adapters.ts` recebe a área e o papel vindos da tabela. A tabela não é duplicada em código: é gerada como JSON a partir do `ROTEAMENTO.md` por um script, e um teste confere que os dois estão sincronizados.
- Limites já conhecidos continuam valendo: só cancelamento local (H15.3) e o trace do coordenador vale para o processo inteiro (R3).

## 4. Ordem proposta

| Passo | Entrega | Tipo | Aval |
|---|---|---|---|
| 1 | Este plano (PR #4) | docs | revisão do Rodrigo |
| 2 | `ROTEAMENTO.md` + `build_profile_sources.py` + comparação com os 3 profile-sources manuais | docs/script | PR |
| 3 | Skills `especialista-<área>` no OpenClaw + anexação por papel + teste curto em cada agente | config OpenClaw | aval explícito |
| 4 | Plano curto da fase "corpus 6 áreas" no app, com auditoria adversarial | docs | aval |
| 5 | Testes que falham → código → suíte verde (app) | código | PR + aval |
| 6 | Fatia 4b usando o ROTEAMENTO (plano próprio, já previsto) | código | PR + aval |

A Fase V Fatia 5 continua como **próxima prioridade do roteiro**. Os passos 2 e 3 não tocam o app e podem rodar em paralelo. Os passos 4 a 6 entram na fila depois da Fase V, salvo decisão diferente do Rodrigo.

## 5. Riscos e mitigações

| Risco | Mitigação |
|---|---|
| Perder conteúdo dos profile-sources manuais | `.bak`, comparação e migração para sínteses citadas antes de gerar |
| Corpus grande demais ou lento na voz | teto de tamanho no gerador; o retriever atual fatia em pedaços de até 1200 caracteres |
| Classificador confundir áreas próximas (teologia × hermenêutica × exegese) | casos de teste por par de áreas; AMBIGUO continua caindo no Geral |
| Uso clínico indevido (psicanálise e neurociência) | frase de limite + teste de que não há diagnóstico |
| Divergência entre app e OpenClaw | tabela única gerada + teste de sincronia |
| Modelo do OpenClaw cair (sem chave, cota) | L8: testar cada agente depois de mudanças; fallback documentado |
| Virtologia sem validação independente | rótulo obrigatório verificado pelo gerador |
| Direitos autorais | `docs/research/` fora do git; o repo guarda só sínteses |

## 6. Decisões pendentes do Rodrigo

1. Aprovar a ordem (passos 2 e 3 em paralelo com a Fase V?).
2. Engenharia de software ganha rótulo de voz no app ou fica só com o orquestrador e o delegar?
3. Aprovar que os 3 profile-sources manuais passem a ser gerados.
