export const MAX_SECONDS = 29.9;
export const CONSENT_JA = '私はこの音声の所有者であり、OpenAIがこの音声を使用して音声合成 モデルを作成することを承認します。';
export const SAMPLE_JA = 'こんにちは。今日は、私の声をお届けします。窓を開けると、涼しい風が入ってきました。こんな日は、少し遠くまで散歩したくなりますね。あなたは、どんな一日を過ごしたいですか。これからも、一つひとつの言葉を大切に、わかりやすくお話しします。';
export const SOURCE_URL = 'https://developers.openai.com/api/docs/guides/custom-voices';

export function mergeChunks(chunks, maxFrames = Infinity) {
  const length = Math.min(chunks.reduce((sum, chunk) => sum + chunk.length, 0), maxFrames);
  const samples = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    const slice = chunk.subarray(0, Math.max(0, length - offset));
    samples.set(slice, offset); offset += slice.length;
    if (offset >= length) break;
  }
  return samples;
}
export function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const ascii = (offset, value) => [...value].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
  ascii(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); ascii(36, 'data'); view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => { const s = Math.max(-1, Math.min(1, Number.isFinite(sample) ? sample : 0)); view.setInt16(44 + i * 2, Math.round(s * (s < 0 ? 32768 : 32767)), true); });
  return new Uint8Array(buffer);
}
export function analyzeAudio(samples, sampleRate) {
  let peak = 0, square = 0, clipped = 0, activeFrames = 0;
  const window = Math.round(sampleRate * 0.02);
  for (let start = 0; start < samples.length; start += window) {
    const end = Math.min(start + window, samples.length);
    let windowSquare = 0;
    for (let i = start; i < end; i++) {
      const value = Math.abs(samples[i]); peak = Math.max(peak, value); square += value * value; windowSquare += value * value;
      if (value >= 0.99) clipped++;
    }
    if (Math.sqrt(windowSquare / (end - start)) >= 0.01) activeFrames += end - start;
  }
  const db = value => value > 0 ? 20 * Math.log10(value) : -100;
  return { duration: samples.length / sampleRate, peakDb: db(peak), rmsDb: db(Math.sqrt(square / Math.max(1, samples.length))), clippedSamples: clipped, activeSeconds: activeFrames / sampleRate };
}
export function qualityNotes(metrics, kind) {
  const notes = [];
  if (metrics.duration < 1 || metrics.peakDb < -50) notes.push('ほぼ無音です。マイクの選択と入力音量を確認してください。');
  else if (metrics.rmsDb < -35) notes.push('音量が小さめです。マイクとの距離や入力音量を調整してください。');
  if (metrics.clippedSamples > 0) notes.push('音割れの可能性があります。入力音量を下げて録り直すことをおすすめします。');
  if (kind === 'sample' && metrics.duration < 10) notes.push('サンプルは10〜30秒を目安に、複数の文を話してください。');
  if (kind === 'sample' && metrics.activeSeconds < 5) notes.push('一定音量以上の区間が5秒未満です。発話が十分に入っているか試聴してください。');
  return notes;
}
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
export function crc32(bytes) { let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
// Store-only ZIP. Audio remains byte-for-byte identical to individual WAV downloads.
export function createZip(files) {
  const encoder = new TextEncoder(), local = [], central = []; let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name), data = typeof file.data === 'string' ? encoder.encode(file.data) : file.data;
    const crc = crc32(data), header = new Uint8Array(30 + name.length), h = new DataView(header.buffer);
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x800, true); h.setUint16(12, 33, true);
    h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true); header.set(name, 30);
    const directory = new Uint8Array(46 + name.length), d = new DataView(directory.buffer);
    d.setUint32(0, 0x02014b50, true); d.setUint16(4, 20, true); d.setUint16(6, 20, true); d.setUint16(8, 0x800, true); d.setUint16(14, 33, true);
    d.setUint32(16, crc, true); d.setUint32(20, data.length, true); d.setUint32(24, data.length, true); d.setUint16(28, name.length, true); d.setUint32(42, offset, true); directory.set(name, 46);
    local.push(header, data); central.push(directory); offset += header.length + data.length;
  }
  const size = central.reduce((sum, entry) => sum + entry.length, 0), end = new Uint8Array(22), e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, size, true); e.setUint32(16, offset, true);
  const bytes = new Uint8Array(offset + size + 22); let at = 0;
  for (const part of [...local, ...central, end]) { bytes.set(part, at); at += part.length; }
  return bytes;
}
export function safeName(value) { return (value.normalize('NFKC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').trim().slice(0, 60) || 'my-voice'); }
