# Fase 12 — Privacidade condizente com a promessa — v2.2 (rodadas 2 e 3 incorporadas)

Versão: v2 (corrige a rodada 1 de auditoria sobre `docs/phase-12-v1.md` v1.1)
Data: 2026-10-06
Status: **Rodada 3 (agy, `docs/audits/f12/plan-r3-agy.md`) = APROVADO COM RESSALVAS; seus 9 achados (todos de implementação/detalhe) estão incorporados neste v2.2 (§0B). Pronto para implementar. Histórico: rodada 2 feita (Kimi K3 — REJEITADO, 11 achados: 10 aceitos, 1 refutado no código; Hermes falhou por cota). D4 decidida (2026-10-07). Rodada 3 com o agy (usuário escolheu o agy; limitação registrada: o agy também foi auditor da rodada 1 — não é auditor novo, então a rodada 3 é de CONFERÊNCIA do v2.1, não de independência).** Nada implementado.
Base: `docs/phase-12-v1.md` (levantamento §1, decisões D1–D3 do usuário, critérios). Este arquivo **substitui** o v1 nas seções abaixo; o §1 (levantamento) do v1 continua válido e é acrescido do §1A.

## 0. Rastreabilidade da rodada 1 (CLI + modelo, capturados em 2026-10-06)

| Auditor | Modelo | Entrada | Resultado |
|---|---|---|---|
| Kimi (CLI `deepseek -m`) | `moonshotai/kimi-k3` (NVIDIA NIM) | tentativa 1: plano + 3 trechos de código colados (26 KB) → **saída degenerada, descartada** (piso quantitativo do skill); tentativa 2: só o plano (15 KB) | 6 achados, 1 REJEITADO |
| agy | modelo padrão do agy (não capturado — **registrar na rodada 2**) | repositório limpo (`git archive`, sem `docs/research/`, sem `.env`) | 10 achados, REJEITADO |
| Simulação própria (Python 3 + Node) | — | bateria de 25 payloads de URL | divergência reproduzida (§2.5) |
| Hermes | modelo configurado `meituan/longcat-2.0:free` (conta Nous) | **falhou duas vezes** (2026-10-06 e 2026-10-07, ~20 min cada): resposta "You've used up the allowance for chatting without signing in", **nenhum arquivo produzido**; uma chamada trivial (`ok`) funcionou entre as duas tentativas | gap declarado: Hermes ainda não viu este plano; a parte executável (regex) foi rodada por mim |
| Jev | `jev-1.13.0` | triagem | nova auditoria de plano 0,98 (conf. 0,96); achados reais entre 0,61–0,84 |

Registro de uso de material pessoal: **nenhum auditor viu `docs/research/` ou `.env`**.

## 0A. Rodada 2 — disposição (Kimi K3, `docs/audits/f12/plan-r2-kimi-k3.md`)

| # | Achado | Disposição |
|---|---|---|
| 1 | STT em nuvem no navegador invalidaria `neverSends: audio` | **REFUTADO no código** (2026-10-07): `src/frontend/voice.ts` usa só `getUserMedia`+`AudioWorklet` e POST para `/api/voice/session/audio` (backend local); não há `SpeechRecognition`/`speechSynthesis`. Acrescentado ao §1A como fato 8 |
| 2 | pid reciclado dentro do mesmo boot | aceito → §2.4 (`ps -o lstart=`) |
| 3 | EPERM em `kill(pid,0)` | aceito → §2.4 |
| 4 | ordem do `redact()` e lado Node | aceito → §2.6 |
| 5 | H12.2 circular | aceito → §4 (gabarito à mão) |
| 6 | H12.5 passa por 400 qualquer | aceito → §2.7/§4 |
| 7 | consistência não cobre `.env.example`/`CLAUDE.md` | aceito → §2.3 |
| 8 | H12.3 sem método de medição | aceito → §4 |
| 9 | "nunca" absoluto na regra 3 | aceito → §2.5 |
| 10 | D4 aberta, Hermes sem plano B, "igualdade exata" ambígua | aceito → §3, §5, §2.5 |
| 11 | modelo de ameaça não declarado | aceito → §7 |

## 0B. Rodada 3 — disposição (agy, 2026-10-07; veredito APROVADO COM RESSALVAS; Jev: achados são de implementação 0,06 de ser de desenho; escolha implementar×nova rodada 0,53/0,47, confiança 0,06 — decisão minha, declarada)

