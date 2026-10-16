# Plano T7: Spike e Integracao Experimental do NVIDIA PersonaPlex

- **Status:** Proposto. Nada implementado. Nao auditado.
- **Data:** 2026-10-16
- **Origem:** Pedido do usuario para montar um plano de integracao do `NVIDIA PersonaPlex`.
- **Arbitragem previa:** `jev choice` preferiu `remote_optional` sobre `defer_no_integration`, com confianca baixa.
- **Escopo:** definir um caminho honesto e testavel para oferecer `PersonaPlex` como modo experimental separado, sem quebrar o pipeline atual do Rodrigo AI.

## 1. Resumo executivo

O `NVIDIA PersonaPlex` **nao e uma voz de sistema** nem um TTS drop-in. E um modelo `full-duplex speech-to-speech` completo, com servidor proprio, pesos proprios e pressuposto operacional de GPU NVIDIA. No estado atual do projeto, ele **nao cabe** no contrato de `IVoiceProvider` e **nao substitui** o pipeline classico (`transcribe -> classify/detect -> generate -> synthesize`) sem sacrificar garantias relevantes de auditabilidade, privacidade e execucao segura.

Por isso, a recomendacao deste plano e:

1. **nao** tentar encaixar `PersonaPlex` como mais uma voz;
2. expo-lo como **modo experimental separado**;
3. mante-lo **default-off**;
4. trata-lo como integracao de **backend remoto opcional**;
5. limitar o MVP a **chat livre por voz**, sem ferramentas nem mutacoes.

## 2. Fatos verificados que moldam o plano

### 2.1 O caminho oficial da NVIDIA

Verificado em material publico da NVIDIA:

- pagina oficial: `research.nvidia.com/labs/adlr/personaplex/`;
- repositorio oficial: `github.com/NVIDIA/personaplex`;
- pesos: `huggingface.co/nvidia/personaplex-7b-v1`;
- servidor oficial via `python -m moshi.server --ssl "$SSL_DIR"`;
- interface local publicada na porta `8998`;
- `docker-compose.yaml` oficial expondo `8998:8998` e reservando `gpu` NVIDIA.

Conclusao: o caminho oficial e **self-hosted com GPU NVIDIA**. Nao foi encontrada API publica hospedada pela NVIDIA para simplesmente consumir o modelo por HTTP como um TTS.

### 2.2 O hardware desta maquina

O ambiente atual e um Mac Apple Silicon (`darwin`, M5, 16 GB RAM), sem GPU NVIDIA. Portanto:

- **rodar o caminho oficial localmente nesta maquina nao e viavel**;
- qualquer integracao funcional de curto prazo exige **outro host** com GPU NVIDIA;
- qualquer hipotese de porte comunitario para MLX/macOS fica **fora deste plano**, porque nao e o caminho oficial verificado e mudaria o risco tecnico.

### 2.3 O encaixe arquitetural atual do projeto

O fluxo atual depende de:

- `VoiceEngine` para `transcribe`, `classify`, `detectTool`, `detectMutation`, `detectIntent`, `detectConfirmation`, `generate` e TTS em nuvem opcional;
- `IVoiceProvider` para transformar **texto** em WAV;
- `SessionManager` para historico auditavel, `markPlayed()`, confirmacao de mutacoes, roteamento, coalescencia, cancelamento e ordem estrita de emissao.

`PersonaPlex` conflita com isso porque:

- recebe **audio** e devolve **audio**;
- ouve e fala ao mesmo tempo;
- nao nasce como pipeline textual deterministico;
- nao preserva automaticamente a semantica atual de `markPlayed()`, confirmacoes e ferramentas.

## 3. Decisao de produto e escopo

### 3.1 Decisao central

O `PersonaPlex` sera tratado como:

- **modo de sessao alternativo**;
- **experimental**;
- **remoto opcional**;
- **sem capacidade transacional no MVP**.

### 3.2 Nao-objetivos do MVP

Ficam explicitamente fora do MVP:

- lembretes, notas, memorias e qualquer mutacao;
- hora/data/ferramentas de sistema;
- agentes especialistas e roteamento transparente;
- visao/tela;
- fallback silencioso entre `PersonaPlex` e o pipeline classico dentro da mesma sessao;
- promessa de localidade do audio se o backend estiver em outro host.

### 3.3 Objetivo do MVP

Entregar um modo "papo livre" em que o usuario:

