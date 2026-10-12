# Lições (ler antes de trabalhar)

- **L1:** o Cursor CLI headless sempre roda com `--trust --force`. Saída vazia indica que ele está esperando confirmação.
- **L2:** antes de usar o `delegar`, conferir que todo agente das filas está definido. Fazer backup antes de editar e validar depois.
- **L3:** usar sempre `/opt/homebrew/bin/openclaw`, nunca o `openclaw` do PATH.
- **L4:** se uma sessão longa começa a responder sem sentido, abrir sessão nova com brief em vez de insistir. Novas sessões usam `--model nvidia/moonshotai/kimi-k3` (não há chave da Anthropic).
- **L5:** "CSRF token not found" no NotebookLM significa parar e pedir ao Rodrigo `notebooklm login --browser-cookies chrome`.
- **L6:** gerador de fontes não pode ter estado fixo no código. Ler o estado de `ESTADO.md`.
- **L7:** checar a cota antes de mandar trabalho a modelos premium. Usar `auto` como padrão.
- **L8:** ao configurar um agente, conferir se o provedor do modelo tem chave no gateway (`openclaw agent --agent <id> --message "OK"`). O modelo funcional hoje é `nvidia/moonshotai/kimi-k3`.
- **L9:** quando mudar as filas do `delegar`, atualizar no mesmo passo a skill `agent-catalog` do OpenClaw.
- **L10:** depois de executar uma fase, atualizar o status e o inventário do plano na mesma mudança. Documento que diz "proposta" sobre algo já feito engana os outros agentes.
- **L11:** tarefa de código precisa de timeout de pelo menos 600 s por agente, e a fila deve pôr primeiro quem falha rápido (cota) ou quem tem cota garantida (`auto`), nunca vários modelos lentos sem cota em série.
- **L12:** agente que não está instalado, responde vazio ou está sem cota sai da fila no mesmo dia. Conferir com `command -v` e com um "OK" de teste, além do que diz a L2.
- **L13:** "Free plans can only use Auto" no Cursor indica autenticação errada, não falta de cota. Conferir a conta antes de mexer nas filas.
- **L14:** provedor externo que dá timeout duas vezes seguidas não recebe terceira tentativa manual na mesma hora; seguir a fila.
- **L15:** registrar avisos de estabilidade do gateway mesmo quando o reinício conclui. Se passarem de 5 por semana, investigar.