| # | Achado | Disposição |
|---|---|---|
| 1 | `ps -o lstart=` em `pt_BR` devolve data não parseável (`NaN`) | **REPRODUZIDO por mim** (2026-10-07: `qua  7 out 10:00:35 2026` → `NaN`; `LC_ALL=C` → válido). Aceito → §2.4 |
| 2 | `redact()` no stderr do Node vaza chave partida entre chunks | aceito → §2.6 (buffer por linha) |
| 3 | `HTTPS_PROXY` não é respeitado pelo `fetch` do Node (H12.3 falso-sucesso) | aceito → §4 H12.3 |
| 4 | `RODRIGO_CLOUD`×`RODRIGO_CLOUD_GENERATION` ambíguo | aceito → §2.1/§2.2 |
| 5 | `lstart` tem resolução de 1 s | aceito como **limitação residual declarada** → §6 |
| 6 | EPERM mantém órfão eterno | aceito → §2.4 |
| 7 | texto fóssil do v1 em §2.4 | aceito → removido |
| 8 | pasta do próprio processo não é removida no shutdown | aceito → §2.4 |
| 9 | "validação única" contraditória; "nunca tocar" derrubável | aceito → §2.5/§2.4 |

Também: o agy **reproduziu** o redirecionamento 307 do `httpx` mantendo `x-goog-api-key` para outro host (§1A.7 deixa de ser suposição).

## 1A. Novos fatos verificados (acrescentam-se ao §1 do v1)

1. **Dois clientes Gemini no worker**: `worker.py:754` (intenção, `_intent_client`) e `worker.py:871` (geração, `_gemini_client`). O v1 falava de "o cliente".
2. **`RODRIGO_CLOUD_GENERATION=0` não é "sem nuvem"**: a intenção em nuvem (`RODRIGO_CLOUD_INTENT`, padrão 1) continua enviando o texto da fala (`sessionManager.ts:425-437`).
3. **`session.history` contém o conteúdo local**: falas do usuário (`:330`) e frases do assistente, inclusive confirmações/resultados de ferramenta que repetem o conteúdo de notas/memórias (`:732`); vai inteiro em `messagesForEngine` (`:620-623`), limitado por `maxMessages` (`:275`).
4. **Alegações falsas além das listadas no v1** em `src/frontend/index.html`: `:116` ("Sem cobrança de API nesta fase"), `:118` ("Nenhum serviço pago, chave de acesso ou chamada a servidores externos…"), `:127` ("…sem tráfego de dados para terceiros"). Conferido em 2026-10-06.
5. **`AudioStore.cleanupAll()`** faz `rm -rf` de todo `baseDir` e recria vazio (`audioStore.ts:58-61`); `dirFor()` guarda o diretório em cache e **não o recria** (`:19-27`). Uma segunda instância (porta diferente, mesmo `.runtime/tmp`) apagaria sessões vivas e as gravações dela passariam a falhar com `ENOENT`. `EADDRINUSE` (`server.ts:162`) só protege a mesma porta.
6. **Validação de URL**: reproduzido que a leitura literal do §2.5 do v1 diverge entre Python e Node em 6 de 25 payloads, e que `http://evil.com\@127.0.0.1/` é aceito pelo Python (`hostname` = 127.0.0.1) e lido como `evil.com` pelo Node. Os demais divergentes são formas legítimas de loopback (`0x7f.1`, `2130706433`, `127.1`, IPv6 longo) que o Node normaliza e o Python rejeita.
8. **Captura e saída de voz são 100% locais ao backend** (conferido em `src/frontend/voice.ts:155-166,260,337`): sem Web Speech API, sem `speechSynthesis`; o áudio vai por `fetch`/`EventSource` ao próprio servidor. O STT é o `mlx-whisper` do worker.
7. **Redirecionamento** (**reproduzido pelo agy na rodada 3** com `httpx` 0.28.1: o 307 cross-origin descarta `authorization` mas **mantém `x-goog-api-key`**; eu não o reproduzi — status: REPRODUZIDO por auditor, não por mim): `httpx` segue 307 preservando o header da chave. A mitigação é barata e independe da confirmação.

## 2. Desenho (substitui §2 do v1)

### 2.1 Controles de saída — um por canal (nenhum canal sem controle)

