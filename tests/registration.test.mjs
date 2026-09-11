import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { registerVoice, parseEnv, redact } from '../scripts/create-voice.mjs';
import { encodeWav } from '../public/audio-utils.js';

const config = { OPENAI_API_KEY: 'test-secret-key', OPENAI_PROJECT_ID: 'proj_test', OPENAI_ORG_ID: '' };
async function fixture() {
  await mkdir('test-results', { recursive: true });
  const directory = await mkdtemp(path.resolve('test-results/registration-'));
  const audio = encodeWav(new Float32Array(4800).fill(.1), 48000);
  await Promise.all(['consent.wav', 'sample.wav'].map(name => writeFile(path.join(directory, name), audio)));
  return directory;
}
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'x-request-id': 'req_test' } });
const quiet = () => {};
test('sequential multipart uploads preserve audio and save IDs; rerun does not duplicate', async () => {
  const directory = await fixture(), requests = [], logs = [];
  const fetchImpl = async (url, options) => {
    requests.push(url); assert.equal(options.headers.Authorization, `Bearer ${config.OPENAI_API_KEY}`); assert.equal(options.headers['OpenAI-Project'], 'proj_test'); assert.equal(options.redirect, 'error');
    if (requests.length === 1) {
      assert.equal(url, 'https://api.openai.com/v1/audio/voice_consents'); assert.equal(options.body.get('language'), 'ja');
      const recording = options.body.get('recording'); assert.equal(recording.type, 'audio/wav'); assert.equal(recording.name, 'consent.wav');
      assert.deepEqual(Buffer.from(await recording.arrayBuffer()), await readFile(path.join(directory, 'consent.wav')));
      return response({ id: 'cons_test', object: 'audio.voice_consent' });
    }
    assert.equal(url, 'https://api.openai.com/v1/audio/voices'); assert.equal(options.body.get('consent'), 'cons_test'); assert.equal(options.body.get('audio_sample').name, 'sample.wav');
    return response({ id: 'voice_test', object: 'audio.voice' });
  };
  await registerVoice({ directory, config, fetchImpl, log: line => logs.push(line) });
  const stateText = await readFile(path.join(directory, 'registration.json'), 'utf8'), state = JSON.parse(stateText);
  assert.equal(state.voice.id, 'voice_test'); assert.equal(state.consent.id, 'cons_test'); assert.equal(state.pending, null);
  assert.ok(!stateText.includes(config.OPENAI_API_KEY)); assert.ok(!logs.join('').includes(config.OPENAI_API_KEY));
  await registerVoice({ directory, config, fetchImpl, log: quiet }); assert.equal(requests.length, 2);
});
test('permission failure retains consent ID and resumes only voice creation', async () => {
  const directory = await fixture(); let calls = 0;
  await assert.rejects(registerVoice({ directory, config, log: quiet, fetchImpl: async () => ++calls === 1 ? response({ id: 'cons_kept' }) : response({ error: { message: 'Not allowed', code: 'permission_denied' } }, 403) }), /HTTP 403/);
  const state = JSON.parse(await readFile(path.join(directory, 'registration.json'))); assert.equal(state.consent.id, 'cons_kept'); assert.equal(state.pending, null);
  await registerVoice({ directory, config, log: quiet, fetchImpl: async (url, options) => { assert.equal(url, 'https://api.openai.com/v1/audio/voices'); assert.equal(options.body.get('consent'), 'cons_kept'); return response({ id: 'voice_resumed' }); } });
});
test('uncertain network result prevents accidental duplicate retry', async () => {
  const directory = await fixture(); let calls = 0;
  const run = () => registerVoice({ directory, config, log: quiet, fetchImpl: async () => { calls++; throw new Error('network disconnected'); } });
  await assert.rejects(run(), /通信が完了/); await assert.rejects(run(), /成否が不明/); assert.equal(calls, 1);
});
test('missing credentials never make a request and errors redact credentials', async () => {
  let called = false;
  await assert.rejects(registerVoice({ directory: '.', config: {}, fetchImpl: async () => { called = true; } }), /未設定/); assert.equal(called, false);
  assert.equal(redact('failed test-secret-key sk-example123', 'test-secret-key'), 'failed [REDACTED] [REDACTED]');
  assert.deepEqual(parseEnv('OPENAI_API_KEY="test-token"\nOPENAI_PROJECT_ID=proj_test # note\nUNRELATED=value'), { OPENAI_API_KEY: 'test-token', OPENAI_PROJECT_ID: 'proj_test' });
});
