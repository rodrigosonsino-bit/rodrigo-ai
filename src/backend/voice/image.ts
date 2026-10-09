export interface JpegInfo {
  width: number;
  height: number;
}

/**
 * Fase V (docs/phase-vision-v3.md §4): parser mínimo de cabeçalho JPEG (JFIF/EXIF) — só o suficiente para
 * validar assinatura e dimensões antes de aceitar uma captura de tela do cliente, no mesmo espírito de
 * `wav.ts#parseWavHeader`. Nunca confia em metadado externo ao próprio arquivo; nunca decodifica a imagem.
 */
export function parseJpegHeader(buffer: Buffer): JpegInfo | null {
  if (buffer.length < 4) return null;
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null; // SOI — assinatura exigida pelo plano (achado 8)

  let offset = 2;
  while (offset + 2 <= buffer.length) {
    if (buffer[offset] !== 0xff) return null; // fora de um marcador: cabeçalho malformado
    let marker = buffer[offset + 1];
    offset += 2;
    // Preenchimento: um ou mais 0xFF antes do byte de marcador real.
    while (marker === 0xff) {
      if (offset >= buffer.length) return null;
      marker = buffer[offset];
      offset += 1;
    }

    // Marcadores sem segmento de comprimento (SOI, EOI, RST0-7, TEM). EOI sem SOF antes = sem dimensão.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      if (marker === 0xd9) return null;
      continue;
    }

    if (offset + 2 > buffer.length) return null;
    const segLen = buffer.readUInt16BE(offset);
    if (segLen < 2 || offset + segLen > buffer.length) return null;

    // SOF0-SOF15, exceto C4 (DHT), C8 (JPG reservado) e CC (DAC) — carregam altura/largura.
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (segLen < 7) return null;
      const height = buffer.readUInt16BE(offset + 3);
      const width = buffer.readUInt16BE(offset + 5);
      if (height <= 0 || width <= 0) return null; // JPEG de dimensão zero/negativa — rejeitado (coberto por teste dedicado)
      return { width, height };
    }

    if (marker === 0xda) return null; // SOS: início da varredura sem ter achado SOF antes — inválido para nós
    offset += segLen;
  }
  return null;
}