| Variável | Canal | Padrão | Observação |
|---|---|---|---|
| `RODRIGO_CLOUD=0` | **mestre**: nenhuma chamada Gemini (geração **e** intenção) | `1` | **`RODRIGO_CLOUD_GENERATION` do v1 está EXTINTO.** `RODRIGO_CLOUD_INTENT` é o único sub-interruptor (vale só com mestre `1`). Não existe modo "geração off + intenção on" (sem caso de uso: sem geração a intenção em nuvem não tem para quem entregar) — declarado, não omitido |
| `RODRIGO_SEND_HISTORY` | histórico da sessão na geração | `1` | `0` ⇒ só a fala do turno atual vai à geração (sem turnos anteriores). Rótulo na UI: sem histórico a resposta perde continuidade |
| `RODRIGO_HISTORY_TURNS` | tamanho da janela quando `SEND_HISTORY=1` | valor atual de `maxMessages` | torna o limite visível e ajustável |
| `RODRIGO_SEND_MEMORIES` (D2) | bloco de memórias armazenadas | `1` | |
| `RODRIGO_SEND_KNOWLEDGE` (D1) | trecho de `docs/research/` | **`0`** | |

**Honestidade sobre histórico (achado mais alto, Jev 0,84):** `SEND_MEMORIES=0` controla só o bloco de **memórias armazenadas**. O que o usuário **disse** ou o assistente **repetiu** na sessão corrente continua indo ao Gemini enquanto `SEND_HISTORY=1`. A UI e o README dizem isso literalmente. Não existe marca "só local" por item nesta fase (F14).

Com `RODRIGO_CLOUD=0`: ferramentas locais (hora, data, lembrete, nota, memória) funcionam com detecção **só local** (Qwen/regras); fala que exige geração recebe resposta fixa dita por voz e emitida como SSE `error`: "geração em nuvem desligada". **Sem fallback para outro provedor** (D3).

### 2.2 `GET /api/privacy`

Mesmas guardas Host/Origin da API. Resposta sem segredos, derivada das **mesmas variáveis** usadas na montagem da requisição (uma função `effectivePrivacy(env)` importada pelos dois lados) e rotulada na UI como "configuração em vigor — o que o sistema está configurado para enviar". A **medição do tráfego real** é o teste H12.2 (Gemini falso), não esta tela; a UI não afirma ter medido (achado 11 do Kimi).

```ts
interface PrivacyStatus {
  mode: 'cloud' | 'local-only';           // RODRIGO_CLOUD
  intent: 'gemini' | 'local';
  keyPresent: boolean;                    // nunca valor nem tamanho
  sends: { utteranceForIntent: boolean; history: boolean; historyTurns: number | null; memories: boolean; knowledgeSnippet: boolean };
  neverSends: readonly ['audio'];         // verificado por H12.2, não por constante decorativa: o teste falha se um .wav for visto
  models: { generation: string | null; intent: string | null };
}
```

### 2.3 UI e docs — lista completa, não amostral

Corrigir **todas** as frases que prometem ausência de nuvem/custo/chave/terceiros, localizadas por busca (não por lista fixa de linhas): `src/frontend/index.html` (`:6`, `:40`, `:92`, `:116`, `:118`, `:121`, `:127` e qualquer outra que a busca achar), `README.md` (`:7,16,39,191-197`), `.env.example`, `CLAUDE.md`.
Teste de consistência (falha se reaparecer): varre `src/frontend/`, `README.md`, `.env.example` e `CLAUDE.md` (controle positivo **por arquivo**) por um conjunto de padrões (`100% local`, `sempre offline`, `sem tráfego`, `sem cobrança`, `nenhum serviço`, `chave de acesso`, `servidores externos`) e exige que nenhum apareça sem o qualificador "com geração em nuvem desligada". **Controle positivo obrigatório**: o teste roda também sobre um HTML de fixture com a frase proibida e **deve** falhar nele (prova que o detector detecta).

### 2.4 Limpeza de resíduos (substitui §2.4 do v1)