- ativa manualmente o modo `PersonaPlex`;
- conversa por voz com um backend dedicado;
- pode interromper a fala;
- pode encerrar a sessao;
- recebe divulgacao explicita de privacidade e experimentalidade.

## 4. Arquitetura proposta

### 4.1 Principio

**Nao deformar** `IVoiceProvider` nem `MlxWorkerEngine` para fazer `PersonaPlex` parecer TTS ou LLM textual. O modo novo deve viver numa trilha paralela.

### 4.2 Desenho logico

```text
[ Frontend / Painel ]
        |
        |  mesma origem, mesma API local
        v
[ Backend Node ]
        |
        +-- modo classico -> SessionManager atual
        |
        +-- modo personaplex -> PersonaPlexSession + PersonaPlexClient
                                   |
                                   v
                          [ Host remoto NVIDIA ]
                          servidor oficial PersonaPlex
```

### 4.3 Componentes novos

1. **`PersonaPlexClient`**
   Cliente backend para o servidor remoto do PersonaPlex. Fala apenas com o host configurado pelo backend; o navegador nunca acessa o servidor remoto diretamente.

2. **`PersonaPlexSession`**
   Gerencia o modo experimental: inicio, streaming, cancelamento, fim de sessao, falha e limpeza.

3. **Selecao de modo no runtime**
   `voiceRuntime.ts` e `routes.ts` passam a conhecer dois modos de sessao:
   - `classic`
   - `personaplex`

4. **Protocolo de frontend**
   `voiceProtocol.ts` ganha sinalizacao de modo e eventos especificos do modo experimental, sem contaminar os contratos atuais desnecessariamente.

### 4.4 Por que o backend deve ficar no meio

Mesmo num modo experimental, o backend local deve continuar como mediador porque ele:

- preserva a politica same-origin/loopback do app;
- impede que o frontend fale com endpoints externos diretamente;
- centraliza config, logs e controles de privacidade;
- permite desligar o modo por config sem tocar no frontend.

## 5. Privacidade e controles obrigatorios

Este e o ponto de maior mudanca de fronteira.

Hoje o projeto declara que o audio do usuario nao sai da maquina. Se `PersonaPlex` rodar em outro host, essa afirmacao deixa de ser verdade para esse modo. Portanto, antes de qualquer implementacao funcional:

1. adicionar flags estritas, por exemplo:
   - `RODRIGO_PERSONAPLEX=0|1`
   - `RODRIGO_PERSONAPLEX_URL=...`
   - `RODRIGO_SEND_AUDIO_REMOTE=0|1`
2. fazer valores invalidos derrubarem o startup;
3. atualizar `privacy.ts`, `privacyText.ts`, `README`, `index.html` e `CLAUDE.md`;
4. manter o modo desligado por padrao;
5. tornar explicito na UI e em `GET /api/privacy` que, nesse modo, o audio sai do Mac para um host configurado pelo usuario.

Regra de honestidade:

- com `PersonaPlex` remoto ligado, o app **nao pode** dizer que o audio "nunca sai";
- com `PersonaPlex` desligado, a promessa atual continua valida para o pipeline classico.

## 6. Fases de execucao

### Fase 0: Go/No-Go operacional

Objetivo: provar que existe um ambiente de execucao real fora do app.

Passos:

1. confirmar um host Linux com GPU NVIDIA disponivel;
2. aceitar a licenca dos pesos no Hugging Face;
3. subir o servidor oficial do PersonaPlex;
4. validar acesso local ao Web UI/porta `8998`;
5. medir latencia basica e estabilidade fora do Rodrigo AI.

Saida:

- **go**: ha host funcional e latencia utilizavel;
- **no-go**: sem host NVIDIA ou sem performance minima, nada entra no app.

### Fase 1: Controles de config e privacidade

Objetivo: preparar a fronteira de dados antes do recurso.

Passos:

1. introduzir config estrita do modo PersonaPlex;
2. refletir a config em `GET /api/privacy`;
3. atualizar UI e docs com a nova verdade;
4. criar testes de consistencia para impedir linguagem enganosa.

Saida:

o recurso continua desligado, mas a base esta pronta e honesta.

### Fase 2: Abstracao de backend experimental

Objetivo: adicionar uma trilha paralela sem tocar no comportamento classico.

Passos:

1. criar `src/backend/voice/personaplexClient.ts`;
2. criar `src/backend/voice/personaplexSession.ts`;
3. adaptar `voiceRuntime.ts` e `routes.ts` para negociacao de modo;
4. manter `SessionManager` classico intacto, exceto no minimo necessario para coexistencia.

