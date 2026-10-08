# Fase V — O app enxerga a tela e conversa sobre ela (plano v1)

Data: 2026-10-08. Autor: Claude Opus 5.5 (orquestrador). Estado: **plano, aguardando auditoria**. Nada implementado.

## 0. Pedido e decisões do usuário (citados literalmente)

- Pedido: "É possível implementar nesse meu orquestrado esse meu app a possibilidade dele enxergar o meu desktop e conversar comigo a
  respeito de coisas que estão no desktop eu vou perguntando e ele vai me respondendo e me ajudando".
- Escolha (AskUserQuestion, 2026-10-08), entre Gemini só quando pedir / local / os dois / depois: **"Os dois, com escolha por voz"**,
  descrita na opção como "Padrão local; Gemini só quando você disser explicitamente (ex.: 'olha com o Gemini')".

Isto abre uma **saída nova de dados para a nuvem** (imagem da tela). Pela regra 2 do roteiro, ela precisa de plano explícito e
aprovação. A aprovação acima cobre o desenho "padrão local, nuvem só por pedido explícito por voz"; qualquer desvio disso (ex.:
mandar a tela ao Gemini sem a frase explícita) exige nova aprovação.

Fora do roteiro F13→F17: é uma fase inserida por decisão do usuário. Não muda a ordem das demais.

## 1. Medições que sustentam o desenho (2026-10-08, M5, 16 GB)

Spike em ambiente temporário (`mlx-vlm 0.7.6`, fora do `.runtime/.venv` do app), imagem = captura real de um terminal com erro do
npm (`npm error enoent Could not read package.json`), pergunta "o que deu errado e o que eu devo fazer?, no máximo 3 frases":

| Modelo | Tempo (aquecido) | Pico de memória | Qualidade |
|---|---|---|---|
| `mlx-community/Qwen2.5-VL-3B-Instruct-4bit` | 3,7 s | 3,9 GB | leu o erro certo; ignorou o limite de 3 frases |
| `mlx-community/Qwen3-VL-4B-Instruct-4bit` | **3,3 s** | 4,0 GB | leu o erro certo; respeitou 3 frases |

Nenhum dos dois percebeu a causa real (comando rodado na pasta pessoal, não na do projeto) — o local é "leitor de tela", não
"diagnosticador". Carga a frio: ~173 s **incluindo download**; a carga só do disco não foi medida (fazer na implementação).
**Gemini com imagem não foi medido** (enviar a captura exigiria a mesma aprovação que este plano pede; medir após aprovar).

Escolha: **Qwen3-VL-4B-Instruct-4bit** como visão local.

## 2. Desenho

### 2.1 Captura: compartilhamento de tela do navegador, sob demanda

- Botão novo na página: **"Compartilhar tela"** → `navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })`. O macOS
  pede a permissão; o usuário escolhe tela inteira ou uma janela; o navegador mostra o indicador de compartilhamento. Botão vira
  **"Parar compartilhamento"**. O stream fica aberto, mas **nenhum quadro é lido** até uma pergunta sobre a tela.
- Por que o navegador e não `screencapture` no servidor: consentimento nativo do sistema a cada sessão, indicador visível, escolha de
  janela, e nenhuma permissão de Gravação de Tela concedida ao processo Node/terminal.
- Quando o servidor decide que o turno é sobre a tela (2.2), emite o evento SSE **`screen_request { turnId }`**. O cliente pega UM
  quadro do `<video>` oculto num `<canvas>`, reduz para no máximo 1280 px no lado maior, codifica PNG e faz
  `POST /api/voice/session/:id/screen` (mesmo token da sessão, mesmo limite de tamanho do upload de áudio). Sem compartilhamento
  ativo, o cliente responde `POST .../screen` com `{ unavailable: true }` e o app diz por voz "Compartilhe a tela no botão da página
  primeiro." Prazo: 5 s; estourou → mesma frase.
- O quadro vai para o `audioStore` da sessão (diretório já limpo no fim da sessão e na varredura de resíduos da F12) e é apagado logo
  após a resposta do turno.

### 2.2 Quando um turno é "sobre a tela"

- **Filtro determinístico** (mesmo padrão `mightBeTemporal`/`mightBeMutation`): `mightBeScreenQuery(transcript)` — "tela", "olha
  (isso|aqui)", "o que (é|tem) (isso|aqui)", "esse erro", "nessa janela", "no meu desktop", etc. Lista fechada, testada.
- **Continuação**: se o turno anterior foi sobre a tela há até 90 s **e** o compartilhamento continua ativo, a fala seguinte também é
  tratada como sobre a tela ("e esse botão?"), com captura NOVA (a tela pode ter mudado).
- **Escolha do motor por voz**: o turno usa o Gemini **somente** se a fala contém a marca explícita (lista fechada: "com o gemini",
  "usa o gemini", "pergunta pro gemini", "na nuvem") **e** o canal `RODRIGO_CLOUD_VISION=1` **e** o mestre `RODRIGO_CLOUD=1`. Em
  qualquer outro caso: local. Canal desligado + pedido explícito → resposta local precedida de "A visão pelo Gemini está desligada,
  então vou olhar aqui mesmo."
- Ordem no `runTurn`: depois de `pendingMutation` (confirmação continua tendo prioridade absoluta) e **antes** da intenção em nuvem,
  das ferramentas e da classificação. Uma fala sobre a tela **nunca** dispara mutação nesta fase.

### 2.3 Visão local (padrão)

- Novo comando do worker **`describe_screen { reqId, turnId, imagePath, question, history }`**, executado no `work_loop` (fila
  serial do MLX, como `classify`/`generate`), cancelável pelo mesmo `cancel` de turno.
