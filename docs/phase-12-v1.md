# Fase 12 — Privacidade condizente com a promessa — v1

Versão: v1
Data: 2026-10-06
Status: **Rascunho para auditoria de plano. Nada implementado.** Três decisões do usuário em aberto (§3).
Origem: `docs/prompt-proxima-sessao-2026-10-02.md` §7 (F12) e `docs/phase-11-addendum-cloud-intent.md` §5.1
("A UI/README ainda precisam dizer isso (F12)"). Ordem aprovada pelo usuário: F11 → F12 → …

## 0. Premissa e o que este plano NÃO faz

Objetivo (do roteiro): a UI e os docs dizem exatamente o que fica local e o que vai ao Gemini, com controle do que pode sair.

Não faz: trocar de provedor, adicionar fallback para outra nuvem, mudar o desenho de geração/intenção. Qualquer nova
saída de dado para a nuvem continua exigindo plano + aprovação (regra dura do projeto). Este plano só **reduz e
declara** o que já sai.

## 1. Levantamento — verificado nos arquivos em 2026-10-06 (comando/linha citados)

### 1.1 O que realmente vai ao Gemini hoje

| Chamada | O que sai | Onde |
|---|---|---|
| Geração (toda fala não resolvida por ferramenta local) | `system prompt` + **todo `session.history`** | `sessionManager.ts:612-615` (`messagesForEngine`), `worker.py:889` |
| …dentro do system prompt | **todas as memórias guardadas** (`buildMemoryBlock`) | `sessionManager.ts:594-608` |
| …dentro do system prompt | **trecho de `docs/research/`** recuperado por BM25 (≤1.200 caracteres) para TEOLOGIA/VIRTOLOGIA | `sessionManager.ts:567-583`, `buildKnowledgeBlock` |
| Intenção (falas que passam o filtro de mutação/hora) | só o texto da fala atual | `worker.py:216,748-766` |
| Áudio | **nada** — STT é local | confirmado: nenhum caminho de áudio chega ao cliente `genai` |

**Achado 1 (contradição documental, ALTA):** o `CLAUDE.md` e o adendo da F11 dizem que `docs/research/` "never go out".
Isso vale só para a chamada de **intenção**. Na **geração**, o trecho recuperado do perfil teológico/Virtologia do usuário
**entra no system prompt enviado ao Gemini** (Fase 5a). A promessa escrita é mais forte que o comportamento real. A F12
precisa ou mudar o comportamento ou mudar a promessa — decisão D1 (§3).

**Achado 2 (ALTA):** o bloco de memórias (Fase 7) vai inteiro a cada turno de geração, "SEMPRE, para todos os 4 rótulos"
(decisão do usuário §0.3 da F7, tomada antes de existir a fronteira de privacidade). O usuário nunca teve um controle
para isso — decisão D2.

### 1.2 O que a UI e o README dizem hoje (e estão errados)

- `src/frontend/index.html:40`: "Voz 100% local, sem envio de áudio para serviços externos." — a segunda metade é
  verdadeira (áudio não sai); a primeira ("100% local") não é, com geração externa ligada.
- `src/frontend/index.html:121`: "a conversa em si roda sempre offline." — **falso** desde a Fase 10a: sem internet não
  há resposta discursiva.
- `src/frontend/index.html:92` já admite o Gemini, mas só para a geração; não cita intenção em nuvem (F11), memórias,
  histórico nem o trecho de pesquisa.
- `README.md:39`/`:191`: dizem "classificação … 100% localmente" — desatualizado após o adendo da F11.
- `.env.example`: não documenta `RODRIGO_CLOUD_INTENT`.
- Não existe nenhuma tela/endpoint que mostre o **modo efetivo** (geração em nuvem ligada? intenção em nuvem? chave
  presente?) antes da conversa.

### 1.3 Áudio temporário (H12.4)

- `AudioStore.cleanupSession()` é chamado ao encerrar a sessão (`sessionManager.ts:218`).
- `AudioStore.cleanupAll()` **existe mas nunca é chamado** (verificado: só a definição aparece em `src/backend`).
  Logo, após uma queda (processo morto sem encerrar a sessão), os `.wav` de `.runtime/tmp/` ficam até alguém apagar à mão.
  **Achado 3 (MÉDIA):** o critério "após queda, a próxima inicialização limpa resíduos" não é atendido hoje.
- O TTS `say` grava um `.aiff` temporário em `os.tmpdir()` (`ttsProviders.ts:41`) apagado por `unlink` com `catch` vazio;
  queda no meio da síntese deixa resíduo fora de `.runtime/tmp/`, que o `cleanupAll` não alcançaria.

### 1.4 Logs

`console.log/error` em `sessionManager.ts` registram turno/ação/veredito/rótulo/`headingPath` do trecho recuperado, sem o
texto da fala (verificado nas linhas 347–652). `mlxWorkerEngine.ts:143` repassa **todo o stderr do worker** ao console:
precisa de auditoria de que o worker nunca imprime fala, nota ou chave (hoje há `log_diag(...)` com turnId/tempo; falta
um teste que garanta isso). Não conferi o `worker.py` inteiro — **suposição a verificar na implementação**.

