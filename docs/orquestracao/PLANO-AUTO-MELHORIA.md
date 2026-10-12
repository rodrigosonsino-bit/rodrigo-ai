# Plano de Auto-Melhoria, Auto-Correção e Ensino de Agentes

> Status: **PROPOSTA para revisão do Rodrigo** — nada implementado ainda.
> Autor: ORQUESTRADOR_GROK · Data: 2026-10-12 · Fonte única de estado: `docs/orquestracao/ESTADO.md`.

## 1. Objetivo

Dar ao ORQUESTRADOR_GROK (e, em cascata, aos demais agentes) a capacidade de:

1. **Auto-corrigir**: transformar cada falha em lição registrada e regra aplicada.
2. **Auto-melhorar**: revisar periodicamente desempenho e atualizar skills/memória.
3. **Auto-ensinar** em áreas específicas, a partir de fontes confiáveis (notebooks do Rodrigo primeiro, depois repositórios acadêmicos reconhecidos).
4. **Ensinar outros agentes** (OpenClaw, modelos do `delegar`, bots QA/PM), respeitando o papel de cada um.

## 2. Regras invioláveis

- **Não fabricar**: toda afirmação de conteúdo de área precisa de citação verificável (notebook + fonte, ou DOI/URL/ISBN). Sem fonte → "não sei / não encontrado".
- **Prioridade de fontes**: (1) notebooks NotebookLM do Rodrigo → (2) markdowns locais exportados (`docs/research/`) → (3) repositórios acadêmicos revisados por pares → (4) web geral, só como pista, nunca como fonte final.
- **Fronteira clínica/pastoral**: conhecimento de psicanálise, neurociência e virtologia serve para estudo e apoio ao Rodrigo; nenhum agente faz diagnóstico ou conduta clínica por conta própria.
- Regras existentes continuam valendo: sem push/merge sem aprovação, nunca enfraquecer testes, planejar antes de codar, menor diff, nada financeiro, nunca imprimir chaves.
- `docs/research/` é **gitignored** (direitos autorais/volume): continua fora do git. Só resumos próprios com citação entram no repo.

## 3. Ciclo de auto-correção (por incidente)

```
incidente → registro → causa-raiz → lição → mudança (skill/memória/regra/teste) → verificação
```

- **Registro**: `docs/orquestracao/INCIDENTES.md` (data PT, agente, sintoma, impacto, causa-raiz, correção, link de commit).
- **Lição**: `docs/orquestracao/LICOES.md` — frase curta e acionável ("Sempre passar `--trust` ao Cursor CLI headless").
- **Mudança**: atualizar skill do agente, memória do orquestrador ou script (ex.: `delegar`), com backup antes.
- **Verificação**: reproduzir o cenário que falhou; só fechar quando passar.
- Exemplos já ocorridos que viram as primeiras lições: Cursor CLI sem `--trust`; cota Pro "Outros modelos" esgotada; `delegar` quebrado por edição externa com agentes indefinidos; `openclaw` antigo no PATH; sessão kimi saturada/degenerada; auth NotebookLM expirada (CSRF).

## 4. Auto-melhoria (revisão semanal)

Toda segunda-feira (proposta: 08:00 PT), o orquestrador:

1. Lê INCIDENTES/LICOES da semana, ESTADO.md e histórico do `delegar` (falhas, timeouts, fallback usado).
2. Mede: tarefas concluídas, retrabalho, falhas por agente/modelo, tempo médio.
3. Propõe até 3 melhorias (skills, filas do `delegar`, prompts) em PR de docs — **aprovação do Rodrigo antes de aplicar**.
4. Publica um resumo curto ao Rodrigo e atualiza a fonte 00/ESTADO no notebook do app.

## 5. Base de conhecimento por área

### 5.1 Estrutura

```
docs/conhecimento/
  <area>/
    INDICE.md          # notebooks, fontes locais, periódicos, lacunas
    sinteses/*.md      # resumos próprios, cada parágrafo com citação
    glossario.md
    perguntas-abertas.md
```

Formato de citação: `[NB:<id-curto> · <título da fonte>]` para notebooks; `[DOI:…]`, `[ISBN:…]` ou `[URL · acesso AAAA-MM-DD]` para externos.

### 5.2 Inventário atual (2026-10-12)

