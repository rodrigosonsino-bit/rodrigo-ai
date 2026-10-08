# Auditoria do plano docs/phase-vision-v1.md — Codex (read-only, cópia isolada: plano + código de src/ e worker.py; sem docs/research)

Resultado: REFAZER (17 achados; 1 CRÍTICA). Rodada 1.

O plano precisa ser refeito antes da implementação. A fronteira proposta protege parte do histórico, mas deixa saídas de texto da tela pelo TTS e pelo reaproveitamento de contexto.

Auditoria do código fornecido, com reproduções locais de cancelamento da fila, redação de exceções e tamanho de PNG. A visão ainda não está implementada; distingo abaixo falhas do desenho de comportamentos já existentes.

1. **ACHADO:** A descrição produzida pela visão local pode sair imediatamente pelo **TTS do Gemini**, sem frase explícita e mesmo com visão em nuvem desligada.

   **EVIDÊNCIA:** O [plano:71](/private/tmp/claude-501/auditV/docs/phase-vision-v1.md:71) manda reutilizar o caminho de geração/voz. Esse caminho identifica a síntese como `generated` em [sessionManager.ts:779](/private/tmp/claude-501/auditV/src/backend/voice/sessionManager.ts:779) e entrega o texto ao provedor em [sessionManager.ts:827](/private/tmp/claude-501/auditV/src/backend/voice/sessionManager.ts:827). O TTS vem habilitado por padrão em [privacy.ts:86](/private/tmp/claude-501/auditV/src/backend/privacy.ts:86). No worker, sua autorização verifica mestre/TTS, e a chamada envia `contents=text`: [worker.py:1195](/private/tmp/claude-501/auditV/scripts/worker/worker.py:1195), [worker.py:1263](/private/tmp/claude-501/auditV/scripts/worker/worker.py:1263). Filtrar `windowHistory` não intercepta essa saída.

   **GRAVIDADE:** CRÍTICA / **CONFIANÇA:** Alta.  
   **AÇÃO:** Propagar a restrição de saída até o provedor de voz e obrigar TTS local para conteúdo protegido. Testar com mestre, histórico e TTS ligados, visão desligada e nenhuma frase explícita.

2. **ACHADO:** O plano transforma consentimento para um turno de visão Gemini em autorização para retransmitir sua descrição nos turnos seguintes.

   **EVIDÊNCIA:** O [plano:89](/private/tmp/claude-501/auditV/docs/phase-vision-v1.md:89) determina que turnos Gemini entrem normalmente no histórico porque a tela “já foi ao Google”. O histórico é incorporado à próxima geração em [sessionManager.ts:686](/private/tmp/claude-501/auditV/src/backend/voice/sessionManager.ts:686), cuja autorização depende apenas do mestre em [sessionManager.ts:761](/private/tmp/claude-501/auditV/src/backend/voice/sessionManager.ts:761). Assim, uma descrição antiga pode sair em uma pergunta comum sem nova frase explícita.

   **GRAVIDADE:** ALTA / **CONFIANÇA:** Alta.  
   **AÇÃO:** Marcar a proveniência de **todos** os turnos de tela, independentemente do motor. A autorização deve valer para o envio especificado daquele turno, sem liberar permanentemente suas mensagens.

