# Fase 5b — Ferramentas de leitura (`ITool`) — v5 (híbrida, corrigida)

Versão: v5
Data: 2026-09-22
Base: commit `3ca9517`
Antecessores: v1 (REJEITADO, 24 achados), v2 (REJEITADO, ~12), v3 (REJEITADO, 8), v4 (REJEITADO, 9).

---

## 0. Protocolo de congelamento — por que este documento não contém a amostra de validação

Combinado com o usuário antes de escrever esta versão: a v5 é escrita e commitada **sem** ver as
15–20 frases de validação de H11. Só depois do commit o usuário envia essas frases, e H11 é medido
contra elas sem tocar mais no prompt. A ordem é o que torna a medição válida — ver §7, H11.

Isso também significa que **o prompt limpo abaixo não pode reaproveitar nenhuma frase de nenhuma
auditoria anterior**, incluindo as usadas pelo auditor da 4ª rodada em sua própria bateria de
verificação (`docs/audits/phase-5b-v4-agy-2026-09-21.log`, §1.2). Reusar essas frases como exemplo
não seria vazamento do critério formal de H11 (que usa a amostra do usuário), mas contaminaria
qualquer comparação futura contra esse log — então todos os exemplos deste documento são novos,
nunca vistos em nenhum log de auditoria deste projeto.

---

## 1. A quarta rejeição, e os nove achados que esta versão corrige

O auditor da 4ª rodada (`agy` / Gemini 3.8 Flash High) rodou o desenho da v4 de verdade — não só
leu — e encontrou 2 achados ALTA (bloqueantes) e 7 média/baixa. Tabela de rastreamento; cada linha
aponta para a seção desta versão que resolve o achado:

| # | Achado (log completo em `docs/audits/phase-5b-v4-agy-2026-09-21.log`) | Gravidade | Resolvido em |
|---|---|---|---|
| 1 | Timeout de `detect_tool` mata o worker com `SIGKILL`; o fallback declarado em §4.4 chama `classify()` logo depois, contra um processo morto/reiniciando | ALTA | §4.4, §6.4 |
| 2 | Vazamento de dados em H11 — 6 das 7 frases do auditor da 3ª rodada foram copiadas para dentro de `DETECT_TOOL_SYSTEM_PROMPT` como exemplos | ALTA | §0, §4.9, §7 (H11) |
| 3 | `event === 'error'` não limpa o timer de `detect_tool`; `VOICE_LIMITS` não tem constante para ele | MÉDIA | §4.8, §6.4 |
| 4 | `label: 'GERAL'` fixado por construção sobre conjunto aberto — sequestro semântico e o "recuo" declarado dobraria a latência com uma segunda chamada ao LLM | MÉDIA | §4.6 |
| 5 | Referência cruzada quebrada: §4.6 cita `H8`, mas `H8` é o teste de cancelamento — o teste do classificador é outro | BAIXA | §4.6, §7 |
| 6 | H5 afirma que o histórico fica inalterado, mas `session.history.push` do usuário já roda antes do desvio de ferramenta — só a resposta do assistente fica de fora | MÉDIA | §7 (H5) |
| 7 | §5 não dá ao `FakeVoiceEngine` o mecanismo de barreira (`*SettleDelayMs`/`*Gates`) necessário para implementar o teste de cancelamento de `detect_tool` | MÉDIA | §5, §6.8 |
| 8 | §5 promete alterar `package.json` para incluir os testes Python, sem especificar como, arriscando quebrar a invariante B2 (`npm test` independente de Python) | MÉDIA | §5, §7 (H2) |
| 9 | `HoraAtualTool.execute()` produz concordância errada ("São 1 horas e 0 minutos") | MÉDIA | §4.7, §6.5 |

Nenhuma decisão da v4 que **não** foi atacada por um achado foi alterada — §4.1 (filtro
permissivo), §4.2 (`detect_tool` no `pending` existente), §4.3 (falha de execução fechada) e §4.5
(reuso do encerramento) permanecem como estavam, com uma única adição trivial em §4.1 (abaixo).

### Adição fora dos nove achados, feita por precaução direta (não por achado formal)

