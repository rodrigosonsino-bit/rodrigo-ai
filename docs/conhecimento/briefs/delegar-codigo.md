# Brief — delegar-codigo

**Papel:** Executa tarefas de código pela fila do delegar.

## Áreas em que recebe conhecimento e skill (E)

- [Engenharia de software (backend e frontend)](../engenharia-software/INDICE.md)

## Áreas que só consulta quando precisa (C)

- nenhuma

As áreas que não aparecem acima ficam **sem acesso** neste papel.

## Regras

- Ler `docs/orquestracao/LICOES.md` antes de começar a trabalhar.
- Registrar toda falha em `docs/orquestracao/INCIDENTES.md`.
- Seguir as regras de citação dos INDICE. Sem fonte, responder "não encontrado".
- Virtologia sempre como "segundo Casarotto". Conteúdo clínico nunca vira diagnóstico.
- Não fazer push nem merge sem aprovação do Rodrigo. Nada financeiro. Nunca imprimir chaves.

## Regras operacionais (revisão de 2026-10-12, aprovadas e aplicadas)

- Tarefa de código usa timeout de pelo menos 600 s por agente (L11).
- Antes de despachar, conferir que cada agente da fila está instalado e com cota. Agente sem cota, vazio ou não instalado é reportado para sair da fila (L12).
- "Free plans can only use Auto" é problema de autenticação: avisar o orquestrador em vez de trocar de modelo (L13).
- Provedor que deu timeout duas vezes seguidas não recebe terceira tentativa manual; seguir a fila (L14).
