# Fase 14 — Ciclo completo de notas, lembretes e memórias por voz (plano v2)

Data: 2026-10-09. Autor: Orquestrador. Estado: **Aprovado para implementação**.

## 1. Problemas Resolvidos na F14

1. **Consulta por Voz (`CONSULTAR`):** O usuário pode perguntar por voz:
   - *"O que eu anotei sobre X?"* (`NOTA_CONSULTAR`)
   - *"Quais são meus lembretes para hoje / amanhã / esta semana?"* (`LEMBRETE_CONSULTAR`)
   - *"O que você lembra sobre mim / sobre Y?"* (`MEMORIA_CONSULTAR`)
2. **Localização Precisa de Itens em Mutações (`EDITAR` / `APAGAR` / `REAGENDAR`):**
   - Substitui a seleção cega do item "mais recente" por busca baseada em correspondência de texto.
   - Em caso de itens similares ou ambiguidade, solicita confirmação para desambiguar qual item alterar.
3. **Reagendamento Explícito de Lembretes:**
   - Suporte a mudar o horário/data de um lembrete existente (`LEMBRETE_REAGENDAR`).
   - Proibição absoluta de alteração silenciosa de horários.
4. **Relógio Injetável e Resiliência a Reinícios:**
   - Injeção da interface `Clock` no `ReminderScheduler` e em todas as ferramentas.
   - Recuperação automática de agendamentos pendentes ao reiniciar a aplicação.

---

## 2. Detalhes do Protocolo e Novas Ferramentas

### 2.1 Protocolo de Desambiguação e Busca
- Algoritmo de correspondência base do termo citado vs conteúdo dos itens salvos (pontuação por presença de tokens e subsequência).
- Se o item de maior pontuação estiver destacado isoladamente (`score >= 0.6` e margem > 0.2 sobre o segundo), seleciona o item.
- Se houver empate/ambiguidade entre 2 ou mais itens parecidos (`margem <= 0.2`), o app responde perguntando: *"Encontrei dois lembretes parecidos: [Item A] e [Item B]. Qual deles você quer alterar?"*.

### 2.2 Formatação de Consulta em Voz Alta
- Limita o número de itens lidos para no máximo 3 itens por vez para evitar leituras exaustivas.
- Formatação conversacional (ex.: *"Você tem 2 lembretes para hoje: remédio para pressão às 08h e reunião com a equipe às 15h."*).

---

## 3. Fatias de Implementação da Fase 14

- **Fatia 1:** Adição do `Clock` injetável + novas ações de consulta (`LEMBRETE_CONSULTAR`, `NOTA_CONSULTAR`, `MEMORIA_CONSULTAR`) no `mutatingTools.ts` e `systemTools.ts`.
- **Fatia 2:** Algoritmo de correspondência por texto e protocolo de desambiguação para `EDITAR` e `APAGAR`.
- **Fatia 3:** Reagendamento de lembretes (`LEMBRETE_REAGENDAR`) e recarga de pendências ao reiniciar no `ReminderScheduler`.
- **Fatia 4:** Suíte de testes de estresse (120 tarefas, 100 cenários de desambiguação/horário, 30 testes de reinício/resiliência).

---

## 4. Critérios de Aceite (Harness H14)

| ID | Critério |
|---|---|
| H14.1 | 120 tarefas nos 3 tipos (notas, lembretes, memórias) >= 95% corretas |
| H14.2 | Zero alteração no item errado e zero horário alterado em silêncio em 100 casos adversariais |
| H14.3 | >= 99/100 notificações disparadas até 10s do horário pretendido |
| H14.4 | 30 cenários de reinício/suspensão sem perda de lembretes pendentes |