3. **ACHADO:** A marca `screen-local` não tem um percurso definido pelos pontos reais de gravação do histórico, especialmente durante confirmação e reprodução tardia.

   **EVIDÊNCIA:** A pergunta entra sem metadados **antes** de `pendingMutation` em [sessionManager.ts:391](/private/tmp/claude-501/auditV/src/backend/voice/sessionManager.ts:391). Uma fala sobre a tela durante confirmação pode terminar no reprompt e retornar antes do novo ramo proposto: [sessionManager.ts:408](/private/tmp/claude-501/auditV/src/backend/voice/sessionManager.ts:408). A resposta entra somente em `markPlayed`, também sem origem: [sessionManager.ts:916](/private/tmp/claude-501/auditV/src/backend/voice/sessionManager.ts:916). Os registros de frases emitidas guardam apenas texto/consumo: [sessionManager.ts:866](/private/tmp/claude-501/auditV/src/backend/voice/sessionManager.ts:866). Já o [plano:61](/private/tmp/claude-501/auditV/docs/phase-vision-v1.md:61) posiciona o ramo de visão depois da confirmação.

   **GRAVIDADE:** ALTA / **CONFIANÇA:** Alta.  
   **AÇÃO:** Determinar a proveniência antes da primeira inserção, independentemente do roteamento. Guardá-la no turno e nas frases emitidas, preservando-a até `markPlayed`, inclusive depois de `activeTurn=null`. Cobrir reprompt, erro, reprodução parcial e confirmação tardia.

4. **ACHADO:** “Contém a marca explícita” aceita negação ou mera citação como autorização.

   **EVIDÊNCIA:** O [plano:57](/private/tmp/claude-501/auditV/docs/phase-vision-v1.md:57) autoriza por presença de expressões como “com o gemini” e “na nuvem”. Pela regra escrita, **“olha essa tela, mas não usa o Gemini”** satisfaz tanto o filtro de tela quanto a marca de nuvem. O plano só exige testes positivos/negativos para `mightBeScreenQuery`, não para o consentimento: [plano:107](/private/tmp/claude-501/auditV/docs/phase-vision-v1.md:107).

   **GRAVIDADE:** ALTA / **CONFIANÇA:** Alta.  
   **AÇÃO:** Especificar uma gramática afirmativa de autorização, com negação e ambiguidade bloqueando o envio. Testar citações, explicações sobre o comando e frases contraditórias. Vincular a autorização à transcrição daquele turno, nunca ao OCR ou ao histórico.

5. **ACHADO:** A janela de continuação de 90 segundos não constitui uma fronteira para descrições derivadas da tela; intenção em nuvem e memória continuam sendo saídas independentes.

   **EVIDÊNCIA:** A continuidade deixa de valer por tempo ou fim do compartilhamento no [plano:55](/private/tmp/claude-501/auditV/docs/phase-vision-v1.md:55). Fora desse ramo, `detectIntent` recebe a fala atual diretamente em [sessionManager.ts:489](/private/tmp/claude-501/auditV/src/backend/voice/sessionManager.ts:489), enviada ao Gemini em [worker.py:1069](/private/tmp/claude-501/auditV/scripts/worker/worker.py:1069). `windowHistory` não participa desse envio. Além disso, o bloco de memórias é construído separadamente e incorporado ao sistema em [sessionManager.ts:658](/private/tmp/claude-501/auditV/src/backend/voice/sessionManager.ts:658). O plano só adiciona origem a `ConversationMessage`.

   Um usuário pode retomar ou ditar uma informação lida na tela depois desses 90 segundos; a política proposta não preserva essa proveniência.

   **GRAVIDADE:** ALTA / **CONFIANÇA:** Alta quanto aos caminhos; média quanto ao reconhecimento de uma fala concreta.  
   **AÇÃO:** Definir quando termina o contexto protegido e aplicar a política antes de qualquer detector externo. Especificar a proveniência de conteúdo salvo em memória e sua filtragem na montagem do prompt. Não tratar expiração temporal como autorização de saída.