### 1.5 Chave Gemini

`GEMINI_API_KEY` apareceu em transcript de sessão em 2026-09-29 (herdado do prompt de origem; **não** reverificado — não
vou abrir `.env`). A rotação é ação do usuário no Google AI Studio; o plano só fornece o procedimento e a verificação.

## 2. Desenho

### 2.1 Endpoint de modo efetivo — `GET /api/privacy`

Mesmas guardas de Host/Origin do resto da API (sem CORS). Resposta estrita, sem segredos:

```ts
interface PrivacyStatus {
  generation: 'gemini' | 'off';       // RODRIGO_CLOUD_GENERATION=0 => 'off'
  generationModel: string | null;     // 'gemini-flash-latest' ou null
  intent: 'gemini' | 'local';         // RODRIGO_CLOUD_INTENT=0 ou sem chave => 'local'
  intentModel: string | null;
  keyPresent: boolean;                // nunca o valor, nunca o tamanho
  sends: { history: boolean; memories: boolean; knowledgeSnippet: boolean; utteranceForIntent: boolean };
  neverSends: ['audio'];
}
```

`sends.*` é derivado das mesmas flags que a montagem do prompt usa (fonte única da verdade — não um texto paralelo que
possa divergir). `GET /api/privacy` é a única fonte da tela e do texto do README gerado/conferido por teste.

### 2.2 Controles novos (todos via env, padrão = comportamento atual para não quebrar o fluxo do usuário)

| Variável | Efeito | Padrão |
|---|---|---|
| `RODRIGO_CLOUD_GENERATION` | `0` ⇒ nenhuma geração em nuvem; falas que dependem de geração recebem resposta fixa e clara ("geração em nuvem desligada"); ferramentas locais seguem funcionando. **Sem fallback para outro provedor.** | `1` |
| `RODRIGO_SEND_MEMORIES` (D2) | `0` ⇒ `buildMemoryBlock` não entra no prompt enviado | a decidir (D2) |
| `RODRIGO_SEND_KNOWLEDGE` (D1) | `0` ⇒ `buildKnowledgeBlock` não entra no prompt enviado | a decidir (D1) |

Quando a geração está `off` e a pergunta exige geração, o turno diz isso por voz e por SSE (tipo `error`/mensagem
fixa), em vez de silêncio ou resposta inventada (H12.3).

### 2.3 UI e docs

- Card "Privacidade" na tela inicial, **antes de iniciar a conversa**, alimentado por `GET /api/privacy`: lista em
  linguagem simples o que fica local (áudio, transcrição, notas/lembretes/memórias armazenados, STT, TTS) e o que sai
  (texto das falas e do histórico recente para gerar a resposta; texto da fala atual para classificar intenção;
  memórias e trecho de pesquisa **conforme os controles**).
- Corrigir `index.html:40`, `:92`, `:121`, `README.md:7,16,39,191-197`, `.env.example` (documentar as 3 variáveis +
  `RODRIGO_CLOUD_INTENT`), e a restrição dura do `CLAUDE.md` (corrigir o "never go out" para a verdade por chamada).
- Teste de consistência: um teste falha se algum texto estático do front contiver "100% local"/"sempre offline" enquanto
  `generation === 'gemini'` (impede regressão da promessa).

### 2.4 Limpeza de resíduos (H12.4)

- Chamar `audioStore.cleanupAll()` na **inicialização** do `voiceRuntime` (antes de aceitar sessões) e no shutdown.
- Mover o `.aiff` temporário do `say` para dentro de `.runtime/tmp/` (alcançado por `cleanupAll`) ou varrer
  `os.tmpdir()` por `rodrigo-say-*` na inicialização.
- Teste: criar arquivos órfãos, subir o runtime, afirmar que somem; matar o processo no meio de um turno e reiniciar.

### 2.5 Instrumentação de rede para H12.2 (sem MITM)

O cliente `genai` do worker aceita `base_url` em `HttpOptions`. Adicionar `RODRIGO_GEMINI_BASE_URL`, **aceita só se o
host for loopback** (`127.0.0.1`/`localhost`/`[::1]`), usada apenas por testes: um servidor Gemini falso em loopback
grava cada requisição recebida e o teste procura os marcadores. Alternativa rejeitada: proxy MITM com certificado — frágil,
exige confiar em CA e mexe no sandbox.
Risco da própria variável: apontar a chave para um host controlado por atacante. Mitigação: loopback-only validado em
Python **e** em Node antes de spawnar o worker; qualquer outro host ⇒ ignora a variável e registra aviso (nunca usa).

### 2.6 Logs

Teste que roda uma sessão com marcadores sintéticos ("MARCADOR-FALA-123", "MARCADOR-NOTA-456", chave sintética) e afirma
que **nenhum** aparece em stdout/stderr do servidor e do worker nem em arquivos sob `.runtime/` além de `data/*.json`.

## 3. Decisões do usuário necessárias (não vou escolher sozinho)

