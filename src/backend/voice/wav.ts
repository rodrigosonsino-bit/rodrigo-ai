export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataBytes: number;
  durationSeconds: number;
}

/**
 * Parser mínimo de cabeçalho WAV (RIFF/WAVE), só o suficiente para validar
 * conteúdo/duração antes de aceitar áudio do cliente — nunca confia no
 * Content-Length declarado nem em metadados externos ao próprio arquivo.
 */
export function parseWavHeader(buffer: Buffer): WavInfo | null {
  if (buffer.length < 44) return null;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF') return null;
  if (buffer.toString('ascii', 8, 12) !== 'WAVE') return null;

  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let dataBytes = 0;
  let foundFmt = false;
  let foundData = false;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;

    if (chunkId === 'fmt ') {
      if (chunkStart + 16 > buffer.length) return null;
      channels = buffer.readUInt16LE(chunkStart + 2);
      sampleRate = buffer.readUInt32LE(chunkStart + 4);
      bitsPerSample = buffer.readUInt16LE(chunkStart + 14);
      foundFmt = true;
    } else if (chunkId === 'data') {
      dataBytes = Math.min(chunkSize, buffer.length - chunkStart);
      foundData = true;
    }

    offset = chunkStart + chunkSize + (chunkSize % 2);
  }

  if (!foundFmt || !foundData || sampleRate <= 0 || channels <= 0 || bitsPerSample <= 0) {
    return null;
  }

  const bytesPerSecond = sampleRate * channels * (bitsPerSample / 8);
  const durationSeconds = bytesPerSecond > 0 ? dataBytes / bytesPerSecond : 0;

  return { sampleRate, channels, bitsPerSample, dataBytes, durationSeconds };
}