6. **ACHADO:** O protocolo de quadro não especifica correlação suficiente nem consumo único; token de sessão não protege contra quadro obsoleto ou duplicado.

   **EVIDÊNCIA:** O [plano:43](/private/tmp/claude-501/auditV/docs/phase-vision-v1.md:43) inclui `turnId` no SSE, mas não define o identificador obrigatório no POST, a reserva pendente, nem sua transição após consumo. Novos áudios substituem o turno em [sessionManager.ts:330](/private/tmp/claude-501/auditV/src/backend/voice/sessionManager.ts:330), e cancelamentos invalidam o turno em [sessionManager.ts:955](/private/tmp/claude-501/auditV/src/backend/voice/sessionManager.ts:955). Autorizar a sessão apenas verifica ID/token: [sessionManager.ts:295](/private/tmp/claude-501/auditV/src/backend/voice/sessionManager.ts:295).

   **GRAVIDADE:** ALTA / **CONFIANÇA:** Alta.  
   **AÇÃO:** Definir solicitação de uso único vinculada a sessão, turno, identificador de captura e prazo. Consumir atomicamente; rejeitar POST sem solicitação, duplicado, expirado ou de turno cancelado. Revalidar depois de ler/validar o corpo e antes de despachar ao worker. `{unavailable:true}` deve obedecer à mesma correlação.

7. **ACHADO:** Reutilizar o padrão atual de upload pode gravar imagens antes da autorização e recriar diretórios depois do encerramento.

   **EVIDÊNCIA:** A rota de áudio grava o arquivo em [routes.ts:171](/private/tmp/claude-501/auditV/src/backend/voice/routes.ts:171) e só depois chama `submitAudio`, que autentica em [sessionManager.ts:326](/private/tmp/claude-501/auditV/src/backend/voice/sessionManager.ts:326). A resposta de sessão inválida não apaga o arquivo: [routes.ts:175](/private/tmp/claude-501/auditV/src/backend/voice/routes.ts:175). `AudioStore.dirFor` cria/recria diretórios em [audioStore.ts:22](/private/tmp/claude-501/auditV/src/backend/voice/audioStore.ts:22). O [plano:45](/private/tmp/claude-501/auditV/docs/phase-vision-v1.md:45) prevê upload associado à sessão e armazenamento nesse componente.

   **GRAVIDADE:** ALTA / **CONFIANÇA:** Alta.  
   **AÇÃO:** Autenticar e reservar a solicitação antes de alocar armazenamento. Impedir novas gravações após encerramento; remover arquivos em toda rejeição ou perda de validade durante o upload.

8. **ACHADO:** O limite de áudio não valida uma imagem nem garante que a captura legítima caiba no upload.

   **EVIDÊNCIA:** O [plano:44](/private/tmp/claude-501/auditV/docs/phase-vision-v1.md:44) combina PNG de até 1280 px com o limite de áudio, que é **2 MiB** em [voiceProtocol.ts:110](/private/tmp/claude-501/auditV/src/shared/voiceProtocol.ts:110). A leitura binária só limita bytes: [routes.ts:61](/private/tmp/claude-501/auditV/src/backend/voice/routes.ts:61); a validação adicional existente é específica de WAV: [routes.ts:161](/private/tmp/claude-501/auditV/src/backend/voice/routes.ts:161). Em reprodução local, um PNG RGB de alta entropia com 1280×1280 requer aproximadamente **4,92 MB**.

   **GRAVIDADE:** ALTA / **CONFIANÇA:** Alta.  
   **AÇÃO:** Especificar formato e schema, assinatura/decodificação válida, dimensões, pixels e memória descomprimida máximos, além de prazo e concorrência do upload. Ajustar a captura até satisfazer o limite real de bytes. Não confiar no redimensionamento feito pelo cliente.

9. **ACHADO:** “Apagar após a resposta” deixa sem definição cancelamento, falha, timeout e término sem resposta; a varredura existente não resolve resíduos do processo vivo.

   **EVIDÊNCIA:** A retenção é descrita no [plano:48](/private/tmp/claude-501/auditV/docs/phase-vision-v1.md:48). `cancelTurn` cancela operações, mas não limpa arquivos: [sessionManager.ts:942](/private/tmp/claude-501/auditV/src/backend/voice/sessionManager.ts:942). A limpeza de sessão é best-effort em [audioStore.ts:54](/private/tmp/claude-501/auditV/src/backend/voice/audioStore.ts:54). A varredura ignora o diretório do próprio processo em [tmpSweeper.ts:112](/private/tmp/claude-501/auditV/src/backend/voice/tmpSweeper.ts:112) e preserva instâncias vivas.

   **GRAVIDADE:** ALTA / **CONFIANÇA:** Alta.  
   **AÇÃO:** Definir propriedade do arquivo e limpeza idempotente em `finally` para todas as saídas, inclusive upload rejeitado e worker reiniciado. Coordenar a exclusão com a leitura pelo worker. Explicitar também a retenção dos WAVs que contêm a descrição da tela.

