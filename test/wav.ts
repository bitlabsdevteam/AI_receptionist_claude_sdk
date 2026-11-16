/**
 * A silent 16 kHz mono 16-bit WAV clip of `ms` milliseconds, with a proper 44-byte header. For tests only.
 * `asFfmpegWrites` puts a 34-byte `LIST` chunk between the format and the audio, which is what ffmpeg 7 does.
 */
export function wavClip(ms: number, asFfmpegWrites = false): Uint8Array {
  const sampleRate = 16000;
  const byteRate = sampleRate * 2;
  const dataBytes = Math.round((byteRate * ms) / 1000);
  const list = asFfmpegWrites ? 34 : 0;
  const bytes = new Uint8Array(44 + list + dataBytes);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + list + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  if (asFfmpegWrites) {
    ascii(36, "LIST");
    view.setUint32(40, 26, true);
    ascii(44, "INFOISFT");
    view.setUint32(52, 13, true);
    ascii(56, "Lavf61.7.100");
  }
  ascii(36 + list, "data");
  view.setUint32(40 + list, dataBytes, true);
  return bytes;
}