Sem `rm -rf` cego da base. Cada processo cria o subdiretório `.runtime/tmp/<pid>-<startEpochMs>/`, onde `startEpochMs = Date.now() - round(process.uptime()*1000)` (**início real do processo**, não a hora em que a pasta é criada), e guarda nele os diretórios de sessão. Regras de decisão por subdiretório, na inicialização:
1. `process.kill(pid,0)` lança `ESRCH` ⇒ pid morto ⇒ **remove**.
2. pid existe (sem erro) **ou** `EPERM` ⇒ consulta o início real com `ps -o lstart= -p <pid>` **executado com ambiente `LC_ALL=C LANG=C`** (sem isso o formato varia por idioma: em `pt_BR` sai `qua  7 out …`, que o Node lê como `NaN` — reproduzido em 2026-10-07). Compara com `startEpochMs` do nome (tolerância de 2 s): divergência ⇒ pid reciclado ⇒ **remove**; coerente ⇒ instância viva ⇒ **não toca**. Para `EPERM` o `ps` também funciona sem privilégio, então o mesmo critério se aplica (não há "vivo eterno").
3. **Se a consulta falhar ou o parse der `NaN`/vazio: nunca remover** (fail-safe), registrar aviso e deixar para a próxima inicialização.
4. No **shutdown gracioso** (`SIGINT`/`SIGTERM`/`server.close()`) o runtime remove a **própria** pasta `<pid>-<startEpochMs>/` (evita acumular pastas vazias).
Limitação residual declarada (§6): `lstart` tem resolução de 1 s; um pid reciclado no mesmo segundo é visto como o mesmo processo e fica para a próxima limpeza.
**Decisões tomadas na implementação (parte iii, 2026-10-07), não definidas no v2.2:** (a) subdiretórios fora do padrão `<pid>-<epoch>` (restos de versões anteriores, UUID solto) só são removidos se estiverem parados há mais de 1 h — conservador, porque uma instância antiga ainda viva os estaria usando; (b) só diretórios reais são considerados: arquivos soltos e links simbólicos são ignorados (nunca seguidos); (c) `AudioStore.cleanupAll()` deixou de ser usado pelo runtime (só limpava o diretório do próprio processo, mas o nome sugeria o contrário) — o shutdown usa `dispose()`; (d) o parse de `lstart` só aceita o formato do locale C e devolve `null` (nunca `NaN`) para qualquer outra coisa, o que aciona o fail-safe.
`dirFor()` passa a recriar o diretório se faltar (`mkdirSync recursive`) em vez de confiar no cache.
O `.aiff` do `say` passa a ser gravado como `${outputPath}.aiff`, **no mesmo diretório da sessão** (já recebe `outputPath`), limpo por `cleanupSession()` — **a varredura de `os.tmpdir()` é descartada** (achado 6 do agy).
Teste: (a) órfão de pid morto some; (b) diretório de instância viva (processo-filho real mantido vivo pelo teste) permanece; (c) kill -9 no meio de um turno e reinício deixam zero `.wav`/`.aiff`.

### 2.5 Instrumentação de rede para H12.2 — reescrita

Variável de teste `RODRIGO_GEMINI_BASE_URL`. Regras:
1. **Só vale em modo de teste explícito** (`RODRIGO_TEST=1`). Fora dele é ignorada e um aviso é logado.
2. **Validação dupla com fonte única da regra**: o Node valida antes de spawnar o worker e o worker revalida (mesma regra, fullmatch, sem parser diferente). Aceita apenas ("igual" abaixo = `fullmatch` do regex, inequívoco) o regex `^http://(127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})$`, **aplicado com correspondência total** (`re.fullmatch` em Python, `RegExp.test` em JS — nunca `re.match`+`$`) e **somente dígitos ASCII** (`[0-9]`, nunca `\d`), mais checagem numérica da porta `1024..65535` (sem caminho, sem userinfo, sem barra invertida, sem `localhost`, sem formas hex/decimal/octal, sem zero à esquerda). **Reproduzido em 2026-10-07** (`docs/audits/f12/loopback-regex-battery.py/.mjs`): o regex original `\d{1,5}$` aceitava `\n` final no `re.match` do Python, dígitos Unicode `９０００` no Python (e não no Node — divergência), porta `0`, `99999` e `09000`. O Node passa ao worker **a string já validada**; o worker só a aceita se for **igual por igualdade exata** ao regex acima (segunda checagem independente, não segundo parser).
3. **Em modo de teste o worker usa chave sintética** (`test-dummy-key`) e **recusa** usar `GEMINI_API_KEY` real. Assim, nos **dois clientes enumerados** (`_intent_client`, `_gemini_client`) a chave real não viaja para o host falso; qualquer terceiro caminho que crie cliente Gemini (diagnóstico, script de rotação do §2.7) **não pode** ler `RODRIGO_GEMINI_BASE_URL` — verificado por busca no repositório por `genai.Client` na implementação.
4. **Redirecionamentos desligados** nos dois clientes (`httpx.Client(follow_redirects=False)` repassado a `HttpOptions`), também fora do modo de teste (hardening de produção).
5. **Os dois clientes** (`_intent_client` e `_gemini_client`) recebem a mesma `base_url`. O Gemini falso responde aos **dois contratos**: SSE de `streamGenerateContent` (geração) e JSON com o schema fechado da intenção (`generateContent`).
Teste de mutação: cada payload da bateria (25 do §1A.6 + redirect 307 do servidor falso) deve ser rejeitado/ignorado; remover a regra 3 ou a 4 deve derrubar pelo menos um teste.

