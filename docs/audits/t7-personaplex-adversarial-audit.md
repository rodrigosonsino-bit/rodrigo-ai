## Veredito: **BLOQUEADO**

O plano não pode avançar como está. As Fases 2 e 3 colocam código no app antes de G1 ter evidência, e isso viola a regra do próprio plano-mãe (v2.6 §3.7: "Sem código no app antes de G1–G5 e do aval"). Há também duas falhas de segurança altas no desenho da integração. O spike offline (Fases 0 e 1) pode rodar como experimento isolado, desde que A4 a A7 sejam corrigidos antes.

**O que não consegui verificar:** a busca na web foi negada nesta sessão. Então a existência e o conteúdo de `mu-hashmi/personaplex-mlx` e `aufklarer/PersonaPlex-7B-MLX-4bit`, a licença e o desempenho real no M5 continuam sendo suposições do plano.

## Achados

**Altos**
- **A1 – Processo / G1.** "Testar em inglês primeiro" mede velocidade e memória, mas não diz nada sobre o português. E o próprio diagnóstico do plano (treino em Fisher English, respostas truncadas em PT) é evidência *contra* G1. Mesmo assim, a Fase 2 já monta o daemon e a ponte com o app.
- **A2 – G3/G5: daemon sem autenticação.** O daemon escuta em `127.0.0.1:8998` sem nenhuma autenticação. WebSocket não tem proteção de CORS, então qualquer página aberta no Chrome, ou qualquer processo local, pode se conectar ao modelo. Melhor usar stdio/NDJSON ou socket Unix com permissão 600, como o worker atual já faz.
- **A3 – Arquitetura: o WebSocket não existe e furaria a validação de Host.**
  - Hoje o transporte é POST + SSE (`src/backend/voice/routes.ts:120-286`).
  - O `package.json` não tem nenhuma dependência de runtime, então o `ws` entraria como dependência nova, e isso exige plano, aval e auditoria.
  - No Node, o evento `upgrade` não passa pelo `handler` de `src/backend/server.ts:172`. Ou seja, `isAllowedHost` não rodaria para o WebSocket.
- **A4 – G4 e cadeia de suprimento.** Os pesos de 4 bits são uma requantização feita por terceiro. Aceitar a licença da NVIDIA não cobre essa redistribuição nem prova que o arquivo é o modelo original. O porte MLX é código comunitário não auditado e vai rodar com acesso ao microfone. O plano precisa exigir:
  - commit ou hash fixado;
  - só arquivos `safetensors`;
  - leitura do código do porte antes de rodar;
  - checar se esse repositório sequer pede `HF_TOKEN`. Se não pede, a decisão 2 do plano não autoriza nada.

**Médios**
- **A5 – Viabilidade no M5 16 GB.** A estimativa de "4–5 GB" ignora o codec Mimi, o transformer de profundidade e o cache KV de uma sessão longa. O worker continua com Whisper e Qwen3-4B carregados (e a visão, se ligada); o plano "desativa" o Whisper mas não o descarrega da memória. Os dois processos MLX disputariam a mesma GPU e o mesmo limite de memória do Metal. A meta RTF < 1,0 tem de ser medida com o worker carregado e o painel aberto. Se for um Air, medir também depois de 10 minutos contínuos, por causa do aquecimento.
- **A6 – G5: `lsof`/`nettop` não provam ausência de tráfego.** Eles mostram só um instante. O projeto já tem o padrão certo, que mede no processo (`f12Offline.test.ts`). Depois do download, o daemon também precisa de `HF_HUB_OFFLINE=1`; sem isso, o `huggingface_hub` consulta a rede a cada carga.
- **A7 – Áudio gravado em disco.** O plano não fala em consentimento por sessão nem em "não gravar áudio por padrão". Mas a Fase 1 (WAV de entrada, WAV de saída) grava áudio por natureza. Falta dizer onde ficam esses arquivos e quando são apagados.
- **A8 – G3: troca entre os modos.** Faltam três regras:
  - entrar no modo papo tem de cancelar uma confirmação de mutação pendente;
  - fala ouvida no papo nunca pode chegar ao classificador de confirmação nem ao `markPlayed()`;
  - é preciso decidir se o papo entra no histórico enviado ao Gemini. Se entrar, é transcrição de áudio indo para a nuvem por outro caminho.

  Há ainda uma divergência: a v2.6 pede ativação por comando de voz, o plano fala em interface ou atalho.
- **A9 – Ciclo de vida do processo.** O daemon novo precisa entrar no controle de filhos do `dev.mjs`, no `shutdownAll()` e no `RODRIGO_PARENT_PID`. Os 400 ms antes do `SIGKILL` são pouco para liberar 5 GB ou mais do Metal; já houve um achado igual (v2-6). Também falta dizer como fica a regra de sessão única se o modo comando receber áudio com o papo ativo.

**Baixos**
- **A10 – Painel desktop.** O painel bloqueia `ws://` para qualquer endereço que não seja `127.0.0.1:PORT`. Está certo o áudio passar pelo backend, mas o plano precisa dizer isso. Um atalho direto do frontend para a porta 8998 falharia em silêncio no painel e funcionaria no Chrome, escondendo o A2.
- **A11 – Taxa de amostragem.** O frontend captura a 16 kHz (`src/frontend/voice.ts:180`) e o plano fala em 24 kHz. Não está definido onde a conversão acontece.
- **A12 – Rigor.**
  - "Jev com 100% de confiança" para decidir escrever o plano não serve como base técnica.
  - `gemini-2.5-pro` é um modelo com versão fixa (pode já ter saído de linha) e repete o provedor da geração. Pela regra de rotação, a auditoria de código deveria ser do Hermes.
  - Um modelo Moshi provavelmente não roda com `mlx-lm`; confirmar no repositório do porte.

## Idioma (G1)
A mitigação proposta só adia a pergunta. Condicionar por prompt ou por áudio de referência muda o papel e a voz do modelo, não o quanto ele sabe de português. As saídas reais são três:
1. aceitar inglês no modo papo, o que é decisão sua e contraria G1 como está escrito;
2. continuar monitorando até sair um checkpoint multilíngue, que é o que a v2.6 já prescreve;
3. fazer fine-tuning em PT-BR, o que está fora do alcance do M5.

## Para chegar a APTO COM RESSALVAS
1. Dividir em **T7-spike** (offline, fora do app, com A4 a A7 resolvidos) e **T7-integração**, que só começa se o spike trouxer evidência de G1.
2. Fixar o critério numérico de G1 antes do spike: quantas falas suas em PT-BR e qual taxa de respostas inteligíveis e coerentes, julgadas por você.
3. Na integração:
   - stdio ou socket Unix em vez de porta TCP;
   - validação de Host/Origin no `upgrade`, com um teste que falhe sem ela;
   - regras de troca de modo testadas com mutação;
   - teste de tráfego de saída no padrão `f12Offline`.

---
Não consegui gravar este relatório em `docs/audits/t7-personaplex-adversarial-audit.md`: a escrita foi negada e o arquivo continua vazio. Se você liberar, eu gravo. Não deleguei nada a agentes gratuitos, porque uma auditoria adversarial é exatamente o caso que o seu CLAUDE.md reserva para mim. Task-observer: não registrei nenhuma observação. A varredura do log no início falhou por causa de uma variável no comando, então não li as observações abertas.