10. **ACHADO:** O cancelamento existente não alcança comandos aguardando na fila; reutilizá-lo permite trabalho obsoleto e potencial envio depois do cancelamento.

    **EVIDÊNCIA:** `handle_cancel` só marca `_current` e sínteses registradas: [worker.py:822](/private/tmp/claude-501/auditV/scripts/worker/worker.py:822). A fila mantém comandos em [worker.py:1490](/private/tmp/claude-501/auditV/scripts/worker/worker.py:1490). Ao executar geração, um handle novo é criado em [worker.py:1290](/private/tmp/claude-501/auditV/scripts/worker/worker.py:1290); a chamada Gemini ocorre em [worker.py:1325](/private/tmp/claude-501/auditV/scripts/worker/worker.py:1325), antes da verificação de cancelamento durante o stream. Reproduzi localmente: o comando permaneceu na fila após `cancel`, e o novo handle nasceu não cancelado. O [plano:67](/private/tmp/claude-501/auditV/docs/phase-vision-v1.md:67) pressupõe reutilizar esse mecanismo.

    **GRAVIDADE:** ALTA / **CONFIANÇA:** Alta.  
    **AÇÃO:** Registrar cancelamento desde o despacho, incluindo comandos enfileirados, e verificar validade antes de carregar a imagem/modelo e imediatamente antes da chamada externa. Descartar uma resposta no Node não desfaz um envio.

11. **ACHADO:** A cancelabilidade do MLX-VLM e o bloqueio da fila não estão demonstrados; resolver a Promise no Node não libera o worker.

    **EVIDÊNCIA:** O [plano:66](/private/tmp/claude-501/auditV/docs/phase-vision-v1.md:66) promete cancelamento sem especificar API ou pontos de interrupção. O código local existente verifica cancelamento entre respostas de `stream_generate`: [worker.py:898](/private/tmp/claude-501/auditV/scripts/worker/worker.py:898). `work_loop` executa inclusive STT serialmente: [worker.py:1442](/private/tmp/claude-501/auditV/scripts/worker/worker.py:1442). No Node, `cancel` resolve localmente e considera o comando ao worker apenas uma otimização: [mlxWorkerEngine.ts:677](/private/tmp/claude-501/auditV/src/backend/voice/mlxWorkerEngine.ts:677). `transcribe` não tem timeout próprio nem `turnId`: [mlxWorkerEngine.ts:415](/private/tmp/claude-501/auditV/src/backend/voice/mlxWorkerEngine.ts:415).

    **GRAVIDADE:** ALTA / **CONFIANÇA:** Alta quanto à lacuna; o tempo efetivo exige medição.  
    **AÇÃO:** Demonstrar cancelamento durante carga, processamento da imagem, prefill e geração. Medir até o próximo STT conseguir executar; estabelecer watchdog e recuperação para operações que não cooperem. Não equiparar reconhecimento do comando `cancel` à interrupção da inferência.