### 2.6 Logs e erros

**Buffer por linha obrigatório antes do `redact()` no Node:** `mlxWorkerEngine.ts:143` deve acumular o stderr por linha (`readline` sobre `child.stderr` ou acumulador com quebra por `\n`; linha sem `\n` é emitida só ao fechar o stream ou ao passar de 8 KB, e **sempre** passa por `redact()` já completa). Sem isso uma chave partida entre dois `data` vaza em duas fatias (reproduzido pelo agy). Teste: injetar a chave sintética partida em todos os pontos de corte possíveis e exigir mascaramento.

Função única `redact()` (implementada no worker **e** reaplicada no Node sobre todo stderr do worker repassado em `mlxWorkerEngine.ts:143` e sobre qualquer `console.error` que formate exceção de rede) aplicada a toda mensagem de exceção antes de `log_diag`/`unavailable`: mascara, **sobre a string completa e antes de qualquer truncamento**, `AIza[0-9A-Za-z_-]{8,}` (inclui fragmentos de chave), formas URL-encoded e com quebra de linha, `?key=...`, o valor atual de `GEMINI_API_KEY` (se definido) e o valor da chave antiga informado ao script de rotação e remove corpo bruto de requisição/resposta (trunca a 160 caracteres). Testes com **caminhos de erro forçados** no Gemini falso: 4xx, 5xx, timeout, redirect — afirma que stdout/stderr do servidor e do worker não contêm a chave sintética nem os marcadores. Controle positivo: um teste que injeta propositalmente a chave sintética numa exceção e verifica que `redact()` a mascara.

### 2.7 Rotação da chave (H12.5 — ajuste)

Procedimento **manual** (o script de rotação **não** lê `RODRIGO_GEMINI_BASE_URL`; sempre fala com o endpoint real; é a única exceção deliberada e fica fora do modo de teste), executado pelo usuário no Google AI Studio; a verificação é um script interativo que lê a chave antiga de um prompt sem eco (`read -s`), faz uma chamada de 1 token **bem-formada** e exige o **erro específico de chave inválida** (corpo com `API_KEY_INVALID`/status 400 com esse motivo, ou 401/403) — qualquer outro 400 (requisição malformada) é tratado como **teste inválido, não como sucesso**; em seguida faz a mesma chamada com a chave nova e exige **200** e **não grava a chave em disco, histórico de shell nem variável exportada**. Fica fora do caminho de boot (a sugestão de bloquear a inicialização foi **rejeitada**: acopla disponibilidade do app a uma chamada de rede e a um segredo antigo que não deveria existir mais).

## 3. Decisões do usuário (inalteradas) e novas implicações

D1 `SEND_KNOWLEDGE` padrão `0`; D2 `SEND_MEMORIES` controle global; D3 sem fallback. Resposta literal registrada: "D1 , D2 , D3 sim, manda para auditoria". **D4 (decidida pelo usuário em 2026-10-07, literal: "SEND_HISTORY=1 e D4 sim"):** `RODRIGO_SEND_HISTORY` tem padrão `1` (histórico enviado ao Gemini, como hoje), **declarado** na UI/README/`/api/privacy`. Mudar o padrão para `0` degradaria a continuidade da conversa; o controle existe para quem quiser desligar.

## 4. Critérios de aceite (substituem §4 do v1)