**D1 — trecho de `docs/research/` na geração.** Hoje vai ao Gemini (Achado 1). Opções:
(a) manter e declarar na UI/README/CLAUDE.md; (b) **não enviar** por padrão (Teologia/Virtologia respondem sem o trecho,
perdendo parte do ganho da Fase 5a) com `RODRIGO_SEND_KNOWLEDGE=1` para ligar; (c) enviar só para o agente que o usuário
escolher. *Recomendação: (b) como padrão, porque é material pessoal que o usuário já tratou como "nunca vai a terceiros"
em todo o resto do projeto.* Custo: a qualidade das respostas de TEOLOGIA/VIRTOLOGIA pode cair; precisa ser medida, não
suposta.

**D2 — memórias no prompt enviado.** Hoje todas, sempre. Opções: (a) manter e declarar; (b) controle global
`RODRIGO_SEND_MEMORIES`; (c) marca "só local" por item (por voz). *Recomendação: (b) agora, (c) fica para a F14 (ciclo
completo de notas/memórias), porque exige mudar o esquema de armazenamento e a detecção de mutação.*

**D3 — modo "sem nuvem" (`RODRIGO_CLOUD_GENERATION=0`).** Confirmar que o comportamento desejado é: ferramentas locais
funcionam, o resto diz claramente que a geração está desligada, **sem** cair para o Qwen local para gerar resposta
(o roteiro diz "sem fallback para outro provedor"; o Qwen local já foi abandonado para geração na Fase 10a por qualidade).

## 4. Critérios de aceite (propostos — calibrar contra casos reais, não são resultados)

- **H12.1** Nenhuma tela ou doc afirma ausência de nuvem/custo com geração externa ligada; modo efetivo visível antes da
  conversa. Verificação: teste de consistência (§2.3) + inspeção da tela por mim e confirmação visual do usuário.
- **H12.2** 100 turnos com dados sintéticos identificáveis contra o Gemini falso em loopback: **zero áudio** e **zero
  conteúdo marcado como "só local"** nas requisições (inclui `history` e system prompt). Com `SEND_MEMORIES=0` e
  `SEND_KNOWLEDGE=0`, zero memória e zero trecho. Com ligados, o que sai é exatamente o declarado em `/api/privacy`.
- **H12.3** 50 tarefas locais (hora, data, lembrete, nota, memória) funcionam **com a rede bloqueada** e `GENERATION=0`;
  a fala que exige geração é dita como indisponível; nenhuma requisição a outro host. Verificação por teste de rede e por
  voz real (só o usuário mede a parte de voz; **não autocertifico**).
- **H12.4** Encerrar sessão limpa `.runtime/tmp/` da sessão; após kill -9 no meio de um turno, a inicialização seguinte
  deixa zero `.wav`/`.aiff` órfãos; teste de logs (§2.6) sem marcador.
- **H12.5 (rotação da chave)** Nova chave em uso; a chave antiga **recusada** pela API (chamada de 1 token com a antiga
  deve falhar). A verificação roda sem imprimir nenhuma das duas.

## 5. Plano de verificação e auditoria

1. Auditoria de plano **com atenção à nuvem**: Kimi K3 e agy (prompt enxuto, só este arquivo + trechos citados — o usuário
   pediu explicitamente para não mandar arquivos inteiros ao Codex). Registrar quem viu o quê.
2. Implementação por partes pequenas: (i) `/api/privacy` + flags, (ii) UI/docs, (iii) limpeza de resíduos, (iv) Gemini
   falso + testes H12.2, (v) teste de logs.
3. Teste de mutação das garantias novas: remover a checagem de loopback; remover o filtro de memória/trecho; trocar
   `cleanupAll` por no-op — cada uma deve derrubar pelo menos um teste (como foi feito na F11).
4. Auditoria de código: Hermes (enxuto) — ele só enxerga `~/hermes-workspace`; copiar **só o código**, nunca
   `docs/research/` (regra do `CLAUDE.md` global).
5. Medição real: H12.1/H12.3 por voz com o usuário.

## 6. Riscos

| Risco | Mitigação |
|---|---|
| `RODRIGO_GEMINI_BASE_URL` vira vetor de exfiltração da chave | loopback-only, validado em Node e Python, ignorada se inválida |
| Desligar trecho de pesquisa degrada Teologia/Virtologia | medir antes/depois com perguntas fixas; padrão decidido pelo usuário (D1) |
| Texto da UI diverge do comportamento | fonte única (`/api/privacy`) + teste de consistência |
| Limpar `os.tmpdir()` apagar arquivo de outro programa | só prefixo exato `rodrigo-say-<pid>-…` e só se o pid não existir mais |
| Marcador sintético vazar para o `data/` real | `RODRIGO_DATA_DIR` isolado nos testes (já existe, `voiceRuntime.ts:87`) |

## 7. Fora de escopo (registrado para não se perder)

Marca "só local" por item (F14); sumarização de histórico (não existe hoje — se a F13 introduzir resumos derivados, eles
entram sob o mesmo controle); busca na web da F15 (exige aprovação nominal própria); remoto git/backup (feito em 2026-10-06).
