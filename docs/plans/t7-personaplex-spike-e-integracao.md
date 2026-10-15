# Plano T7: Spike e Integração do NVIDIA PersonaPlex (Voz Full-Duplex Local)

- **Status:** PLANO DE IMPLEMENTAÇÃO E VERIFICAÇÃO DE GATES (Proposto)
- **Origem:** Solicitação do usuário ("implemente PersonalPlex")
- **Arbitragem Prévia:** JEV System One (100.0% de confiança para `escrever_plano_e_validar_gates`)
- **Alvo:** Integração experimental do modelo NVIDIA PersonaPlex 7B no assistente Rodrigo AI (macOS Apple Silicon M5, 16 GB RAM)

---

## 1. Contexto e Conceito

O **NVIDIA PersonaPlex** é um modelo de conversação por voz *full-duplex speech-to-speech* fim-a-fim de 7B parâmetros (baseado na arquitetura Moshi / Kyutai). Ao contrário do pipeline atual do Rodrigo AI (VAD -> Whisper STT local -> Gemini LLM -> TTS), o PersonaPlex:
1. **Ouve e fala simultaneamente** em tempo real com baixíssima latência acústica.
2. Suporta interrupções naturais (*barge-in*) e *backchannels* ("hum", "entendi") sem quebra de estado de turno.
3. Não possui, nativamente, separação textual de raciocínio, nem suporte a chamadas de ferramentas (*tool-calling*) determinísticas.

Por essa razão estrutural, a integração com o Rodrigo AI segue estritamente a decisão do plano v2.6 (§3.7): **Modo "Papo" Livre**, isolado do motor transacional de comandos, sem capacidade de gerar mutações em `lembretes.json`, `notas.json` ou `memorias.json`.

---

## 2. Diagnóstico dos Critérios de Entrada (Gates G1 a G5)

| Gate | Requisito | Diagnóstico no Hardware e Ambiente Atual | Condição de Execução |
|---|---|---|---|
| **G1** | Suporte a Português do Brasil | O modelo base oficial foi treinado no corpus *Fisher English* (1.217 h). Testes preliminares da comunidade indicam que fala em português resulta em respostas truncadas ou sotaque fonético misto. | **Fase 1 (Spike):** Testar primeiro em inglês para validar a dinâmica acústica e memória; avaliar viabilidade de condicionamento acústico/prompting em PT-BR. |
| **G2** | Suporte ao Hardware (Mac M5) | O servidor oficial da NVIDIA exige PyTorch com CUDA (Linux x86/GPU). No macOS (MacBook Air M5, 16 GB RAM), a execução viável exige o porte comunitário em **MLX** (`mu-hashmi/personaplex-mlx`) com pesos quantizados em **4 bits** (`aufklarer/PersonaPlex-7B-MLX-4bit`), consumindo ~4 a 5 GB de memória unificada. | Instalar dependências MLX em ambiente virtual isolado (`.runtime/personaplex-env`), preservando a RAM restante para o sistema e o app. |
| **G3** | Garantias e Isolamento | Modo "Papo" estritamente conversacional. Nenhuma chamada de ferramenta, nenhuma escrita em disco de dados do usuário e sem acesso ao `JsonStore`. | O backend só roteia áudio para o PersonaPlex quando o modo for ativado explicitamente na UI/atalho. |
| **G4** | Licença dos Pesos (NVIDIA Open Model) | Os pesos oficiais estão sob a *NVIDIA Open Model License* no Hugging Face (`nvidia/personaplex-7b-v1`) e exigem aceite manual na web. Não havia `HF_TOKEN` no ambiente. | **Ação do Usuário:** Aceitar a licença no Hugging Face e fornecer o `HF_TOKEN` para download dos checkpoints quantizados. |
| **G5** | Zero Egress de Áudio | O áudio do microfone deve circular exclusivamente entre o navegador/painel local (`127.0.0.1`) e o processo local do PersonaPlex. Nenhum pacote de áudio sai da máquina. | Validado via suíte de testes de rede local / inspeção de sockets com `lsof` e `nettop`. |

---

## 3. Arquitetura da Solução

