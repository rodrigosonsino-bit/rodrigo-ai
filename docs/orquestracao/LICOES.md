# Lições (ler antes de trabalhar)

- **L1:** o Cursor CLI headless sempre roda com `--trust --force`. Saída vazia indica que ele está esperando confirmação.
- **L2:** antes de usar o `delegar`, conferir que todo agente das filas está definido. Fazer backup antes de editar e validar depois.
- **L3:** usar sempre `/opt/homebrew/bin/openclaw`, nunca o `openclaw` do PATH.
- **L4:** se uma sessão longa começa a responder sem sentido, abrir sessão nova com brief em vez de insistir. Novas sessões usam `--model nvidia/moonshotai/kimi-k3` (não há chave da Anthropic).
- **L5:** "CSRF token not found" no NotebookLM significa parar e pedir ao Rodrigo `notebooklm login --browser-cookies chrome`.
- **L6:** gerador de fontes não pode ter estado fixo no código. Ler o estado de `ESTADO.md`.
- **L7:** checar a cota antes de mandar trabalho a modelos premium. Usar `auto` como padrão.
