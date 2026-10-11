# Análise Comparativa de Transporte da Ponte OpenClaw — Decisão D15

## Contexto

A Fase 15.transforma o `SessionManager` em um **coordenador de subagentes**. A ponte OpenClaw (`OpenClawSubAgent` em `src/backend/agents/openClawSubAgent.ts`) permite delegar tarefas a agentes externos do OpenClaw. O mecanismo de transporte exato ainda não foi confirmado (§4.2 do `docs/phase-15-v3.md`).

**Restrições críticas:**
- O app roda em `exec-mobile` **sem acesso nativo ao gateway desktop**
- LAT2/H6 da Fase 14 dependeram de OpenClaw equipados e **quebrariam** se o transporte depender de gateway acoplado
- O código fonte `src/backend/agents/openClawSubAgent.ts` existe, mas o cliente real não é construído em `SessionManager`

---

## Opções de Transporte

### Opção A: HTTP Local ao Gateway do OpenClaw

- **Mecanismo**: `fetch()` ou `undici` para `http://127.0.0.1:PORT/api/...` com autenticação via token de gateway
- **Variáveis de ambiente**: `RODRIGO_OPENCLAW_GATEWAY_URL` (padrão: `http://127.0.0.1:PORT`) + `RODRIGO_OPENCLAW_GATEWAY_TOKEN`
- **Assinatura do `invoke`**: `(agentId: string, prompt: string, signal: AbortSignal) => Promise<string>`
- **Vantagens**:
  - Não depende de binários externos ou caminhos de arquivo
  - Funciona em `exec-mobile` onde não há garantia de CLI/MCP instalado
  - Comunicação direta, sem overhead de processo filho
  - Compatível com a arquitetura cliente-servidor já usada pelo app (voice routes usam `http://localhost:3000/api/...`)
- **Riscos**:
  - Exige que o gateway OpenClaw esteja **sempre rodando** no mesmo máquina/porta
  - Se o gateway cair, todas as delegações falham
  - Em `exec-mobile`, a porta pode variar entre reinicializações
  - Necessita de variáveis de ambiente configuradas no ambiente de produção

### Opção B: CLI/MCP Local do OpenClaw via `child_process`

- **Mecanismo**: `spawn()` do CLI do OpenClaw ou uso do MCP (Model Control Protocol), análogo ao que o app já faz com `notebooklm`/`deepseek`/`agy`
- **Assinatura do `invoke`**: envolve execução de processo filho, pipe de stdio, possível protocolo de mensagens
- **Vantagens**:
  - Não depende de um gateway HTTP separado rodando
  - Pode ser mais resiliente — o CLI pode ser auto-contido
  - Compatível com o padrão existente de "ferramentas CLI" no próprio códigobase (agy, deepseek, notebooklm via `child_process`)
- **Riscos**:
  - **Quebra crítica em `exec-mobile`**: o ambiente mobile pode não ter o CLI do OpenClaw instalado nem no PATH
  - **LAT2/H6 da Fase 14 dependem de OpenClaw equipados** — se o transporte exigir gateway/CLI acoplado, esses modos deixam de funcionar
  - Overhead de spawn/processo filho — maior latência, risco de process zombies
  - Mais difícil garantir cancelamento cooperativo via `AbortSignal` (os processos filhos não respondem automaticamente a sinais)
  - Em `exec-mobile`, caminhos de arquivo e disponibilidade de binários são incertos

---

## Comparativo Direto