```
[ Frontend / Painel Desktop ]
            │  (WebSocket Full-Duplex / PCM ou Opus)
            ▼
[ Backend Node: src/backend/voice/routes.ts ]
            │  (Roteamento por Modo de Sessão)
            ├──────────────┬───────────────────────────────┐
            ▼              ▼                               ▼
     [ Modo Comando ] [ Modo Papo (PersonaPlex) ]    [ Outbound Guard ]
     (Whisper +      (Daemon Local MLX              (Zero Egress
      Gemini + TTS)   127.0.0.1:8998)                Garantido)
```

1. **Daemon PersonaPlex MLX (`scripts/personaplex/daemon.py`):**
   - Roda como subprocesso independente gerenciado pelo runtime ou serviço local de loopback na porta `127.0.0.1:8998`.
   - Utiliza a biblioteca `mlx` e `mlx-lm` com o modelo `aufklarer/PersonaPlex-7B-MLX-4bit`.
   - Expõe uma interface WebSocket bidirecional para streaming contínuo de frames de áudio PCM 24kHz / 16-bit.
2. **Integração no Backend Node (`src/backend/voice/personaplexBridge.ts`):**
   - Cria o cliente de ponte com o daemon local.
   - Alternância de modo de sessão: `session.mode = 'command' | 'personaplex'`.
   - Se o modo for `personaplex`, desativa a fila de geração do Gemini e o STT Whisper, roteando os chunks de áudio recebidos pelo WebSocket diretamente para o daemon local.
3. **Frontend (`src/frontend/voice.ts` e `index.html`):**
   - Botão seletor ou atalho para alternar para "Modo Papo (PersonaPlex)".
   - Reprodução em buffer contínuo (Web Audio API `AudioWorklet` / `AudioContext`) para playback sem engasgos do stream recebido.

---

## 4. Fases de Execução

### Fase 0: Setup do Ambiente e Dependências (Spike Isolado)
1. Criar ambiente virtual Python isolado em `.runtime/personaplex-env/` (não poluir o `.runtime/.venv` do worker existente).
2. Instalar `mlx`, `mlx-lm`, `huggingface_hub`, `scipy`, `soundfile`.
3. Validar se o `HF_TOKEN` do usuário está presente e com acesso ao repositório autorizado.

### Fase 1: Validação Técnica do Modelo no Mac M5 (Benchmark Offline)
1. Baixar os pesos quantizados de 4-bit para o cache local (`~/.cache/huggingface/hub/`).
2. Executar teste offline de inferência WAV-to-WAV:
   - Entrada: Amostra curta em inglês e amostra curta em português.
   - Medir: Consumo de memória RAM (meta: < 6 GB), latência do primeiro frame de áudio (TTFT acústico), tempo real x tempo de geração (*Real-Time Factor* - RTF < 1.0 no M5).
   - Avaliar a inteligibilidade do modelo ao receber entrada em português.

### Fase 2: Implementação do Daemon e do Bridge WebSocket
1. Implementar `scripts/personaplex/daemon.py` com interface assíncrona local (loopback).
2. Implementar `src/backend/voice/personaplexBridge.ts` e suíte de testes unitários com mocks de WebSocket.
3. Adicionar validação no `src/backend/doctor.ts` para verificar disponibilidade do PersonaPlex.

### Fase 3: Auditoria Adversarial e Verificação de Segurança
1. Rodar auditoria adversarial de código com `codex exec -s read-only` ou `gemini -m gemini-2.5-pro`.
2. Validar que nenhuma mutação pode ser disparada durante o modo PersonaPlex.
3. Teste de isolamento de rede: garantir que conexões externas para áudio permaneçam estritamente bloqueadas.

---

## 5. Decisões Pendentes do Rodrigo

1. **Aceite da Licença:** Você aceita a licença *NVIDIA Open Model License* no Hugging Face para o download dos pesos do modelo?
2. **Fornecimento do Token:** Configurar a variável `HF_TOKEN` no terminal para autorizar o download.
3. **Aceite do Idioma na Fase 1:** Concorda em conduzir o Spike inicial (Fase 1) em inglês para validar desempenho e estabilidade de memória no Apple M5 antes de avaliar o comportamento em português?
