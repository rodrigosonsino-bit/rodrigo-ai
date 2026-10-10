# Fase 14 — Ciclo completo de notas, lembretes e memórias por voz (plano v1)

Data: 2026-10-09. Autor: Orquestrador. Estado: **rascunho v1 para auditoria**.

## 1. Contexto e Problema

Atualmente, o aplicativo cria notas, lembretes e memórias por voz, mas possui limitações críticas no ciclo de vida completo:
1. **Falta de Consulta por Voz:** O usuário consegue salvar, mas não consegue perguntar *"O que eu anotei sobre X?"*, *"Quais meus lembretes de hoje?"* ou *"O que você sabe sobre mim?"*.
2. **Edição e Remoção Cegas (Item Mais Recente):** Operações de editar ou apagar atuam por padrão apenas no último item criado, mesmo que o usuário cite um item específico antigo.
3. **Reagendamento de Lembretes:** Não há suporte direto para mudar a data/hora de um lembrete existente (*"Passa o lembrete do remédio pras 15h"*).
4. **Precisão Temporal e Notificações:** Exige tolerância estrita de agendamento (notificação em até 10s do horário pretendido) e garantia de persistência após travamentos e reinícios.

---

## 2. Escopo e Requisitos da Fase 14

### 2.1 Consulta e Busca por Voz (`CONSULTAR`)
- **Consultar Lembretes:** Suporte a filtros por data/período ("hoje", "amanhã", "esta semana", por palavra-chave).
- **Consultar Notas:** Busca semântica e por palavra-chave no conteúdo das notas salvas.
- **Consultar Memórias:** Recuperação de fatos guardados sobre o usuário e preferências.
- **Resposta Falada Natural:** Resumos curtos sem markdown ou listas complexas (ex.: *"Você tem dois lembretes para hoje: remédio às dez e reunião às três."*).

### 2.2 Localização Precisa para Alteração (`EDITAR` / `APAGAR` / `REAGENDAR`)
- Busca por correspondência parcial no título/conteúdo do item citado na fala.
- Se houver ambiguidade entre múltiplos itens parecidos, o app pergunta para confirmar qual item o usuário deseja alterar antes de executar a ação.
- Zero alteração no item errado em testes de estresse (100 cenários de itens similares).

### 2.3 Reagendamento e Recorrência de Lembretes
- Suporte a comandos de reagendamento direto.
- Preservação da data/hora exata ditada, sem substituições silenciosas de horários.
- Relógio injetável (`Clock`) em todo o motor para testabilidade determinística.

---

## 3. Arquitetura das Ferramentas Mutantes e de Consulta

### 3.1 Novas Ferramentas e Ações
- `LEMBRETE_CONSULTAR`, `NOTA_CONSULTAR`, `MEMORIA_CONSULTAR` adicionadas ao protocolo (`ToolName` / `MutationName`).
- Detector local de intenção atualizado com padrão de palavras-chave e consulta ao LLM local quando necessário.

### 3.2 Estrutura do Armazenamento (`JsonStore`)
- Mantém UUID estável por item, timestamps de criação e última modificação.
- Índice de busca insensível a maiúsculas/minúsculas e acentos para correspondência de texto.

---

## 4. Fatias de Implementação

1. **Fatia 1: Motor de Busca e Consulta em Memória (`JsonStore` + `LEMBRETE_CONSULTAR`, `NOTA_CONSULTAR`, `MEMORIA_CONSULTAR`).**
2. **Fatia 2: Localização por Correspondência de Conteúdo em Mutações (substitui a regra do "mais recente" em Edição/Exclusão).**
3. **Fatia 3: Reagendamento de Lembretes (`LEMBRETE_REAGENDAR`) e Relógio Injetável (`Clock`).**
4. **Fatia 4: Harness de Testes de Estresse (120 tarefas, 100 cenários adversariais, resiliência a reinício).**

---

## 5. Critérios de Aceite (Harness Automatizado)

| ID | Critério |
|---|---|
| H14.1 | 120 tarefas nos 3 tipos (notas, lembretes, memórias) >= 95% corretas com no máximo 1 esclarecimento além da confirmação |
| H14.2 | Zero alteração no item errado e zero horário silenciosamente substituído em 100 casos (itens parecidos, "amanhã às dez", recorrência, reagendamento) |
| H14.3 | >= 99/100 notificações disparadas até 10s do horário com o relógio do sistema acordado |
| H14.4 | 30 cenários de reinício/suspensão/falha sem perda ou corrupção de lembretes |