12. **ACHADO:** O cliente não oferece interrupção imediata nos estados em que a visão estará capturando ou aquecendo.

    **EVIDÊNCIA:** O [plano:68](/private/tmp/claude-501/auditV/docs/phase-vision-v1.md:68) usa `aquecendo`. O VAD só dispara `triggerBargeIn` em `falando`: [voice.ts:190](/private/tmp/claude-501/auditV/src/frontend/voice.ts:190). A interrupção manual também só funciona nesse estado: [voice.ts:376](/private/tmp/claude-501/auditV/src/frontend/voice.ts:376), e o botão fica desabilitado nos demais: [main.ts:271](/private/tmp/claude-501/auditV/src/frontend/main.ts:271). Durante processamento, a nova fala só preempta quando seu áudio chega ao servidor.

    **GRAVIDADE:** ALTA / **CONFIANÇA:** Alta.  
    **AÇÃO:** Permitir cancelar captura, espera de quadro, carga e inferência. Invalidar imediatamente solicitações e uploads associados. Testar barge-in antes de existir qualquer áudio de resposta, não apenas durante reprodução.

13. **ACHADO:** O aviso “Mandando a tela” não tem uma barreira que assegure ser ouvido antes do envio.

    **EVIDÊNCIA:** O [plano:78](/private/tmp/claude-501/auditV/docs/phase-vision-v1.md:78) promete falar antes de enviar. `synthesizeSentence` só produz e anuncia áudio: [sessionManager.ts:827](/private/tmp/claude-501/auditV/src/backend/voice/sessionManager.ts:827). A reprodução acontece depois no navegador; seu reconhecimento só é enviado em [voice.ts:366](/private/tmp/claude-501/auditV/src/frontend/voice.ts:366). A função `markPlayed` devolve um booleano, sem mecanismo de espera para esse aviso: [sessionManager.ts:892](/private/tmp/claude-501/auditV/src/backend/voice/sessionManager.ts:892).

    **GRAVIDADE:** ALTA / **CONFIANÇA:** Alta.  
    **AÇÃO:** Definir reconhecimento específico do aviso, prazo e comportamento quando houver cancelamento ou falha de reprodução. Revalidar o turno antes de enviar. Atualizar “Imagem enviada” a partir do evento real de despacho, sem anunciar sucesso apenas porque a captura começou.

14. **ACHADO:** Instalar `mlx-vlm` não provisiona o modelo necessário para funcionar no runtime offline.

    **EVIDÊNCIA:** O [plano:69](/private/tmp/claude-501/auditV/docs/phase-vision-v1.md:69) prevê dependência nova e carga sob demanda, mas não explicita download/materialização do modelo. O processo força `HF_HUB_OFFLINE=1` e `TRANSFORMERS_OFFLINE=1`: [mlxWorkerEngine.ts:181](/private/tmp/claude-501/auditV/src/backend/voice/mlxWorkerEngine.ts:181). O carregamento existente só provisiona os componentes de texto/STT: [worker.py:791](/private/tmp/claude-501/auditV/scripts/worker/worker.py:791). O spike descrito ocorreu fora do ambiente do app: [plano:20](/private/tmp/claude-501/auditV/docs/phase-vision-v1.md:20).

    **GRAVIDADE:** ALTA / **CONFIANÇA:** Alta.  
    **AÇÃO:** Incluir no setup modelo, processador/tokenizer, cache correto e revisão definida. Validar instalação limpa seguida de operação sem rede. Medir carga do disco e estabelecer timeout próprio; download do spike não comprova esse percurso.

15. **ACHADO:** `redact` não protege conteúdo de tela em logs e exceções.

    **EVIDÊNCIA:** O [plano:75](/private/tmp/claude-501/auditV/docs/phase-vision-v1.md:75) reutiliza o tratamento existente. `redact` mascara chaves/credenciais, não texto arbitrário: [worker.py:385](/private/tmp/claude-501/auditV/scripts/worker/worker.py:385). `safe_exc` conserva os primeiros 160 caracteres da mensagem após essa máscara: [worker.py:404](/private/tmp/claude-501/auditV/scripts/worker/worker.py:404). Linhas inválidas do protocolo também são registradas com conteúdo: [mlxWorkerEngine.ts:250](/private/tmp/claude-501/auditV/src/backend/voice/mlxWorkerEngine.ts:250). Reproduzi a preservação integral de um marcador comum de conteúdo de tela tanto em `redact` quanto em `safe_exc`.

    **GRAVIDADE:** MÉDIA / **CONFIANÇA:** Alta.  
    **AÇÃO:** Usar erros estruturados sem imagem, pergunta, OCR ou resposta; desativar saída textual de bibliotecas e testar stdout/stderr. **Não encontrei evidência de envio desses logs ao Gemini**; o risco demonstrado aqui é exposição/retenção local.