Saida:

backend suporta as duas trilhas sem regressao no modo classico.

### Fase 3: MVP chat-only

Objetivo: entregar uma experiencia utilizavel porem conscientemente restrita.

Passos:

1. permitir ativacao manual do modo `PersonaPlex` na UI;
2. abrir sessao experimental separada;
3. enviar audio para o backend local, que o repassa ao `PersonaPlexClient`;
4. reproduzir o audio de resposta;
5. suportar cancelamento/interrupcao e encerramento;
6. exibir aviso visual de que ferramentas e memoria estao desativadas nesse modo.

Saida:

modo experimental funcional para conversa livre.

### Fase 4: Falhas seguras

Objetivo: impedir comportamento enganoso ou ambiguo.

Passos:

1. se o servidor PersonaPlex falhar, encerrar a sessao experimental com aviso claro;
2. nao migrar silenciosamente para o pipeline classico;
3. limpar buffers e estado ao cancelar;
4. impedir vazamento de sessao entre os dois modos.

Saida:

falhas explicitas, sem "meio funcionamento".

### Fase 5: Medicao e decisao de continuidade

Objetivo: decidir se o modo merece evoluir alem do experimento.

Passos:

1. medir latencia real ponta a ponta;
2. avaliar qualidade percebida da conversa;
3. revisar custo operacional do host externo;
4. decidir se faz sentido desenhar uma fase futura para transcripts auxiliares ou integracoes mais ricas.

Saida:

decisao de continuar, congelar ou descartar.

## 7. Criterios de aceite do MVP

- o modo classico continua funcionando exatamente como antes;
- o modo `PersonaPlex` so ativa com opt-in explicito;
- a UI e `GET /api/privacy` dizem claramente quando o audio sai do Mac;
- no modo `PersonaPlex`, nenhuma ferramenta ou mutacao e executada;
- cancelamento/encerramento nao deixam processos ou sessao zumbi;
- indisponibilidade do backend remoto gera falha honesta, sem fallback silencioso;
- a sessao experimental consegue falar, ouvir resposta e ser interrompida manualmente.

## 8. Riscos principais

| Risco | Impacto | Tratamento |
|---|---|---|
| Sem host NVIDIA disponivel | bloqueio total | Gate duro na Fase 0 |
| Privacidade: audio sai da maquina | alto | flag explicita, default-off, UI honesta |
| Pressao para encaixar tools no MVP | alto | fora de escopo por definicao |
| Regressao no pipeline classico | alto | trilha paralela, nao substituir `VoiceEngine` atual |
| Latencia ruim no host remoto | medio/alto | medir antes de integrar |
| Ambiguidade de UX entre os dois modos | medio | rotular modo experimental de forma inequivoca |

## 9. Arquivos provaveis de impacto

- `src/backend/privacy.ts`
- `src/shared/privacyText.ts`
- `src/backend/voice/voiceRuntime.ts`
- `src/backend/voice/routes.ts`
- `src/backend/voice/sessionManager.ts` (minimo necessario)
- `src/frontend/voice.ts`
- `src/frontend/main.ts`
- `src/frontend/index.html`
- `src/shared/voiceProtocol.ts`
- novos: `src/backend/voice/personaplexClient.ts`, `src/backend/voice/personaplexSession.ts`
- testes de privacidade, sessao e protocolo de voz

## 10. Gates antes de qualquer codigo

1. **Gate 0: hardware e runtime**
   Existe um host NVIDIA utilizavel para subir o servidor oficial?

2. **Gate 1: decisao explicita de privacidade**
   O usuario aceita um modo em que o audio sai do Mac para esse host?

3. **Gate 2: auditoria adversarial do plano**
   Como este plano foi escrito por mim, ele precisa de auditoria externa antes de implementacao.

4. **Gate 3: escolha de nomenclatura e UX**
   O produto chamara isso de `Modo PersonaPlex`, `Modo Papo`, ou outro nome equivalente, sempre com rotulo de experimental.

## 11. Decisoes pendentes do Rodrigo

1. Ha ou havera um host NVIDIA real para a Fase 0?
2. O audio remoto e aceitavel nesse modo experimental?
3. O MVP deve ser rotulado como `Modo PersonaPlex` ou `Modo Papo (experimental)`?
4. Depois deste documento, seguimos para auditoria do plano ou arquivamos a ideia como spike futuro?