A seção "VERIFICAÇÃO POR EXECUÇÃO" do mesmo log (não um `ACHADO` numerado, mas parte da evidência
que fundamentou o veredito) mostrou que `TIME_GATE` não reconhece "século" (`"Em que século
estamos?"` não disparou o filtro). É uma lacuna de regex trivial e sem custo — adicionada em §4.1.
As demais lacunas que a mesma seção expôs (frases sem nenhuma palavra temporal, como "Passou das
cinco?" ou "Quantas são?") **não** são corrigíveis por regex sem destruir o propósito do filtro
(bater indiscriminadamente em palavras como "são" tornaria o filtro inútil) — permanecem como
limitação estrutural já reconhecida na v4 §8.3, e é exatamente isso que H11 vai medir com dados
reais em vez de suposição.

---

## 2. Premissa medida

Inalterado da v4 — servidor real (MLX, `Qwen3-4B-Instruct-2507-4bit`), áudio sintetizado,
2026-09-21:

```
hora real do sistema: 10:54 de Monday, 21 de September de 2026
"Que horas são agora?"  -> GERAL -> "Agora são seis e meia."
"Que dia é hoje?"       -> GERAL -> "Hoje é quinta-feira, 21 de abril."
```

**Pronto** exige: as duas corretas com áudio real; cobertura medida contra amostra que eu não
escolhi (§7, H11); turno sem ferramenta byte a byte idêntico à Fase 5a; nenhum falso positivo;
latência dentro das metas; suíte sem regressão.

---

## 3. Escopo

**Dentro:** `ITool` com `execute()`; `HoraAtualTool` e `DataAtualTool`; filtro permissivo em Node;
comando `detect_tool` no worker; resposta determinística sintetizada direto; `registerTool()`.

**Fora:** ações que mutam estado (Fase 5c); ferramentas com argumento; alteração do classificador;
rede/nuvem/API paga; conversão de numeral para extenso na fala (ver §8).

---

## 4. Decisões

### 4.1 Filtro permissivo (Node, regex) — inalterado, mais "século"

Continua decidindo **só** se vale gastar uma inferência — não qual ferramenta, e não se a
ferramenta será usada.

```ts
const TIME_GATE =
  /\b(hora|horas|horario|hrs|dia|dias|data|hoje|agora|semana|mes|meses|ano|anos|manha|tarde|noite|amanha|ontem|minuto|minutos|relogio|calendario|quando|seculo|seculos)\b/;
```

Única mudança em relação à v4: `seculo|seculos` adicionado (achado de execução, §1, sem GRAVIDADE
formal, corrigido por ser trivial e sem custo de falso positivo adicional relevante).

### 4.2 `detect_tool` no `pending` existente, como terceiro `kind` — inalterado

`MlxWorkerEngine` já mantém um único `Map` de operações pendentes com discriminante
`kind: 'classify' | 'generate' | …`. A v5 espelha `classify` no mesmo `Map`, com `kind:
'detect_tool'` — ver §6.4 para o tratamento corrigido de timeout/erro/cancelamento (achados 1 e 3).

### 4.3 Falha de execução: fechada e determinística — inalterado

Detectada a ferramenta, se `execute()` lançar, a resposta **não volta ao modelo**. Frase fixa:

```
Não consegui consultar o relógio do sistema agora.
```

### 4.4 Falha da detecção: cai no caminho normal — **corrigido (Achado 1, ALTA)**

A v4 dizia que, se `detect_tool` falhar ou estourar timeout, o turno segue o caminho da Fase 5a
(chama `classify` normalmente). Isso é verdade **desde que o worker continue vivo** — e é aqui que
a v4 quebrava: seu timeout de `detect_tool` espelhava `classify()`/`generate()` linha a linha,
inclusive o `this.child?.kill('SIGKILL')` que essas duas operações executam ao estourar. Um
`SIGKILL` mata o processo Python; `classify()` não espera `waitUntilReady()` antes de escrever no
worker, então a chamada de fallback imediatamente seguinte falha com `VoiceEngineError('Worker de
voz não está disponível.')` — o turno inteiro cai com erro na interface, exatamente o oposto do
"honesto: cai no caminho normal" que a §4.4 prometia.

**A correção não é esperar o worker religar — é não matá-lo.** `detect_tool` é uma decisão
auxiliar e descartável, ao contrário de `classify`/`generate`, que são o próprio turno. O timeout
de `detectTool()` (§6.4) **rejeita a Promise pendente e não toca no processo filho**. Duas
consequências, ambas corretas:

- Se o worker só estava ocupado (não travado), a rejeição chega rápido, o `catch` do
  `sessionManager.ts` cai no `NENHUMA` e a próxima chamada — `classify()` — encontra um worker
  saudável, exatamente como a §4.4 sempre pretendeu.
- Se o worker está de fato travado (não só lento nesta troca em particular), o `classify()`
  seguinte vai, ele sim, estourar `CLASSIFY_TIMEOUT_MS` e disparar o kill-e-reinício catastrófico
  já auditado nas rodadas 1–3 — não há necessidade de duplicar esse mecanismo dentro de
  `detect_tool`; o mecanismo de `classify` já existe e já foi validado para esse papel.

**Análise honesta da frequência (mantida da v4):** se o worker cair por completo, o turno falha de
qualquer forma — o caso de "detecção falha mas o resto funciona" continua sendo o caso comum e
esperado, não uma exceção rara.

### 4.5 O caminho da ferramenta reusa o encerramento existente — inalterado

Idêntico à v4 (nenhum achado atacou esta seção):

- `turn_done` **e** `state: ouvindo` (`sessionManager.ts:323-326`), como o caminho normal.
- Histórico: a fala da ferramenta **não** é empurrada aqui. Entra por `markPlayed()`, quando o
  cliente confirma reprodução, mesma invariante da Fase 2 contra barge-in.

### 4.6 O turno de ferramenta ainda pula o classificador — **corrigido (Achados 4 e 5, MÉDIA/BAIXA)**

Duas correções na mesma seção, porque o achado 4 é uma consequência direta de uma frase mal escrita
na v4, e a correção do texto resolve as duas ao mesmo tempo.

**O que a v4 dizia, e por que o auditor leu "dobra a latência":** "H8 reexecuta o classificador
real sobre uma amostra de fraseados que chegam ao caminho de ferramenta; qualquer divergência
aciona o recuo (chamar `classify` e pular apenas a geração)." Isso é ambíguo o bastante para ler
como comportamento de **runtime** — "toda vez que o turno passa pelo caminho de ferramenta, chama
`classify` também, e se divergir, recua." Se fosse isso, o auditor está certo: dobraria o número de
inferências MLX por turno de ferramenta, matando a vantagem de latência que é a razão de existir do
caminho de ferramenta.

**Não é isso, e a v5 diz explicitamente o que é:** `label: 'GERAL'` é fixado por construção, **sem
exceção, e sem nenhuma chamada a `classify()` em tempo de execução no caminho de ferramenta.** Não
existe recuo em runtime — nunca existiu um mecanismo para decidir "isso divergiu, então vou fazer
diferente agora", porque não há como comparar contra um rótulo verdadeiro sem já ter chamado
`classify()`, e chamar `classify()` sempre é exatamente o custo que o achado 4 corretamente
rejeitou.

O que existe é um **teste de bancada, offline, que não roda a cada turno**: a ferramenta H15 (ver
§7) roda o classificador real contra uma lista curada de fraseados que plausivelmente chegam ao
caminho de ferramenta (inclusive casos adjacentes a domínio — perguntas teológicas/de Virtologia
que contêm vocabulário temporal, como o auditor apontou) e verifica se todos dariam `GERAL` de
qualquer forma. Divergência ali **não muda o comportamento do sistema em produção** — vira item de
ação para a próxima iteração do prompt de detecção ou do filtro, documentado como risco residual em
§8, não escondido atrás de uma promessa de recuo automático que nunca existiu de fato.

Correção da referência cruzada (achado 5): a citação em §4.6 da v4 dizia `H8` onde deveria dizer o
teste do classificador — nesta versão o teste correspondente é `H15` (ver tabela em §7), e a
citação está correta desde a origem.

### 4.7 `HoraAtualTool.execute()` — **corrigido (Achado 9, MÉDIA)**

A v4 produzia `"São 1 horas e 1 minutos."` para 01:01 e `"São 11 horas e 0 minutos."` para 11:00 —
concordância de número errada e minutos zerados soando artificiais. Correção: singular/plural em
"hora"/"minuto" e frase própria para minutos zerados ("em ponto"), sem entrar em conversão de
dígito para extenso (fora de escopo — ver §8).

```ts
export class HoraAtualTool implements ITool {
  readonly name = 'HORA';
  readonly description = 'Hora atual do relógio do sistema.';
  constructor(private readonly clock: Clock = systemClock) {}
  isAvailable(): boolean { return true; }

  execute(): string {
    const hhmm = new Intl.DateTimeFormat('pt-BR', {
      hour: '2-digit', minute: '2-digit', hour12: false
    }).format(this.clock());
    const [hStr, mStr] = hhmm.split(':');
    const h = Number(hStr);
    const m = Number(mStr);

    const verbo = h === 1 ? 'É' : 'São';
    const horaWord = h === 1 ? 'hora' : 'horas';
    const base = `${verbo} ${h} ${horaWord}`;

    if (m === 0) return `${base} em ponto.`;
    const minutoWord = m === 1 ? 'minuto' : 'minutos';
    return `${base} e ${m} ${minutoWord}.`;
  }
}
```

Casos verificados manualmente contra o achado 9:

| Entrada | v4 (errado) | v5 |
|---|---|---|
| 01:01 | "São 1 horas e 1 minutos." | "É 1 hora e 1 minuto." |
| 11:00 | "São 11 horas e 0 minutos." | "São 11 horas em ponto." |
| 12:00 | "São 12 horas e 0 minutos." | "São 12 horas em ponto." |
| 11:06 (referência da v4 §4.7, ainda válida) | "São 11 horas e 6 minutos." | "São 11 horas e 6 minutos." (inalterado) |

`DataAtualTool` não foi alvo de nenhum achado — inalterado.

### 4.8 `VOICE_LIMITS` e tratamento de `event === 'error'` — **corrigido (Achado 3, MÉDIA)**

`detect_tool` usa o mesmo formato de chamada que `classify` (`temp=0.0`, saída de uma palavra —
`max_tokens=6` contra `max_tokens=8` de `classify`, praticamente idêntico), então recebe o mesmo
timeout: `DETECT_TOOL_TIMEOUT_MS: 10_000` em `VOICE_LIMITS` (`src/shared/voiceProtocol.ts`), igual
a `CLASSIFY_TIMEOUT_MS`. Não há razão para um valor diferente quando o tamanho da tarefa é o mesmo.

O `if (event === 'error')` de `handleLine` (`mlxWorkerEngine.ts:204-209`) limpa o timer apenas para
`generate`/`classify` — omissão apontada pelo achado: um evento de erro do worker durante
`detect_tool` deixava o timer armado, e ele dispararia depois, tentando (na v4) matar um worker que
já tinha se recuperado. Com a correção do achado 1 (§4.4), esse timer não mata mais nada ao
disparar tarde — mas ainda seria um timer vazando à toa, e a correção continua sendo limpá-lo no
lugar certo. Ver §6.4 para o trecho completo.

### 4.9 `DETECT_TOOL_SYSTEM_PROMPT` — **reescrito do zero (Achado 2, ALTA)**

A v4 copiou sete frases da amostra adversarial que o auditor da 3ª rodada tinha escrito
especificamente para expor falso negativo (`docs/audits/phase-5b-v3-hermes-2026-09-21.log`) e as
colou dentro do próprio prompt de detecção — seis como exemplo few-shot explícito, mais uma
("Tá em que mês?") dissolvida na prosa descritiva. Isso não é "o modelo aprendeu a generalizar
fraseado coloquial" — é o prompt memorizando exatamente as frases que a bateria de teste ia cobrar
depois. `H11` mede contra uma amostra que agora inclui, por sete oitavos, dado de treino disfarçado
de dado de teste.

**Correção:** prompt inteiramente novo, com exemplos e descrições coloquiais nunca vistos em
nenhum log de auditoria deste projeto (nem os da v3, nem os que o próprio auditor da v4 escreveu em
sua verificação por execução, §1.1–1.2 do log — evitados por precaução, embora não sejam a amostra
formal de H11, para não contaminar comparações futuras contra esse log). A estrutura (uma palavra,
três categorias, exemplos positivos e negativos, negativos cobrindo fuso horário/passado-futuro/
duração/domínio) é a mesma da v4 — só o conteúdo específico muda.

```python
TOOL_NAMES = {"HORA", "DATA", "NENHUMA"}

DETECT_TOOL_SYSTEM_PROMPT = (
    "Você decide se a frase do usuário pede a HORA atual, a DATA de hoje, ou NENHUMA das duas. "
    "Responda com UMA ÚNICA PALAVRA, sem pontuação, sem explicação: HORA, DATA ou NENHUMA.\n"
    "HORA: o usuário quer saber que horas são agora, neste lugar. Vale para qualquer jeito de "
    "perguntar, inclusive coloquial: 'que horas vocês têm aí', 'alguém sabe as horas', "
    "'dá pra ver que horas são', 'tô sem relógio, que horas são', 'me diz as horas', "
    "'preciso saber a hora certa agora'.\n"
    "DATA: o usuário quer saber que dia é hoje, o dia da semana, o mês ou o ano atuais. Também "
    "vale coloquial: 'em que dia da semana estamos', 'qual a data de hoje', 'que dia do mês é "
    "hoje', 'estamos em que ano', 'me diz que dia é hoje', 'qual o dia certo hoje'.\n"
    "NENHUMA: todo o resto. Isso INCLUI perguntas sobre tempo que não são a hora ou a data de "
    "agora aqui: hora em outro fuso ou país, datas passadas ou futuras, quanto tempo falta para "
    "algo, duração, aniversário, feriado, horário de funcionamento, ou qualquer cálculo com datas "
    "— e também perguntas de outro assunto que apenas mencionam uma palavra de tempo de "
    "passagem.\n"
    "Exemplos:\n"
    "Que horas vocês têm aí? -> HORA\n"
    "Alguém sabe as horas? -> HORA\n"
    "Dá pra ver que horas são? -> HORA\n"
    "Tô sem relógio, que horas são? -> HORA\n"
    "Em que dia da semana estamos? -> DATA\n"
    "Qual a data de hoje? -> DATA\n"
    "Estamos em que mês mesmo? -> DATA\n"
    "Que horas são em Lisboa agora? -> NENHUMA\n"
    "Em que dia da semana caiu o Natal do ano passado? -> NENHUMA\n"
    "Quanto tempo dura uma consulta médica? -> NENHUMA\n"
    "A que horas abre a padaria? -> NENHUMA\n"
    "Fale sobre o significado da graça na vida cristã. -> NENHUMA\n"
)


def parse_tool_output(raw: str) -> str:
    """Função PURA — testada em scripts/worker/test_tool_parser.py.

    Formato inválido degrada para NENHUMA: não reconhecer intenção deve custar a ferramenta,
    nunca o turno (ao contrário do classificador, onde formato inválido é erro).
    """
    normalized = (raw or "").strip().upper().strip(".!? \n")
    return normalized if normalized in TOOL_NAMES else "NENHUMA"
```

Inalterado da v4: `parse_tool_output` é função pura, sem string literal do domínio do prompt —
nenhum achado a atacou, e ela não participa do vazamento (o vazamento estava só no conteúdo do
prompt, não na lógica de parsing).

---

## 5. Arquivos afetados

**Novos:** `src/backend/tools/systemTools.ts`, `src/backend/tools/index.ts`,
`src/backend/__tests__/tools.test.ts`, `scripts/worker/test_tool_parser.py` (standalone, mesmo
padrão de `scripts/worker/test_repetition_detector.py` — ver §7, H2; **não** entra em `package.json`).

**Modificados:**
- `src/shared/extensions/tools.ts` — `execute(): string`.
- `src/shared/extensions/registry.ts` — `registerTool()` idempotente por `name`; módulo `tools` com
  `available: this.tools.length > 0`.
- `src/shared/voiceProtocol.ts` — `TOOL_NAMES`, `ToolName`, `isToolName()`, **e
  `DETECT_TOOL_TIMEOUT_MS: 10_000` em `VOICE_LIMITS`** (achado 3 — ausente na v4).
- `scripts/worker/worker.py` — somente acréscimo: `TOOL_NAMES`, `DETECT_TOOL_SYSTEM_PROMPT` (§4.9,
  reescrito), `parse_tool_output()`, `handle_detect_tool()`, despacho. O classificador não é
  tocado.
- `src/backend/voice/engine.ts` — `detectTool()` na interface.
- `src/backend/voice/mlxWorkerEngine.ts` — `kind: 'detect_tool'` no `pending`; timeout **sem
  `SIGKILL`** (achado 1); `detect_tool` incluído na limpeza de timer em `event === 'error'` e em
  `failAllPending` (achado 3); rejeição em `cancel()`.
- `src/backend/voice/fakeEngine.ts` — `detectTool()` + `toolToReturn` + `detectToolCalls`, **e o
  mecanismo de barreira completo** (`detectToolSettleDelayMs`, `detectToolGates`,
  `releaseDetectToolGate`, `isDetectToolPending`), espelhando `classify` — ausente na v4 (achado 7).
- `src/backend/voice/sessionManager.ts` — filtro, chamada condicional, caminho determinístico
  (inalterado da v4; nenhum achado atacou o pseudocódigo de `runTurn`).
- `src/backend/voice/voiceRuntime.ts` — cria, registra **e passa** as ferramentas.
- `src/backend/__tests__/extensions.test.ts`, `voice.test.ts`.

**Explicitamente fora desta lista, ao contrário da v4:** `package.json`. A v4 prometia alterá-lo
sem dizer como; a v5 não o toca — ver §7, H2.

---

## 6. Pseudocódigo completo

Seções inalteradas da v4 (nenhum achado as atacou) não são repetidas aqui além do necessário para
contexto: `registry.ts` (§6.1 da v4), `voiceRuntime.ts` (§6.7 da v4) e o corpo de `sessionManager.ts`
em `runTurn` (§6.6 da v4, citado por referência). Todas as seções abaixo são as que mudaram.

### 6.1 `voiceProtocol.ts`

```ts
export const TOOL_NAMES = ['HORA', 'DATA', 'NENHUMA'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];
export function isToolName(v: unknown): v is ToolName {
  return typeof v === 'string' && (TOOL_NAMES as readonly string[]).includes(v);
}

export const VOICE_LIMITS = {
  // ... campos existentes inalterados ...
  CLASSIFY_TIMEOUT_MS: 10_000,
  DETECT_TOOL_TIMEOUT_MS: 10_000, // mesmo tamanho de tarefa que classify (§4.8) — achado 3
  // ... resto inalterado ...
} as const;
```

### 6.2 `worker.py` — ver §4.9 para `DETECT_TOOL_SYSTEM_PROMPT` e `parse_tool_output`

`handle_detect_tool()` espelha `handle_classify()` linha a linha (`scripts/worker/worker.py:252-312`),
trocando apenas o prompt, o rótulo de evento e o parsing final:

```python
def handle_detect_tool(self, msg: dict[str, Any]) -> None:
    req_id = msg["reqId"]
    turn_id = msg["turnId"]
    epoch = msg["epoch"]
    text = msg["text"]

    if not text or not text.strip():
        emit({"event": "tool_detection", "reqId": req_id, "turnId": turn_id, "tool": "NENHUMA"})
        return

    handle = GenerationHandle(turn_id=turn_id, epoch=epoch)
    with self._current_lock:
        self._current = handle

    try:
        messages = [
            {"role": "system", "content": DETECT_TOOL_SYSTEM_PROMPT},
            {"role": "user", "content": text},
        ]
        prompt = self._llm_tokenizer.apply_chat_template(
            messages, add_generation_prompt=True, tokenize=False
        )

        from mlx_lm.generate import stream_generate
        from mlx_lm.sample_utils import make_sampler

        sampler = make_sampler(temp=0.0)
        raw = ""
        for response in stream_generate(
            self._llm, self._llm_tokenizer, prompt, max_tokens=6, sampler=sampler
        ):
            if handle.cancel_event.is_set():
                log_diag(f"Detecção de ferramenta cancelada pelo worker (turnId={turn_id}).")
                return
            raw += response.text

        tool = parse_tool_output(raw)
        emit({"event": "tool_detection", "reqId": req_id, "turnId": turn_id, "tool": tool})
    except Exception as exc:  # noqa: BLE001
        log_diag(f"Erro na detecção de ferramenta: {exc}\n{traceback.format_exc()}")
        emit({"event": "error", "reqId": req_id, "turnId": turn_id, "message": "Falha ao detectar ferramenta."})
    finally:
        with self._current_lock:
            if self._current is handle:
                self._current = None
        if self._mx is not None:
            self._mx.clear_cache()
```

Diferença deliberada em relação a `handle_classify`: formato de saída inválido **não** emite
`error` — `parse_tool_output` já degrada para `NENHUMA` (§4.9), então a única forma de `error` aqui
é uma exceção real (worker/modelo indisponível), nunca "o modelo respondeu algo inesperado". Texto
vazio também devolve `NENHUMA` direto, sem chamar o modelo (mesma lógica do achado v2-1 que motivou
a checagem equivalente em `handle_classify`, mas sem custar `error` — aqui a ferramenta é opcional,
lá a classificação não é).

Despacho, nos dois pontos onde `classify` aparece hoje (`scripts/worker/worker.py:434` e o `elif`
de `cmd == "cancel"`/`"ping"` mais abaixo não precisa de entrada nova — cancelamento já é tratado
por `handle.cancel_event`, comum a todos os comandos):

```python
elif cmd == "detect_tool":
    self.handle_detect_tool(msg)
```

### 6.3 `systemTools.ts` — ver §4.1 (`TIME_GATE` com "século") e §4.7 (`HoraAtualTool` corrigido)

```ts
import type { ITool } from '../../shared/extensions/tools.js';

export type Clock = () => Date;
const systemClock: Clock = () => new Date();

export class HoraAtualTool implements ITool {
  // ... ver §4.7 para o corpo completo ...
}

export class DataAtualTool implements ITool {
  readonly name = 'DATA';
  readonly description = 'Data atual e dia da semana, do relógio do sistema.';
  constructor(private readonly clock: Clock = systemClock) {}
  isAvailable(): boolean { return true; }
  execute(): string {
    const data = new Intl.DateTimeFormat('pt-BR', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    }).format(this.clock());
    return `Hoje é ${data}.`;
  }
}

export function createSystemTools(clock: Clock = systemClock): ITool[] {
  return [new HoraAtualTool(clock), new DataAtualTool(clock)];
}

export function selectToolByName(name: string, tools: readonly ITool[]): ITool | null {
  if (name === 'NENHUMA') return null;
  return tools.find((t) => t.name === name && t.isAvailable()) ?? null;
}

/** Filtro permissivo (§4.1) — ver ali para a lista completa, com "seculo" adicionado. */
const TIME_GATE = /* ... ver §4.1 ... */;

export function mightBeTemporal(transcript: string): boolean {
  const n = transcript
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ');
  return TIME_GATE.test(n);
}

export const TOOL_FAILURE_TEXT = 'Não consegui consultar o relógio do sistema agora.';
```

### 6.4 `mlxWorkerEngine.ts` — timeout sem `SIGKILL`, erro e cancelamento corrigidos (achados 1 e 3)

```ts
interface PendingDetectTool {
  kind: 'detect_tool';
  turnId: string;
  resolve: (tool: ToolName) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
  spawnGeneration: number;
}

type Pending = PendingTranscribe | PendingGenerate | PendingClassify | PendingDetectTool;
```

`failAllPending()` — `detect_tool` entra na mesma cláusula de limpeza de timer que `generate`/
`classify` (achado 3 aplicado aqui também: um worker morrendo por completo precisa limpar o timer
de `detect_tool` como qualquer outro):

```ts
private failAllPending(err: Error): void {
  for (const [, pending] of this.pending) {
    if (pending.kind === 'generate' || pending.kind === 'classify' || pending.kind === 'detect_tool') {
      clearTimeout(pending.timeout);
    }
    pending.reject(err);
  }
  this.pending.clear();
}
```

`handleLine()` — novo ramo para `tool_detection`, e `event === 'error'` corrigido para incluir
`detect_tool` na limpeza de timer (achado 3):

```ts
if (event === 'tool_detection' && pending.kind === 'detect_tool') {
  this.pending.delete(reqId);
  clearTimeout(pending.timeout);
  pending.resolve(isToolName(msg.tool) ? (msg.tool as ToolName) : 'NENHUMA');
  return;
}

if (event === 'error') {
  this.pending.delete(reqId);
  if (pending.kind === 'generate' || pending.kind === 'classify' || pending.kind === 'detect_tool') {
    clearTimeout(pending.timeout);
  }
  pending.reject(new VoiceEngineError((msg.message as string) || 'Erro desconhecido no worker de voz.'));
  return;
}
```

`detectTool()` — espelha `classify()` (`mlxWorkerEngine.ts:254-283`) exceto no timeout, que
**rejeita sem matar o processo** (achado 1, ver §4.4 para o raciocínio completo):

```ts
async detectTool(turnId: string, epoch: number, text: string): Promise<ToolName> {
  const reqId = nextReqId();
  const spawnGeneration = this.spawnGeneration;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      this.pending.delete(reqId);
      reject(
        new VoiceEngineError(
          `Detecção de ferramenta do turno ${turnId} excedeu ${VOICE_LIMITS.DETECT_TOOL_TIMEOUT_MS}ms.`
        )
      );
      // Achado 1 (ALTA) da 4ª rodada: ao contrário de classify()/generate(), este timeout
      // NÃO mata o worker. detect_tool é uma decisão auxiliar e descartável — a §4.4 exige
      // que o worker continue utilizável imediatamente depois, para o classify() do caminho
      // normal rodar em seguida. Se o worker estiver de fato travado (não só lento nesta
      // troca), o classify() seguinte vai, ele sim, estourar CLASSIFY_TIMEOUT_MS e disparar
      // o kill-e-reinício catastrófico já auditado — duplicá-lo aqui derrubaria o próprio
      // fallback que esta função existe para viabilizar.
    }, VOICE_LIMITS.DETECT_TOOL_TIMEOUT_MS);

    this.pending.set(reqId, { kind: 'detect_tool', turnId, resolve, reject, timeout, spawnGeneration });

    try {
      this.writeCommand({ cmd: 'detect_tool', reqId, turnId, epoch, text });
    } catch (err) {
      clearTimeout(timeout);
      this.pending.delete(reqId);
      reject(err as Error);
    }
  });
}
```

`cancel(turnId)` — `detect_tool` entra na mesma cláusula de rejeição que `classify` (o chamador
está aguardando um valor para decidir o caminho do turno; diferente de `generate`, que é resolvido
sem erro porque o chamador já abandonou o turno):

```ts
if (pending.kind === 'classify' || pending.kind === 'detect_tool') {
  pending.reject(new VoiceEngineError(`Operação do turno ${turnId} cancelada.`));
} else {
  pending.resolve();
}
```

### 6.5 `HoraAtualTool.execute()` — ver §4.7 para o corpo completo e a tabela de casos

### 6.6 `sessionManager.ts` — inalterado da v4 §6.6

Nenhum achado atacou o pseudocódigo de `runTurn` em si (filtro → `detectTool` → `execute` →
encerramento idêntico ao caminho normal). Reproduzido por referência, não copiado de novo aqui.
Única correção é de enunciado de teste, não de código — ver §7, H5.

### 6.7 `voiceRuntime.ts` — inalterado da v4 §6.7

```ts
const tools = createSystemTools();
for (const tool of tools) ExtensionRegistry.getInstance().registerTool(tool);

const sessionManager = new SessionManager(
  engine, ttsProvider, audioStore, agents, retriever, tools
);
```

### 6.8 `fakeEngine.ts` — mecanismo de barreira para `detectTool` (achado 7, ausente na v4)

Espelha exatamente o mecanismo já existente para `classify` (`fakeEngine.ts:26-34, 49-79, 107-114`),
necessário para o teste H8 (cancelamento) provar limpeza real de timer/pending, não só que a
Promise eventualmente resolve:

```ts
interface DetectToolGate {
  resolve: () => void;
  timer: NodeJS.Timeout | null;
}

export class FakeVoiceEngine implements VoiceEngine {
  // ... campos existentes ...
  public detectToolCalls: Array<{ turnId: string; text: string }> = [];
  public toolToReturn: ToolName = 'NENHUMA';
  public detectToolSettleDelayMs = 0;
  private detectToolGates = new Map<string, DetectToolGate>();

  async detectTool(turnId: string, epoch: number, text: string): Promise<ToolName> {
    this.detectToolCalls.push({ turnId, text });

    await new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | null = null;
      if (this.detectToolSettleDelayMs > 0) {
        timer = setTimeout(resolve, this.detectToolSettleDelayMs);
      }
      this.detectToolGates.set(turnId, { resolve, timer });
      if (this.detectToolSettleDelayMs === 0) resolve();
    });

    this.detectToolGates.delete(turnId);
    if (this.cancelledSet.has(turnId)) {
      throw new Error(`Detecção de ferramenta do turno ${turnId} cancelada.`);
    }
    return this.toolToReturn;
  }

  releaseDetectToolGate(turnId: string): void {
    const gate = this.detectToolGates.get(turnId);
    if (!gate) return;
    if (gate.timer) clearTimeout(gate.timer);
    this.detectToolGates.delete(turnId);
    gate.resolve();
  }

  isDetectToolPending(turnId: string): boolean {
    return this.detectToolGates.has(turnId);
  }

  // cancel(turnId) ganha o mesmo bloco de limpeza que já existe para classifyGates,
  // repetido para detectToolGates (mesmo padrão de fakeEngine.ts:109-114).
}
```

---

## 7. Critérios de aceite

Automatizados:

- **H1** `mightBeTemporal`: pega os coloquiais de §4.1 (incluindo "século") e não dispara nos
  negativos de domínio da v4 §4.1 (inalterados, não fazem parte da amostra de H11).
- **H2** `parse_tool_output` (`scripts/worker/test_tool_parser.py`, script standalone, **mesmo
  padrão de `scripts/worker/test_repetition_detector.py`** — roda com
  `.runtime/.venv/bin/python3 scripts/worker/test_tool_parser.py`, **não entra em `npm test` nem em
  `package.json`**; achado 8 corrigido adotando o precedente já existente no projeto em vez de
  inventar um mecanismo novo): `HORA`, `hora`, ` DATA `, `NENHUMA`, `""`, `BANANA`, `HORA.`, quebra
  de linha. Inválido → `NENHUMA`.
- **H3** `execute()` com `Clock` fixo, tabela completa da §4.7: `2026-09-21T01:01:00` →
  `"É 1 hora e 1 minuto."`; `T11:00:00` → `"São 11 horas em ponto."`; `T12:00:00` →
  `"São 12 horas em ponto."`; `T11:06:00` → `"São 11 horas e 6 minutos."`; e
  `"Hoje é segunda-feira, 21 de setembro de 2026."` para a data.
- **H4** `selectToolByName`: `NENHUMA` → null; desconhecido → null; `HORA` → instância.
- **H5** Integração com `FakeVoiceEngine`, `toolToReturn='HORA'`: emite `routing`, `falando`, uma
  frase com o texto exato, `turn_done` e `state: ouvindo`; `generateCalls.length === 0` e
  `classifyCalls.length === 0`. **Correção do achado 6:** o teste verifica que `session.history`
  contém a mensagem do **usuário** (empurrada antes da detecção, `sessionManager.ts:250`) mas
  **nenhuma mensagem de `role: 'assistant'`** até `markPlayed` ser chamado — não
  `history.length === 0`, que é falso.
- **H6** `execute()` que lança → frase sintetizada é exatamente `TOOL_FAILURE_TEXT`, e o modelo
  continua não sendo chamado.
- **H7** `detectTool` que lança → turno segue o caminho normal: `classify` e `generate` chamados,
  `messages[0].content` byte a byte igual à referência da Fase 5a. **Reforço do achado 1:** o teste
  também verifica que a Promise de `detectTool` rejeita sem que o `child` do engine real seja morto
  (no `FakeVoiceEngine` isso é trivial — o teste de não-morte do processo real fica em H8b, manual,
  §7 mais abaixo, porque `FakeVoiceEngine` não tem processo para matar).
- **H8** Cancelamento: `cancel(turnId)` durante `detect_tool` rejeita o `pending` via
  `detectToolGates` (§6.8, achado 7); o turno encerra sem pending órfão nem timer preso — mesmo
  teste que a Fase 3 tem para `classify`.
- **H9** `extensions.test.ts`: `tools` com `available: true`, descrição com os nomes, `registerTool`
  idempotente, `resetForTesting()` → false.
- **H10** Suíte completa sem regressão em B1-B8, C1-C6, Fase 4, Fase 5a.

Manual, com `MlxWorkerEngine` real (não `FakeVoiceEngine`) — único item novo desta versão:

- **H8b** Provocar um timeout real de `detect_tool` (ex.: `DETECT_TOOL_TIMEOUT_MS` temporariamente
  baixo em teste manual) e confirmar por `ps`/log que o processo Python **não** foi morto, e que o
  turno seguinte (`classify` normal) funciona sem reinício de worker. Verifica em ambiente real o
  que H7 verifica com o fake.

Manuais, com MLX real:

- **H11** **COBERTURA CONTRA AMOSTRA QUE EU NÃO ESCOLHI — critério que define a fase.**
  Diferente da v4: a amostra **não** é o log de auditoria da 3ª rodada (contaminado — sete de suas
  frases já foram vistas por este próprio documento como exemplo do que não fazer, e citadas na
  tabela do §1). A amostra é composta **depois** deste documento ser commitado: 15–20 frases
  coloquiais que o usuário escreve e envia sem ver `DETECT_TOOL_SYSTEM_PROMPT` primeiro (§0).
  **Aprovação exige ≥ 80% detectadas corretamente.** Abaixo disso, a fase não passa.
- **H12** Falsos positivos, bloqueante — dois grupos:
  - Categorias gerais (fuso horário, passado/futuro, duração, horário de funcionamento) — variações
    novas das mesmas categorias do §4.9, nunca vistas em nenhum log.
  - Adjacentes a domínio (achado 4): perguntas de Teologia/Virtologia genuínas que contêm
    vocabulário temporal sem pedir a hora/data de agora — nenhuma pode disparar `HORA`/`DATA`.
- **H13** Áudio real: hora e data conferidas contra `date`; fala soa natural (singular/plural
  corrigido pelo achado 9 — conferir de ouvido, incluindo os casos de minuto zerado).
- **H14** Não-regressão com áudio real: matemática, Virtologia com consulta ao corpus, Teologia.
- **H15** **Teste de bancada offline (§4.6, achados 4 e 5 corrigidos)** — não roda em produção, não
  afeta latência. Classificador real (`classify`) roda contra a mesma lista curada usada em H12
  (grupo "adjacentes a domínio"): todos devem dar `GERAL` de qualquer forma. Divergência não muda o
  comportamento do sistema — é registrada como risco residual (§8) e insumo para a próxima
  iteração do prompt de detecção, nunca escondida atrás de um recuo automático inexistente.
- **H16** `bench:voice` com seis tags únicas (`geral-antes`, `geral-depois`, …). O conjunto `geral`
  mede o custo real do filtro + detecção.

---

## 8. Limitações assumidas

1. **Falha da detecção cai no caminho normal** (§4.4) — agora sem risco de matar o worker no
   processo, mas ainda não é possível falhar fechado sobre uma intenção nunca estabelecida.
2. **`label: 'GERAL'` fixado por construção** (§4.6), sobre um conjunto aberto de frases, **sem
   verificação em tempo de execução.** H15 mede o risco offline; ele não é eliminado, é medido e
   documentado. Um falso positivo do modelo numa pergunta teológica/histórica com vocabulário
   temporal responde com a hora do sistema em vez de rotear para o especialista — mitigado por
   negativos explícitos no prompt (§4.9) e pela H12, não resolvido por construção.
3. Fraseado que o filtro permissivo não pega (nenhuma palavra da lista de `TIME_GATE`, mesmo com
   "século" adicionado) não chega ao modelo. Ampliar a lista é aditivo; ampliar demais custa falso
   positivo em outras partes do vocabulário comum ("são", "hora" isolada de outro sentido). H11 vai
   medir esse efeito com dado real em vez de suposição.
4. **Conversão de dígito para extenso na fala não é feita** (§4.7) — "São 1 hora e 1 minuto" é lido
   pelo TTS como dígitos, não como "uma hora e um minuto" por extenso. O achado 9 pedia correção de
   concordância gramatical, que foi feita; a leitura por extenso é uma melhoria de naturalidade
   adicional, fora do escopo desta correção pontual, e pode ser adiada para depois de H13 confirmar
   se o TTS já lê os dígitos de forma aceitável (histórico do projeto sugere que sim — ver Fase 2).

---

## 9. Riscos

| Risco | Prob. | Mitigação |
|---|---|---|
| Cobertura real abaixo de 80% mesmo com o modelo detectando | Média — risco central | H11 é bloqueante e usa amostra do usuário, nunca vista pelo prompt; recuo: ampliar exemplos no prompt de detecção, que é aditivo |
| Falso positivo do modelo em consulta temporal não suportada, incluindo adjacente a domínio (achado 4) | Média | H12 bloqueante com grupo dedicado a domínio; H15 mede offline contra o classificador real |
| Timeout de `detect_tool` travando o worker de verdade e H8b não pegando por ser manual | Baixa | Mesmo mecanismo de `classify`/`generate` (kill-e-reinício) continua como rede de segurança se o worker realmente travar — só não duplicado dentro de `detect_tool` |
| Ciclo de cancelamento de `detect_tool` com bug sutil | Baixa-Média | H8 espelha o teste que a Fase 3 já tem para `classify`, agora com barreira própria no fake (achado 7) |
| Inferência extra estoura latência nos turnos temporais | Baixa-Média | H16; zero em Teologia/Virtologia |
| Regressão de `npm test`/B2 por dependência de Python | Baixa (era Média na v4) | `package.json` não é tocado; `test_tool_parser.py` segue o precedente já em produção de `test_repetition_detector.py` (achado 8) |

---

## 10. Rastreabilidade

- Planos: v1, v2, v3, v4 (todos rejeitados), v5 (esta).
- Auditorias e modelos (rotação é entre modelos, não entre CLIs):
  - v1 e v2: `codex-cli 0.146.0` / gpt-5.6-sol, `effort=medium`.
  - v3: Hermes (container Nous) / longcat-2.0:free — audita executando.
  - v4: `agy 1.2.7` / Gemini 3.8 Flash (High) — primeira vez que roda o código de verdade em vez
    de só ler o pseudocódigo; é essa execução real que expôs os achados 1, 2 e 9.
  - Quatro fornecedores diferentes até aqui.
- v5: escrita sem consultar a amostra de H11 (protocolo de congelamento, §0). Após o commit, o
  usuário envia as frases; H11 é medido sem tocar mais no prompt.
- Rodada 5 de auditoria: a decidir depois do commit, seguindo a rotação — Codex ainda não julgou o
  desenho corrigido; é a escolha natural, mantendo a regra de nunca fechar com o auditor de todas
  as rodadas anteriores.
- Implementação: `agy` em modo de escrita, após aprovação (escolha já feita pelo usuário). Auditoria
  do código resultante pelo Hermes.