16. **ACHADO:** A continuação automática captura qualquer próxima fala e interfere nas mutações; o estado necessário para encerrá-la também não está especificado.

    **EVIDÊNCIA:** O [plano:55](/private/tmp/claude-501/auditV/docs/phase-vision-v1.md:55) trata a fala seguinte como tela apenas por proximidade temporal e compartilhamento ativo. Como esse ramo precederá ferramentas, pode absorver pedidos independentes de nota, memória ou hora, hoje tratados em [sessionManager.ts:504](/private/tmp/claude-501/auditV/src/backend/voice/sessionManager.ts:504). Com confirmação pendente, uma fala ambígua pode **rearmar** a mutação anterior: [sessionManager.ts:410](/private/tmp/claude-501/auditV/src/backend/voice/sessionManager.ts:410), contrariando a leitura literal de “fala sobre a tela nunca arma mutação” em [plano:106](/private/tmp/claude-501/auditV/docs/phase-vision-v1.md:106). O protocolo existente não comunica estado de compartilhamento: [voiceProtocol.ts:83](/private/tmp/claude-501/auditV/src/shared/voiceProtocol.ts:83).

    **GRAVIDADE:** MÉDIA / **CONFIANÇA:** Alta.  
    **AÇÃO:** Definir precedência e saída explícita da continuação; distinguir nova mutação de reprompt de uma confirmação existente. Especificar comunicação de compartilhamento encerrado/trocado, descarte de capturas pendentes e parada do stream em teardown/preempção. Testar essas transições com `armedMutation`, `pendingMutation` e `/played` tardio.

17. **ACHADO:** Os critérios de aceite permitem aprovar uma implementação que vaza descrições, não cancela efetivamente e tem desempenho impraticável.

    **EVIDÊNCIA:** Em [plano:101](/private/tmp/claude-501/auditV/docs/phase-vision-v1.md:101), HV.2 verifica apenas **bytes de imagem**; HV.4 verifica apenas mensagens marcadas. HV.6 não estabelece tempo para liberar o worker. HV.9 exige somente registrar latência aquecida, sem teto; entretanto, a mitigação de memória remete a esse mesmo critério em [plano:114](/private/tmp/claude-501/auditV/docs/phase-vision-v1.md:114). A promessa de descarregar após dez minutos, [plano:69](/private/tmp/claude-501/auditV/docs/phase-vision-v1.md:69), também não tem teste; o loop atual bloqueia indefinidamente em `queue.get()`: [worker.py:1444](/private/tmp/claude-501/auditV/scripts/worker/worker.py:1444).

    **GRAVIDADE:** ALTA / **CONFIANÇA:** Alta.  
    **AÇÃO:** Exigir critérios que falhem objetivamente:
    - Marcadores de conteúdo da tela ausentes de **todos** os corpos Gemini: visão, geração, intenção e TTS; incluir memórias e histórico anteriormente autorizado.
    - Matriz mestre/canais/frase, incluindo negação, cancelamento e falha.
    - POST tardio, duplicado, concorrente, após timeout e após troca de sessão.
    - Prazos máximos para cancelamento, próximo STT, carga fria e primeiro áudio; pico de memória com os modelos coexistindo.
    - Descarregamento realmente observado sem novos comandos e limpeza verificada em todas as saídas.
    - Mutações dos testes removendo cada barreira relevante, não só o filtro de histórico.

**Veredito: REFAZER.**