| Área | Notebooks do Rodrigo (id curto) | Markdown local em `rodrigo-ai/docs/research/` |
|---|---|---|
| Eng. de software (backend/frontend) | Rodrigo AI 803ea045; PsicoApp f96a5ea7; Projeto App Virtologia c7b355ab; FinApp 3c67426f; App de Sermões 79a6bb5d; Ditado Local d4c56d93; Baixar/Transcrever db03c1d4; WhatsApp Scheduler 5e97294f; App Temperamento 174a1682; ENGENHEIRO DE PROMPT c9a154fc | só Projeto App Virtologia (9 md, 172K). **Lacuna**: não há notebook de teoria de engenharia (só notebooks de projeto) |
| Teologia bíblica | TEOLOGIA DO NT 8900978e; ANTIGO TESTAMENTO 47cd9dfe; JESUS COMO O MESSIAS 1e67f622; TIAGO 1381c94b; CANTARES c0dcd1be; MASCULINIDADE BÍBLICA 1d90947f; Wright e Rutledge c2997708; MEU LIVRO O Evangelho Revelado 1cac19d0; Aconselhando biblicamente 5cf0aaed (viewer) | NT 186 md (204M); AT 259 md (226M) |
| Hermenêutica (histórico-gramatical) | HERMENÊUTICA d3a27cae; RTM_MÓDULO HERMENÊUTICA f098a450 | 11 md (7.4M); 14 md (160K) |
| Exegese bíblica | GRAMÁTICA GREGA 9c0c786a; GRAMÁTICA HEBRAICO 0d184fbf; Estudando GREGO-ERIKE 30bc5c35; DICIONÁRIOS e LÉXICOS ae6b7e85 | Dicionários 15 md (6.9M) |
| Psicanálise | Acervo Psicanálise (Freud, Winnicott, Klein, A. Freud, Lacan) 4d6ff1c2; LIVROS_FREUD, LACAN 4b9a4517; Psicoterapeuta R. Sonsino 5cddc991 / 082c057a (duplicados?) ; Psicopatologia 64beea89; TRANSTORNOS 09ff14d7 | Psicoterapeuta: pastas vazias (4K). **Lacuna**: acervo psicanalítico ainda não exportado |
| Virtologia (Eduardo Casarotto) | VIRTOLOGIA 8d140628; As 53 Necessidades Humanas na Virtuologia 03ada306; Biologia da Crença a3392509; Projeto App Virtologia c7b355ab | 177 md (16M); 53 Necessidades (32K); Biologia da Crença 9 md (368K) |
| Neurociência do comportamento e emoções | Neurociência 6b0557e3; Psiconeuroimunologia fa79b5f8; Psiconutrição db6472eb; Epigenética e10593f7 | 78 md (19M); 55 md (4.2M); 12 md (504K) |

### 5.3 Repositórios acadêmicos por área (etapa 3 de prioridade)

| Área | Fontes reconhecidas |
|---|---|
| Eng. de software | ACM Digital Library, IEEE Xplore, arXiv (cs.SE, cs.HC), USENIX, documentação oficial (MDN, W3C/WHATWG, RFCs IETF, OWASP) |
| Teologia bíblica | ATLA Religion Database, JSTOR (Religion), *Journal of Biblical Literature*, *New Testament Studies*, *Vetus Testamentum*, *Tyndale Bulletin*, *JETS*, SciELO (teologia: *Teologia em Revista*, *Horizonte*), Periódicos CAPES |
| Hermenêutica histórico-gramatical | ATLA, JSTOR, *JETS*, *Westminster Theological Journal*, *Bibliotheca Sacra*, *Trinity Journal*; obras de referência (Kaiser, Osborne, Klein/Blomberg/Hubbard, Fee/Stuart) via ISBN |
| Exegese bíblica | Textos críticos (NA28/UBS5, BHS/BHQ — Deutsche Bibelgesellschaft), léxicos BDAG, HALOT, BDB; ATLA; *Filologia Neotestamentaria*; STEPBible/Tyndale House |
| Psicanálise | PEP-Web, APA PsycInfo, SciELO/PePSIC (BVS-Psi), *International Journal of Psychoanalysis*, *JAPA*, *Revista Brasileira de Psicanálise*, Periódicos CAPES |
| Neurociência comportamento/emoções | PubMed/MEDLINE, PubMed Central, *Nature Neuroscience*, *Neuron*, *Trends in Cognitive Sciences*, *Emotion* (APA), *Biological Psychiatry*, SciELO, bioRxiv (pré-print, sinalizar como tal) |
| Virtologia | Ver 5.4 |

### 5.4 Nota sobre Virtologia