- **H12.1** Nenhuma tela/doc afirma ausência de nuvem/custo/chave/terceiros com geração ligada; modo efetivo visível antes da conversa; teste de consistência (§2.3) com controle positivo.
- **H12.2** 100 turnos (inclui cenários em que uma nota/memória sintética foi **ditada e confirmada num turno anterior**): zero `.wav`/áudio; com `SEND_MEMORIES=0` o bloco de memórias armazenadas ausente; com `SEND_KNOWLEDGE=0` nenhum trecho; com `SEND_HISTORY=0` nenhuma fala anterior; com tudo ligado, o payload capturado é comparado a um **gabarito escrito à mão por cenário** (independente de `effectivePrivacy`, que seria circular); `/api/privacy` é conferida **contra o mesmo gabarito**, não contra o código que a gera. **O conceito "só local" foi removido** (não existe antes da F14).
- **H12.3** 50 tarefas locais com a rede bloqueada **e `RODRIGO_CLOUD=0`** (mestre): funcionam sem timeout de intenção; fala que exige geração diz "geração desligada"; zero **tentativas** de conexão a outros hosts, medido assim: (i) **worker Python** — `HTTPS_PROXY`/`HTTP_PROXY` para um registrador em loopback que recusa e conta tentativas; (ii) **servidor Node** — o `fetch` nativo (undici) **ignora** essas variáveis (reproduzido pelo agy), então o teste instala um `setGlobalDispatcher` do undici (e/ou monkeypatch de `globalThis.fetch`) que registra/recusa qualquer destino fora de loopback. Bloquear a rede sem registrar mascara as tentativas. Escopo declarado: processos do servidor Node e do worker Python. Parte de voz: só o usuário mede.
- **H12.4** `cleanupSession` limpa a sessão; após kill -9, reinício deixa zero órfãos; instância viva intacta (§2.4); logs sem marcador/chave inclusive em caminhos de erro (§2.6).
- **H12.5** Chave nova em uso; chave antiga recusada pela API (§2.7), sem persistir nenhuma das duas.

## 5. Plano de verificação e auditoria

0. **Plano B para o Hermes** (falhou 2 vezes por cota): as partes executáveis do plano são rodadas por mim com scripts versionados em `docs/audits/f12/`; na rodada 3 o Hermes só entra se o limite renovar, e a ausência dele é registrada em vez de assumida.
1. **Rodada 2 de auditoria de plano** com auditor(es) **diferente(s)** do agy e do Kimi: Hermes (executa; copiar só `plano` + código sem `docs/research`; **requer Docker ligado — pedir autorização ao usuário por causa da RAM**) e/ou opencode com modelo de outra família. Pedir explicitamente que **executem** a bateria de URLs e a simulação do `cleanupAll` e **não assumam corretos** os achados da rodada 1.
2. Implementação em partes pequenas: (i) `effectivePrivacy` + controles + `/api/privacy`; (ii) docs/UI + teste de consistência; (iii) limpeza por subdiretório; (iv) `redact()`; (v) Gemini falso e H12.2.
3. Testes de mutação: remover regex/rejeição de redirect/chave sintética/`redact`/checagem de pid viva — cada remoção derruba ≥1 teste.
4. **Auditoria de código** (Hermes) antes de fechar a fase (regra do skill: auditoria de plano não acha teste vácuo).
5. Medição real: só o usuário mede H12.1/H12.3 por voz.

## 6. Riscos remanescentes

| Risco | Mitigação |
|---|---|
| `SEND_HISTORY=0` quebra a continuidade | padrão `1`; D4 ao usuário; medir antes de mudar |
| Desligar trecho (D1) degrada Teologia/Virtologia | medir com perguntas fixas antes/depois |
| `redact()` incompleto | controle positivo + teste com chave sintética em erros forçados |
| `process.kill(pid,0)` falso positivo por pid reciclado | combinado com `startEpochMs` vs boot do sistema |
| Redirect (reproduzido pelo agy, não por mim) | `follow_redirects=False` + chave sintética em teste; testar com 307 no Gemini falso |
| `lstart` com resolução de 1 s: pid reciclado no mesmo segundo | limitação residual aceita (desktop); o órfão é removido numa limpeza posterior |
| Locale do usuário muda o formato do `ps` | `LC_ALL=C` + fail-safe `NaN ⇒ não remove` + teste com `LC_ALL=pt_BR.UTF-8` |

## 7. Modelo de ameaça

Aplicativo local de usuário único. **Dentro do escopo:** o que o app envia pela rede, logs, arquivos temporários, chave em logs/erros/UI. **Fora do escopo (declarado):** outros processos do mesmo usuário lendo `/proc`/ambiente do app ou o `.env`, malware local, acesso físico. A UI não promete proteção contra essas ameaças.

## 7A. Fora de escopo

Marca "só local" por item (F14); resumos derivados de histórico (se a F13 criá-los, entram sob `SEND_HISTORY`); busca web (F15, aprovação nominal própria); gate de boot por rotação de chave (rejeitado).
