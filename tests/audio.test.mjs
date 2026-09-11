import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import http from 'node:http';
import { encodeWav, mergeChunks, analyzeAudio, qualityNotes, createZip, crc32, MAX_SECONDS } from '../public/audio-utils.js';
import { createServer } from '../server.mjs';

test('WAV output has correct PCM header and signed 16-bit samples', () => {
  const bytes = encodeWav(new Float32Array([-2, -1, -.5, 0, .5, 1, 2, NaN]), 48000);
  const view = new DataView(bytes.buffer);
  assert.equal(Buffer.from(bytes.subarray(0, 4)).toString(), 'RIFF');
  assert.equal(Buffer.from(bytes.subarray(8, 12)).toString(), 'WAVE');
  assert.equal(view.getUint32(4, true), bytes.length - 8);
  assert.equal(view.getUint16(20, true), 1); assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 48000); assert.equal(view.getUint32(28, true), 96000);
  assert.equal(view.getUint16(34, true), 16); assert.equal(view.getUint32(40, true), 16);
  assert.deepEqual(Array.from({ length: 8 }, (_, i) => view.getInt16(44 + i * 2, true)), [-32768, -32768, -16384, 0, 16384, 32767, 32767, 0]);
});
test('chunk merging preserves order and enforces frame limit', () => {
  assert.deepEqual([...mergeChunks([new Float32Array([1, 2]), new Float32Array([3, 4])], 3)], [1, 2, 3]);
  assert.equal(mergeChunks([]).length, 0);
});
test('quality checks flag silence, short samples, and clipping', () => {
  const silence = analyzeAudio(new Float32Array(48000), 48000);
  assert.equal(silence.duration, 1); assert.equal(silence.activeSeconds, 0);
  assert.ok(qualityNotes(silence, 'sample').some(note => note.includes('無音')));
  const clipped = analyzeAudio(new Float32Array(48000).fill(1), 48000);
  assert.equal(clipped.clippedSamples, 48000); assert.ok(qualityNotes(clipped, 'consent').some(note => note.includes('音割れ')));
  const natural = Float32Array.from({ length: 480000 }, (_, i) => Math.sin(i * 2 * Math.PI * 220 / 48000) * .2);
  assert.deepEqual(qualityNotes(analyzeAudio(natural, 48000), 'sample'), []);
});
test('ZIP directory, CRC and stored bytes agree', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  const files = [{ name: 'consent.wav', data: encodeWav(new Float32Array([0, .5]), 48000) }, { name: '説明.txt', data: 'こんにちは' }];
  const zip = createZip(files), view = new DataView(zip.buffer);
  const end = zip.length - 22; assert.equal(view.getUint32(end, true), 0x06054b50);
  assert.equal(view.getUint16(end + 10, true), 2);
  let directory = view.getUint32(end + 16, true);
  for (const file of files) {
    assert.equal(view.getUint32(directory, true), 0x02014b50);
    const local = view.getUint32(directory + 42, true), length = view.getUint16(local + 26, true), size = view.getUint32(local + 18, true);
    assert.equal(new TextDecoder().decode(zip.subarray(local + 30, local + 30 + length)), file.name);
    const data = zip.subarray(local + 30 + length, local + 30 + length + size), expected = typeof file.data === 'string' ? new TextEncoder().encode(file.data) : file.data;
    assert.deepEqual(data, expected); assert.equal(crc32(data), view.getUint32(directory + 16, true));
    directory += 46 + view.getUint16(directory + 28, true);
  }
  assert.equal(directory, end);
});
async function processor() {
  let Constructor; const messages = [];
  const sandbox = { AudioWorkletProcessor: class { constructor() { this.port = { postMessage: message => messages.push(message) }; } }, registerProcessor: (_, c) => { Constructor = c; }, Float32Array };
  vm.runInNewContext(await readFile(new URL('../public/capture-worklet.js', import.meta.url), 'utf8'), sandbox);
  return { capture: new Constructor(), messages };
}
test('worklet caps at 29.9 seconds even without main-thread stop timer', async () => {
  const { capture, messages } = await processor();
  const frames = 48000 * MAX_SECONDS;
  capture.port.onmessage({ data: { type: 'start', maxFrames: frames } });
  for (let i = 0; i < 12000; i++) capture.process([[new Float32Array(128).fill(.2)]]);
  const chunks = messages.filter(m => m.type === 'chunk').map(m => m.chunk);
  assert.equal(mergeChunks(chunks).length, frames);
  assert.equal(messages.filter(m => m.type === 'stopped').length, 1);
  assert.equal(messages.find(m => m.type === 'stopped').reason, 'limit');
});
test('manual stop flushes final partial chunk; microphone test saves no audio', async () => {
  const { capture, messages } = await processor();
  capture.process([[new Float32Array(128).fill(.2)]]);
  assert.equal(messages.filter(m => m.type === 'chunk').length, 0);
  capture.port.onmessage({ data: { type: 'start', maxFrames: 48000 } });
  capture.process([[new Float32Array(128).fill(.2), new Float32Array(128).fill(.4)]]);
  capture.port.onmessage({ data: { type: 'stop' } });
  const chunk = messages.find(m => m.type === 'chunk').chunk;
  assert.equal(chunk.length, 128); assert.ok(Math.abs(chunk[0] - .3) < .000001);
});
test('server serves only application files, with local-only access and no upload endpoint', async () => {
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(base); assert.equal(page.status, 200); assert.match(await page.text(), /Voice Prep Studio/);
    assert.ok(page.headers.get('content-security-policy').includes("connect-src 'self'"));
    assert.equal((await fetch(base + '/capture-worklet.js')).status, 200);
    assert.equal((await fetch(base + '/package.json')).status, 404);
    assert.equal((await fetch(base + '/recordings', { method: 'POST' })).status, 405);
    const rejectedHostStatus = await new Promise((resolve, reject) => { http.get(base, { headers: { Host: 'untrusted.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject); });
    assert.equal(rejectedHostStatus, 403);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
