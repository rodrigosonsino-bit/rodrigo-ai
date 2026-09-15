/**
 * Validador estrito de cabeçalho Host.
 * Garante que a requisição seja estritamente originada para endereços de loopback
 * (127.0.0.1 ou localhost) e que a porta, se informada, corresponda às portas permitidas.
 * Rejeita categoricamente padrões como "localhost.evil", "attacker.com", etc.
 */
export function isAllowedHost(
  hostHeader: string | undefined,
  allowedPorts: number[]
): boolean {
  if (!hostHeader || typeof hostHeader !== 'string') {
    return false;
  }

  const trimmed = hostHeader.trim();
  // Formato estrito: hostname ou hostname:porta
  const match = /^([a-zA-Z0-9.-]+)(?::(\d+))?$/.exec(trimmed);
  if (!match) {
    return false;
  }

  const hostname = match[1].toLowerCase();
  const portStr = match[2];

  // Apenas loopback exato é aceito
  if (hostname !== '127.0.0.1' && hostname !== 'localhost') {
    return false;
  }

  // Se a porta foi especificada no cabeçalho Host, ela deve ser uma das portas permitidas
  if (portStr !== undefined) {
    const port = parseInt(portStr, 10);
    if (!allowedPorts.includes(port)) {
      return false;
    }
  }

  return true;
}