| Critério | Opção A: HTTP Gateway | Opção B: CLI/MCP |
|---|---|---|
| **Compatibilidade `exec-mobile`** | ✅ Funciona se gateway acessível via localhost | ❌ Falha se CLI/MCP não instalado no mobile |
| **Dependência LAT2/H6 (F14)** | ✅ Gateway pode ser compartilhado/isolado | ❌ Quebra se exigir binário local/OpenClaw acoplado |
| **Implementação no código** | ✅ Apenas URL + token em env vars; `openClawClient.invoke` já definido em `openClawSubAgent.ts:17` | ❌ Necessita novo código de `spawn` + protocolo de mensagens |
| **Cancelamento `AbortSignal`** | ✅ Nativo — o sinal é passado para `fetch()`/`undici` | ❌ Requer implementação customizada no CLI |
| **Observabilidade/Logs** | ✅ HTTP status codes, response bodies | ❌ Saída depends de formatação do CLI |
| **Resiliência a falhas** | ✅ Tratamento de erro padrão via try/catch do `invoke` | ❌ Erros dependem do código de saída do CLI |
| **Padroes existentes no app** | ✅ Já se usa HTTP para voice routes, TTS, visão | ⚠️ Padrão misturado — alguns usos via CLI, outros via HTTP |

---

## Recomendação

**Selecionar a Opção A (HTTP Local ao Gateway do OpenClaw)**.

### Justificativa:

1. **Compatibilidade com `exec-mobile`**: A Opção A é a única que garante funcionamento em ambiente mobile onde binários externos não são garantidos. O gateway HTTP pode ser executado como um serviço local que o mobile consegue alcançar via `127.0.0.1`.

2. **Preservação de LAT2/H6**: A Opção A permite que o gateway seja um serviço isolado ou até mesmo rodando em container/docker no host, sem depender de binários "OpenClaw equipados" no caminho do mobile. Isso evita a quebra dos modos da Fase 14.

3. **Menor mudança de código**: O `OpenClawSubAgent.ts` já define a assinatura `invoke: (agentId: string, prompt: string, signal: AbortSignal) => Promise<string>`. Basta implementar o cliente que faz `fetch()` para o gateway, passando o `signal` para cancelamento cooperativo. Não é necessário adicionar `spawn`, protocolo customizado ou lógica de processo filho.

4. **Padrão consistente com o app**: O app já usa HTTP para todas as comunicações internas (voice routes, TTS, visão, Gemini API). Manter o transporte OpenClaw como HTTP mantém consistência arquitetônica.

5. **Flexibilidade**: As variáveis de ambiente `RODRIGO_OPENCLAW_GATEWAY_URL` e `RODRIGO_OPENCLAW_GATEWAY_TOKEN` seguem o mesmo padrão já usado pelo projeto (`CLIENT_PORT`, `PORT` em `config.ts`), tornando a configuração transparente.

### Riscos Mitigados:

- **Gateway cair**: O `openClawSubAgent.ts` já tem fallback mock (línea 33-38) que retorna sucesso falso quando `openClawClient` não está presente. Isso deve ser mantido/aperfeiçoado para retornar erro honesto quando o gateway estiver fora do ar.
- **Porta variável**: O gateway URL pode ser lido de env no momento do início do app, permitindo diferentes portas por ambiente.
- **Mobile não ter gateway**: O fallback garante que o app continue funcionando (em modo degradado) se o gateway não estiver disponível.

### Próximos Passos (depois da decisão D15):

1. Criar o cliente HTTP real que implementa `openClawClient.invoke()` fazendo `fetch()` para o gateway URL + token de auth
2. Integrar esse cliente na criação do `OpenClawSubAgent` no `SessionManager` (Fatia 3)
3. Manter o fallback mock quando o cliente não for fornecido
4. Implementar os modos síncrono/assíncrono (`invokeShort`/`invokeLongAsync`) e o poller (§4.3 de `phase-15-v3.md`)
5. Persistir tarefas assíncronas em `data/` com o schema `PendingAsyncTask` (§4.4)

---

## Decisão D15 (Resumo)

**Transport escolhido: HTTP local ao gateway do OpenClaw** (Opção A).

- Fundamentado na incompatibilidade da Opção B com `exec-mobile` e o risco de quebra de LAT2/H6 da Fase 14.
- A Opção A alinha-se ao padrão HTTP já usado em todo o app e permite que o gateway seja um serviço independente do cliente mobile.
- A decisão não escreve código nem modifica o transporte existente — apenas define a direção para a implementação da Fatia 3.