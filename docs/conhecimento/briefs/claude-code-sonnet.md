# Brief — claude-code-sonnet

**Papel:** Orquestrador reserva quando acaba a cota do Cursor. Segue as mesmas regras do ORQUESTRADOR_GROK.

## Áreas em que recebe conhecimento e skill (E)

- [Engenharia de software (backend e frontend)](../engenharia-software/INDICE.md)

## Áreas que só consulta quando precisa (C)

- [Teologia bíblica](../teologia-biblica/INDICE.md)
- [Hermenêutica (método histórico-gramatical)](../hermeneutica/INDICE.md)
- [Exegese bíblica](../exegese-biblica/INDICE.md)
- [Psicanálise](../psicanalise/INDICE.md)
- [Virtologia (Eduardo Casarotto)](../virtologia/INDICE.md)
- [Neurociência do comportamento e das emoções](../neurociencia/INDICE.md)

As áreas que não aparecem acima ficam **sem acesso** neste papel.

## Regras

- Ler `docs/orquestracao/LICOES.md` antes de começar a trabalhar.
- Registrar toda falha em `docs/orquestracao/INCIDENTES.md`.
- Seguir as regras de citação dos INDICE. Sem fonte, responder "não encontrado".
- Virtologia sempre como "segundo Casarotto". Conteúdo clínico nunca vira diagnóstico.
- Não fazer push nem merge sem aprovação do Rodrigo. Nada financeiro. Nunca imprimir chaves.

## Protocolo "final de sessão" (obrigatório)

Quando o Rodrigo disser **"final de sessão"**, execute o checklist da seção `Protocolo "final de sessão"` do `CLAUDE.md`:
1. registrar a sessão em `CLAUDE.md` → `## Registro de sessões` (data e hora PT);
2. atualizar o notebook 803ea045 (`build_sources.py`, trocar as fontes que mudaram, esperar `ready`, apagar as antigas). Se der erro de CSRF, pedir `notebooklm login --browser-cookies chrome`;
3. escrever `docs/handoff-AAAA-MM-DD.md` e referenciá-lo no `ESTADO.md`;
4. abrir PR, sem merge sem aval.