- Modelo carregado **sob demanda** na primeira pergunta sobre a tela (estado "aquecendo" com a frase "Carregando a visão, um
  instante."), descarregado após 10 min sem uso (libera ~4 GB). Dependência nova `mlx-vlm` no `setup:voice`, versão fixada.
- Prompt: identidade curta + "responda em português, no máximo 3 frases curtas, sem markdown; se não conseguir ler, diga" + as
  últimas 2 rodadas sobre a tela (só texto). Saída em frases pelo mesmo caminho `onSentence` da geração → voz da F13a.

### 2.4 Visão pelo Gemini (só por pedido explícito)

- Mesmo `generate_content_stream` do worker com `parts=[imagem PNG, texto]`, modelo `gemini-flash-latest`, mesmo tratamento de erro e
  `redact` da F12. Envia **só**: a imagem desse turno + a pergunta + o prompt fixo de visão. **Não** envia histórico, memórias nem
  trecho de `docs/research/`.
- Antes de enviar, o app fala "Mandando a tela para o Gemini." e a página mostra "Imagem enviada ao Google às HH:MM" (registro
  visível da saída).

### 2.5 Fronteira de privacidade do histórico (achado do planejamento)

Hoje `windowHistory` (`sessionManager.ts:990`) manda as últimas N rodadas ao Gemini nos turnos normais e **não existe marca de
"só local"**. Uma resposta da visão LOCAL (que descreve a tela) entraria no histórico e sairia para o Google no próximo turno comum
— vazamento indireto da tela, contra a escolha "padrão local".

Correção: `ConversationMessage` ganha `origin?: 'screen-local'`. Turnos de visão local entram no histórico com essa marca (pergunta
e resposta) e `windowHistory` **remove** mensagens `screen-local` antes de qualquer envio ao Gemini (removidas inteiras, nunca
resumidas). Turnos de visão pelo Gemini entram normalmente (a tela já foi ao Google por pedido explícito).

### 2.6 Privacidade na documentação e UI

Novo canal no cartão de privacidade (`privacyText.ts`) e no README: "Tela: lida no seu Mac. Só vai ao Google quando você disser
'com o Gemini' (canal `RODRIGO_CLOUD_VISION`, padrão desligado)". `privacyConsistency.test.ts` cobre.

## 3. Critérios de aceite

| Id | Critério | Como mede |
|---|---|---|
| HV.1 | Pergunta sobre a tela com compartilhamento ativo → resposta falada sobre o quadro capturado (local) | teste com motor falso + 1 teste real com imagem fixa |
| HV.2 | **Zero bytes de imagem saem da máquina** sem a marca explícita, em 50 turnos de tela variados (com e sem canal ligado) | teste de egresso da F12 (Gemini falso em loopback) |
| HV.3 | Com marca explícita + canal ligado → a requisição ao Gemini contém SÓ imagem + pergunta + prompt fixo (sem histórico/memória/conhecimento) | egresso, corpo real |
| HV.4 | Mensagens `screen-local` nunca aparecem em requisição ao Gemini nos turnos seguintes | egresso, 20 turnos alternados |
| HV.5 | Sem compartilhamento / prazo de 5 s estourado / upload inválido → frase fixa, sem erro, sem travar | teste |
| HV.6 | Barge-in durante a visão cancela o comando do worker; nenhum quadro sobra no disco após a resposta ou o fim da sessão | teste |
| HV.7 | Fala sobre a tela nunca arma mutação; confirmação pendente continua com prioridade | teste |
| HV.8 | Filtro `mightBeScreenQuery`: lista de positivas e negativas | teste unitário |
| HV.9 | Latência local medida em 20 perguntas reais (fim da fala → primeiro áudio), modelo aquecido | script, número registrado |
| HV.10 | Suíte inteira verde, typecheck limpo, prova de mutação dos testes de privacidade (remover o filtro `screen-local` → HV.4 falha) | comando |
| HV.11 | **Uso real (só o usuário mede):** 10 perguntas sobre a própria tela; ele diz se a ajuda foi útil | usuário |

## 4. Riscos

- **Memória**: Qwen3-4B (texto) + Whisper + Qwen3-VL-4B ≈ 2,5 + 0,5 + 4 GB sobre 16 GB, com navegador e outros apps abertos.
  Mitigação: carga sob demanda + descarga por ociosidade; medir pico real (HV.9).
- **Fila serial do MLX**: visão local ocupa o `work_loop` ~3–5 s; um turno seguinte espera. Aceitável para uso sob demanda.
- **Tela com dado sensível em pedido explícito ao Gemini**: o app avisa por voz antes de mandar; é escolha do usuário a cada pedido.
- **Qualidade local limitada** (medido: lê, não diagnostica). A marca "com o Gemini" é a saída para perguntas difíceis.

## 5. Arquivos previstos

Frontend: `src/frontend/main.ts`, `voice.ts`, `index.html` (botão, captura, `screen_request`). Backend: `sessionManager.ts` (caminho de
tela, marca `screen-local`, `windowHistory`), `routes.ts` (`POST .../screen`), `privacy.ts` (`RODRIGO_CLOUD_VISION`), novo
`tools/screenQuery.ts` (filtro), `mlxWorkerEngine.ts`/`engine.ts`/`fakeEngine.ts` (`describeScreen`), `shared/voiceProtocol.ts`
(evento e tipo). Worker: `worker.py` (`describe_screen` local e Gemini). `setup-voice.mjs` (`mlx-vlm`). Docs: README, `.env.example`,
`CLAUDE.md`, `privacyText.ts`.
