# Ressalvas do Claude Sonnet (reserva) sobre o trabalho de 2026-10-12

Pedido de ORQUESTRADOR_GROK, retransmitido pelo Rodrigo: avaliar o que mudou no `main` em 2026-10-12 (PRs #2 a #5) e dizer ressalvas, riscos e discordâncias, priorizados.
Autor: Claude Sonnet (reserva do orquestrador), sessão de 2026-10-12. Base: `origin/main` em `ccf03ca`.
**Estado deste documento: parecer. Nada foi alterado no código nem na configuração; as ressalvas aguardam decisão do Rodrigo.**

## O que foi lido e o que não foi

Lido: `ESTADO.md`, `PLANO-AUTO-MELHORIA.md`, `PLANO-ESPECIALISTAS-UNIFICADOS.md`, `INCIDENTES.md`, `LICOES.md`, `revisoes/2026-10-12.md`, `README.md`, `src/backend/privacy.ts`, `src/shared/privacyText.ts` e `src/backend/agents/openClawHttpClient.ts`.

**Não verificado:** a configuração do OpenClaw, o script `delegar`, o log do `delegar`, o resultado de qualquer teste (nenhum foi executado) e se o repositório é público.

## Ressalvas, por prioridade

### 1. Alta: o Kimi-K3 via NVIDIA é um provedor de nuvem novo e o cartão de privacidade não o cobre

- O app chama o gateway do OpenClaw em `127.0.0.1:18789` (`openClawHttpClient.ts`). A chamada é local, mas os 6 agentes agora rodam em `nvidia/moonshotai/kimi-k3`, então o texto que o app envia ao OpenClaw acaba num terceiro.
- Em `privacyText.ts`, a única menção ao OpenClaw é a busca web. Não encontrei Kimi, NVIDIA nem Moonshot em `privacyText.ts` nem em `privacy.ts`.
- O `README` §7 e os testes de consistência afirmam "não há fallback para outro provedor" e listam o que vai ao Gemini. Isso passou a ser incompleto.
- **Não verifiquei** se a rota do OpenClaw respeita `RODRIGO_CLOUD=0` e `RODRIGO_SEND_HISTORY=0`. Se não respeitar, é um furo.
- Pelo `CLAUDE.md`, dependência externa nova exige plano, aval do Rodrigo e auditoria.

### 2. Alta: o plano de especialistas manda agentes de nuvem lerem `docs/research/`

- O `CLAUDE.md` diz que `docs/research/` nunca vai a terceiros. No app, `RODRIGO_SEND_KNOWLEDGE` é desligado por padrão, por decisão do Rodrigo (D1).
- O §3.4 do plano cria skills `especialista-<área>` que apontam para `docs/research/…`, anexadas a agentes em Kimi/NVIDIA. Isso contradiz a regra, e o plano não registra o conflito.
- Sugestão: antes de qualquer skill, definir o que um agente de nuvem pode ler. Proposta: só `docs/conhecimento/` (sínteses), nunca `docs/research/`.

### 3. Alta: as áreas novas do classificador só seriam testadas com o motor fake

- O §3.3 lista testes como "cada rótulo seleciona o agente certo" e "não manda pergunta clínica para diagnóstico". Com `FakeVoiceEngine`, isso testa o código de roteamento, não o Qwen-4B.
- O histórico do projeto mostra cobertura real abaixo do previsto: Fase 5b em 75%, Fase 5c em 76,5% e 61,1%, Fase 11 em 63%. Teologia, hermenêutica e exegese são rótulos muito próximos.
- Sugestão: exigir uma matriz de frases coloquiais reais (de preferência áudio real) com limiar antes de aprovar, mantendo "AMBÍGUO cai no Geral" como rede de segurança.

### 4. Média-alta: `fvScreen.test` falha de forma intermitente e já foi normalizado

- `ESTADO.md` e o plano de especialistas escrevem "suíte verde, salvo a intermitência conhecida do fvScreen" (0 a 3 falhas por execução, em HV.3 e "auditoria Kimi K3 achado 5").
- Numa medição anterior, num `HEAD` isolado, houve falhas em 7 de 8 execuções, com HTTP 409 onde o teste esperava 200 ou 400. A causa nunca foi diagnosticada e pode ser corrida real no token de captura de uso único.
- É segurança de captura de tela, e a Fase V Fatia 5 enviará imagem da tela ao Gemini. Sugestão: diagnosticar **antes** da Fatia 5.
- Concordo com o alerta do `ESTADO`: `RODRIGO_CLOUD_VISION` ligado por padrão contraria o princípio da Fase 12 (todo canal de nuvem tem controle explícito). Deve nascer desligado.

### 5. Média: monocultura de modelo e perda de auditores independentes

- Os 6 agentes OpenClaw estão em Kimi-K3, que também é o auditor de código do repositório. O incidente 4 já mostrou esse modelo degenerando.
- `codex` e `agy` saíram da fila `codigo`. A auditoria adversarial do projeto dependia de provedores diferentes (Codex, agy, Hermes, Kimi).
- Autor e auditor da mesma família têm pontos cegos correlacionados. Sugestão: manter ao menos um auditor de outra família para o que for crítico (privacidade, mutações).

### 6. Média: a revisão semanal tem um erro de método

- A tabela se chama "Métricas (7 dias)", mas as fontes citam o log do `delegar` de 2026-10-10 18:22 a 2026-10-11 22:53, cerca de 29 horas, sem chamadas em 2026-10-12.
- A própria revisão admite que cerca de 28 das 39 tarefas de texto foram testes "OK". Isso limita o que "80% concluídas" significa.
- As 3 propostas de fila são razoáveis, mas se apoiam em cerca de um dia de dados. A instrumentação (P2) corrige isso daqui para a frente. Sugestão: não tratar o resultado como tendência.

### 7. Média: sínteses geradas por LLM viram "fonte canônica" sem revisão humana

- `docs/conhecimento/virtologia/sinteses/01-fundamentos.md` traz "Revisão humana pendente", e o plano promove `docs/conhecimento/` a fonte única. A citação `[NB:… · arquivo.pdf]` aponta para uma fonte real do notebook, mas ninguém conferiu se o trecho sustenta a frase.
- Risco maior para Teologia e Virtologia, que já têm prompts escritos à mão e validados com áudio real. Gerar os `profile-source` automaticamente pode piorar o que funciona. O `.bak` e a comparação previstos ajudam; sugestão: tornar a revisão humana pré-condição de ativação.
- Não verifiquei se o repositório é público. Se for, cerca de 155 KB de paráfrase de livros protegidos merece checagem de direitos autorais; `docs/research/` não deve ser a única linha de defesa.

### 8. Baixa: a reserva (Claude Sonnet) nunca foi testada

O `ESTADO.md` diz que login e cota da reserva não foram testados (D3). Enquanto isso não for testado, a reserva é só uma intenção, e o Grok é ponto único de falha. Um teste simples resolve.

### 9. Baixa: a trava de 4 h venceu em 2026-10-12 12:20

Quem não detém a trava não deve alterar o `ESTADO.md` sem renová-la. Este parecer não toca nele.

## Do que concordo

- Log do `delegar` com id de tarefa, modelo e teste; cooldown de 1 h por cota.
- Backup antes de editar configuração; registro de incidentes com lições.
- "Aprovação do Rodrigo antes de aplicar" e "nunca enfraquecer teste".
- A ordem do plano de especialistas: documentos primeiro, código depois da Fase V.

## Pedido principal

Resolver por escrito os itens 1 e 2 (privacidade e `docs/research/`) antes do passo 3 do plano de especialistas (instalar skills no OpenClaw). Os itens 3 e 4 viram critério de aceite das fases seguintes.
