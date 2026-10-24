# Reparo de voz e indicador — v1, 2026-10-15

## Objetivo e evidências
O usuário relata ausência de fala e de indicador verde no desktop. O workspace não tem .env; o servidor e a UI confirmam GEMINI_API_KEY ausente. A instalação principal do MESMO projeto tem .env. Não imprimir nem versionar credenciais. Teste real com WAV sintético de “Que horas são agora?” confirmou STT, ferramenta HORA e áudio de saída HTTP 200 (125976 bytes), sem alterar dados pessoais. Captura acústica pelo desktop ainda não foi comprovada.

VoiceController usa diretamente estados SSE: servidor emite falando antes de sintetizar e ouvindo logo após síntese, sem esperar reprodução. playChunk não define falando, ignora HTTP não-OK e drain ignora exceções. Corrida possível: evento de áudio chega antes da resposta POST definir currentTurnId e é descartado. Cancelamento usa playbackGeneration; preservar garantia de /played apenas após reprodução completa. Há alterações pré-existentes no desktop, frontend e lockfile que devem ser preservadas.

## Escopo limitado e execução
1. Restaurar apenas neste workspace o .env local da instalação principal, modo 0600, sem conteúdo em logs/relatórios. Não mudar provedores, políticas de privacidade ou custos configurados. Reiniciar apenas o app deste workspace (servidor filho encerra junto), com log diagnóstico local temporário. Verificar a configuração sem exibir segredos.
2. Separar estado de geração SSE de reprodução efetiva no frontend. SSE falando significa aguardando resposta; definir falando após source.start bem-sucedido e preservá-lo até onended. Estado entre frases deriva do estado recebido do servidor. Nunca anunciar ouvindo enquanto source está ativo. Preservar interrupção de resposta enquanto geração aguarda áudio e limiar elevado de VAD durante playback.
3. Não descartar áudios que chegam enquanto o POST do turno está pendente: suspender drain até o POST resolver, então filtrar pelo turnId confirmado. Proteger continuação de uploads e reprodução contra encerramento/novo turno; parar fonte anterior quando se inicia novo upload. Não alterar protocolo backend, confirmação de ações nem dados.
4. Exibir erro de download/decodificação/AudioContext suspenso na UI em português e log técnico sem texto da conversa/token. Suprimir erros de operações já canceladas. Limpar fila e buffers VAD ao encerrar. Rejeitar playback se contexto não estiver running após resume.
5. Ajustar ponte desktop: estado efetivo de fala deve prevalecer sobre microfone mutado (mutar entrada não silencia resposta). Ao desmutar usar estado atual e não forçar ouvindo. Corrigir apenas o necessário para estados coerentes; preservar desenho e isolamento de rede. Desativar inspetor de produção que mudança prévia deixou ligado (teste existente exige false).

## Validação
Teste de regressão executável do VoiceController real com WebAudio/fetch/SSE simulados, cobrindo estado SSE ouvindo antes do fim do WAV, erro de decode/HTTP, contexto suspenso, áudio antes do POST e cancelamento durante decode/playback sem /played. Executar typecheck/build, testes backend voz/desktop pertinentes e build Swift. Reabrir app e verificar UI/logs, capturar frase de teste se ambiente permitir. Relatar separadamente evidência de backend, testes simulados e áudio/microfone real; não alegar audição humana. Se captura continuar falhando, investigar antes de declarar concluído e auditar qualquer expansão material.

## Revisão independente
Plano limitado a configuração local, frontend e ponte desktop: perfil frontend/experiência aplicável. Backend/protocolo/dados e IA/fontes/custos não mudam, portanto não demandam parecer separado. Revisar concorrência e /played dentro do perfil pertinente. Veredito explícito requerido antes de implementação.
