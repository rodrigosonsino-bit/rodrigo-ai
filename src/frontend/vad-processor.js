/**
 * AudioWorkletProcessor: acumula ~20ms de áudio (para não gerar centenas de
 * mensagens/segundo ao thread principal), calcula a energia RMS do bloco e envia
 * {rms, samples} para o main thread. Toda decisão de VAD (limiares, histerese,
 * pre-roll, piso mínimo de duração) fica em voice.ts — este processor só mede.
 */
class VadMeterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._chunks = [];
    this._accumulatedSamples = 0;
    this._targetSamples = Math.round(sampleRate * 0.02); // ~20ms
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0 && input[0].length > 0) {
      const channel = input[0];
      this._chunks.push(channel.slice());
      this._accumulatedSamples += channel.length;

      if (this._accumulatedSamples >= this._targetSamples) {
        const merged = new Float32Array(this._accumulatedSamples);
        let offset = 0;
        for (const chunk of this._chunks) {
          merged.set(chunk, offset);
          offset += chunk.length;
        }

        let sumSquares = 0;
        for (let i = 0; i < merged.length; i += 1) {
          sumSquares += merged[i] * merged[i];
        }
        const rms = Math.sqrt(sumSquares / merged.length);

        this.port.postMessage({ rms, samples: merged });

        this._chunks = [];
        this._accumulatedSamples = 0;
      }
    }
    return true;
  }
}

registerProcessor('vad-meter-processor', VadMeterProcessor);