Verificado em 2026-10-12: Virtologia é uma abordagem terapêutica criada por Eduardo Casarotto (Instituto Virtudes), apresentada como linha derivada da psicanálise, baseada no desenvolvimento de 33 virtudes por neuroplasticidade. Fontes públicas encontradas: livros do autor (ex.: *Fundamentos da Virtologia*, 2ª ed., 2025, ISBN 978-65-01-31222-4; *Guia das Virtudes*, 2024), dois artigos do próprio autor no *Brazilian Journal of Health Review* (2025; DOI 10.34119/bjhrv8n3-231 e 10.34119/bjhrv8n2-404) e resumo no 7º CBP/CFP 2025, que afirma que dados empíricos ainda estão em coleta. **Não há literatura independente revisada por pares conhecida**. Regra: tratar como corpo doutrinário do autor (fonte primária = notebooks do Rodrigo + obras do autor), sempre rotulado "segundo Casarotto"; validação empírica buscada em neurociência/psicologia (PubMed, PsycInfo) e sinalizada separadamente.

## 6. Matriz de treino dos agentes (por papel)

Legenda: **E** = recebe conhecimento e skill da área · **C** = só consulta sob demanda · — = sem acesso.

| Agente | Eng. SW | Teologia | Hermen. | Exegese | Psicanálise | Virtologia | Neurociência |
|---|---|---|---|---|---|---|---|
| ORQUESTRADOR_GROK (coordena, ensina) | E | C | C | C | C | C | C |
| Claude Code Sonnet (fallback orquestrador) | E | C | C | C | C | C | C |
| Modelos do `delegar` (código) | E | — | — | — | — | — | — |
| Modelos do `delegar` (texto) | C | C | C | C | C | C | C |
| OpenClaw orquestrador-de-voz / coordenador | E | C | C | C | C | C | C |
| OpenClaw pesquisador | C | E | E | E | E | E | E |
| OpenClaw redator | — | E | E | C | E | E | C |
| OpenClaw revisor | C | E | E | E | C | C | C |
| OpenClaw engenheiro-prompt | E | C | C | C | C | C | C |
| OpenClaw operador / social | C | — | — | — | — | — | — |
| Bot QA | E (testes, critérios) | — | — | — | — | — | — |
| Bot PM | E (produto, arquitetura) | C | C | C | C | C | C |

"Treinar" = gerar para cada agente uma skill/brief curto (`docs/conhecimento/<area>/brief-<papel>.md`) com: conceitos-chave, regras de citação, limites do papel, onde consultar. Nada de fine-tuning de modelos.

## 7. Cadência proposta

| Rotina | Frequência | Saída |
|---|---|---|
| Registro de incidente | a cada falha | INCIDENTES.md + LICOES.md |
| Revisão de auto-melhoria | semanal (seg 08:00 PT) | PR de docs + resumo ao Rodrigo |
| Estudo de área (1 área por vez, rodízio) | 2×/semana | síntese com citações em `docs/conhecimento/<area>/` |
| Varredura acadêmica (novos artigos) | mensal | lista de candidatos para Rodrigo aprovar inclusão no notebook |
| Atualização dos briefs dos agentes | após cada síntese aprovada | briefs por papel + fonte no notebook do app |
| Re-export dos notebooks em markdown | mensal ou sob demanda | `docs/research/` (gitignored) |

Ordem sugerida das áreas (começa pelo que já tem acervo local): neurociência → virtologia → hermenêutica → teologia → exegese → psicanálise (exportar acervo antes) → eng. de software (criar notebook de teoria antes).

## 8. Riscos e mitigações

| Risco | Mitigação |
|---|---|
| Alucinação/citação inventada | citação obrigatória e verificável; revisor checa amostra; "não encontrado" é resposta válida |
| Viés de fonte única (ex.: virtologia) | rotular autoria; separar doutrina × evidência empírica |
| Direitos autorais (PDFs/livros) | `docs/research/` fora do git; repo guarda só sínteses próprias |
| Conteúdo clínico mal usado | fronteira clínica (seção 2); nada de diagnóstico autônomo |
| Auto-alteração descontrolada | mudanças em skills/filas só via PR aprovado; backup antes de editar scripts |
| Custo/cota (Cursor Pro, NotebookLM) | rodízio de áreas, modelos `auto`, limites por rotina |
| Auth NotebookLM expira | detectar "CSRF token not found" e pedir `notebooklm login --browser-cookies chrome` ao Rodrigo |
| Notebooks duplicados/sem título (5cddc991/082c057a; deb98c1c, d6421dc7, 91c4cf62) | Rodrigo decide se consolida |

## 9. Decisões pendentes do Rodrigo

1. Aprovar a matriz de treino (seção 6).
2. Aprovar cadência e ordem das áreas (seção 7).
3. Quais notebooks entram como fonte em cada área (ex.: livros pessoais, CURSOTERAPIA, Epigenética).
4. Criar notebook de teoria de engenharia de software? Exportar o acervo de psicanálise?
5. Os 3 notebooks sem título e os 2 "Psicoterapeuta" duplicados.
