# Fase 15 — Orquestrador Autônomo e Coordenador de Subagentes por Voz (plano v1)

Data: 2026-10-09. Autor: Orquestrador. Estado: **rascunho v1 para auditoria**.

## 1. Contexto e Objetivo

A Fase 15 transforma o aplicativo em um **supervisor e coordenador inteligente de subagentes**. Quando o usuário faz um pedido de voz com múltiplos passos (ex.: *"Pesquisa X e salva um lembrete sobre o resultado"*, *"Pede pro revisor checar este texto e me dá um resumo"*), o aplicativo:
1. Decompõe o pedido em um grafo/sequência de tarefas de subagentes.
2. Delega para o subagente certo — especialistas internos (Geral, Teologia, Virtologia, Neurociência), ferramentas de estado (notas, lembretes, memórias) ou **agentes do OpenClaw** (ex.: Revisor, Coder).
3. Respeita a matriz rigorosa de autonomia:
   - **Leitura / Consulta:** Execução autônoma imediata.
   - **Mutação / Alteração:** Sempre exige confirmação de voz verificada (*"Posso salvar o lembrete X?"*).
   - **Ações financeiras / Irreversíveis:** Nunca finaliza sozinho (no máximo prepara rascunho/carrinho).
4. Fala o resultado final verdadeiro, sem inventar sucessos não executados.

---

## 2. Arquitetura do Coordenador de Subagentes

### 2.1 Interface Universal `ISubAgent`
Todos os subagentes (internos e ponte OpenClaw) implementam a mesma interface:
```ts
export interface ISubAgent {
  readonly id: string;
  readonly name: string;
  readonly capabilities: string[];
  runTask(task: string, context?: unknown): Promise<{ success: boolean; result: string; needsConfirmation?: boolean }>;
}
```

### 2.2 Ponte OpenClaw (`OpenClawSubAgent`)
- Permite recrutar subagentes do OpenClaw via API local/socket.
- Envia solicitações e aguarda o resultado antes de falar para o usuário.

---

## 3. Fatias de Implementação

- **Fatia 1:** Interface `ISubAgent` e gerenciador de grafo de tarefas (`SubAgentCoordinator`).
- **Fatia 2:** Ponte OpenClaw para recrutamento de agentes externos (Revisor, Coder).
- **Fatia 3:** Matriz de confirmação por voz para passos de mutação e integração com barge-in (cancelamento em <= 350ms).
- **Fatia 4:** Harness de testes com 40 cenários multi-passo e 200 cenários de segurança/confirmação.

---

## 4. Critérios de Aceite (Harness H15)

| ID | Critério |
|---|---|
| H15.1 | 40 cenários multi-passo >= 90% concluídos corretamente |
| H15.2 | Zero mutação executada sem confirmação verificada em 200 cenários adversariais |
| H15.3 | Cancelamento por barge-in em <= 350ms p95 sem tarefas órfãs |
| H15.4 | Rastreabilidade total: o app responde por voz *"o que você fez?"* listando os passos executados |
