import { readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const API_BASE = 'https://api.openai.com/v1';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function parseEnv(text) {
  const config = {};
  for (const line of text.replace(/^\ufeff/, '').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?(OPENAI_API_KEY|OPENAI_PROJECT_ID|OPENAI_ORG_ID)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if (/^["']/.test(value)) { const quote = value[0], end = value.indexOf(quote, 1); if (end < 0) throw new Error('.env の引用符が閉じられていません。'); value = value.slice(1, end); }
    else value = value.replace(/\s+#.*$/, '').trim();
    config[match[1]] = value;
  }
  return config;
}
export async function loadConfig() {
  let local = {};
  try { local = parseEnv(await readFile(path.join(projectRoot, '.env'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return Object.fromEntries(['OPENAI_API_KEY', 'OPENAI_PROJECT_ID', 'OPENAI_ORG_ID'].map(name => [name, process.env[name]?.trim() || local[name]?.trim() || '']));
}
export function inspectWav(bytes, filename) {
  if (bytes.length > 10 * 1024 * 1024) throw new Error(`${filename}: 10 MiBを超えています。`);
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${filename}: WAV形式を確認できません。`);
  if (bytes.readUInt32LE(4) + 8 !== bytes.length) throw new Error(`${filename}: WAVのサイズが不整合です。`);
  let format, dataBytes;
  for (let at = 12; at + 8 <= bytes.length;) {
    const type = bytes.toString('ascii', at, at + 4), size = bytes.readUInt32LE(at + 4), start = at + 8;
    if (start + size > bytes.length) throw new Error(`${filename}: WAVが途中で切れています。`);
    if (type === 'fmt ' && size >= 16) format = { encoding: bytes.readUInt16LE(start), channels: bytes.readUInt16LE(start + 2), sampleRate: bytes.readUInt32LE(start + 4), byteRate: bytes.readUInt32LE(start + 8), blockAlign: bytes.readUInt16LE(start + 12), bits: bytes.readUInt16LE(start + 14) };
    if (type === 'data') dataBytes = size;
    at = start + size + size % 2;
  }
  if (!format || !dataBytes || format.encoding !== 1 || format.bits !== 16 || format.channels !== 1 || !format.sampleRate || format.byteRate !== format.sampleRate * 2 || format.blockAlign !== 2 || dataBytes % 2) throw new Error(`${filename}: モノラル16-bit PCM WAVを指定してください。`);
  const duration = dataBytes / format.byteRate;
  if (duration > 30) throw new Error(`${filename}: 30秒を超えています。`);
  return { bytes: bytes.length, duration, sampleRate: format.sampleRate, channels: format.channels, bits: format.bits, sha256: sha256(bytes) };
}
export async function inspectRecordings(directory) {
  const [consent, sample] = await Promise.all(['consent.wav', 'sample.wav'].map(name => readFile(path.join(directory, name))));
  return { consent, sample, info: { consent: inspectWav(consent, 'consent.wav'), sample: inspectWav(sample, 'sample.wav') } };
}
async function readState(filename) {
  try { return JSON.parse(await readFile(filename, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function saveState(filename, state) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, filename);
}
export function redact(value, apiKey) {
  return String(value).split(apiKey || '\0').join('[REDACTED]').replace(/\bsk-[A-Za-z0-9_-]+/g, '[REDACTED]');
}
export async function registerVoice({ directory, name = 'my-voice', config, fetchImpl = fetch, log = console.log }) {
  const apiKey = config.OPENAI_API_KEY;
  if (!apiKey || /^(your[-_ ]|ここに|sk-\.\.\.)/i.test(apiKey)) throw new Error('OPENAI_API_KEY が未設定です。プロジェクトの .env に入力・保存してください。APIは呼び出していません。');
  const recordings = await inspectRecordings(directory), filename = path.join(directory, 'registration.json'), lockPath = path.join(directory, '.registration.lock');
  const identity = sha256(JSON.stringify([apiKey, config.OPENAI_PROJECT_ID || '', config.OPENAI_ORG_ID || '']));
  let lock;
  try { lock = await open(lockPath, 'wx'); await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('別の登録処理が実行中、または前回の処理が中断されています。.registration.lock と実行中のプロセスを確認してください。'); throw error; }
  try {
    let state = await readState(filename);
    if (state && (state.identity !== identity || state.recordings.consent.sha256 !== recordings.info.consent.sha256 || state.recordings.sample.sha256 !== recordings.info.sample.sha256 || state.name !== name)) throw new Error('保存済みの登録記録と、認証設定・音声ファイル・名前のいずれかが異なります。別の登録用フォルダーを使用してください。');
    state ||= { version: 1, name, language: 'ja', identity, recordings: recordings.info, createdAt: new Date().toISOString(), consent: null, voice: null, pending: null };
    if (state.voice?.id) { log(`登録済みです。Voice ID: ${state.voice.id}`); return state; }
    if (state.pending) throw new Error(`前回の ${state.pending.stage} の成否が不明です。重複作成を防ぐため送信を停止しました。registration.json のリクエストIDとAPI側の登録状況を確認してください。`);
    const headers = { Authorization: `Bearer ${apiKey}` };
    if (config.OPENAI_PROJECT_ID) headers['OpenAI-Project'] = config.OPENAI_PROJECT_ID;
    if (config.OPENAI_ORG_ID) headers['OpenAI-Organization'] = config.OPENAI_ORG_ID;
    async function post(stage, endpoint, body) {
      state.pending = { stage, startedAt: new Date().toISOString() }; state.lastError = null;
      await saveState(filename, state);
      let response, result;
      try {
        response = await fetchImpl(`${API_BASE}${endpoint}`, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(90000) });
        state.pending.requestId = response.headers.get('x-request-id');
        const responseText = await response.text();
        try { result = JSON.parse(responseText); } catch { result = null; }
      } catch (error) {
        state.lastError = { stage, message: redact(error.message, apiKey), at: new Date().toISOString() }; await saveState(filename, state);
        throw new Error(`通信が完了しませんでした。${redact(error.message, apiKey)}。登録の成否が不明なため、自動再送はしていません。`);
      }
      const requestId = state.pending.requestId;
      if (!response.ok) {
        const message = redact(result?.error?.message || `API returned HTTP ${response.status}`, apiKey);
        state.lastError = { stage, status: response.status, code: result?.error?.code || null, message, requestId, at: new Date().toISOString() };
        if (response.status < 500) state.pending = null;
        await saveState(filename, state);
        const hint = response.status === 401 ? 'APIキーを確認してください。' : [403, 404].includes(response.status) ? 'カスタム音声の利用資格とプロジェクトの権限を確認してください。' : '';
        throw new Error(`HTTP ${response.status}: ${message} ${hint}${requestId ? ` Request ID: ${requestId}` : ''}`);
      }
      if (typeof result?.id !== 'string' || !result.id) { state.lastError = { stage, status: response.status, message: 'Successful response without ID', requestId }; await saveState(filename, state); throw new Error('APIの成功応答にIDがありません。登録状況を確認してください。'); }
      state[stage] = { id: result.id, object: result.object, name: result.name, language: result.language, created_at: result.created_at, requestId };
      state.pending = null; state.lastError = null; state.updatedAt = new Date().toISOString(); await saveState(filename, state);
      return state[stage];
    }
    if (!state.consent?.id) {
      log('同意音声を登録しています…');
      const body = new FormData(); body.set('name', `${name}-consent`); body.set('language', 'ja'); body.set('recording', new Blob([recordings.consent], { type: 'audio/wav' }), 'consent.wav');
      const consent = await post('consent', '/audio/voice_consents', body); log(`同意ID: ${consent.id}`);
    } else log(`保存済みの同意IDを使用: ${state.consent.id}`);
    log('声のサンプルを登録しています…');
    const body = new FormData(); body.set('name', name); body.set('consent', state.consent.id); body.set('audio_sample', new Blob([recordings.sample], { type: 'audio/wav' }), 'sample.wav');
    const voice = await post('voice', '/audio/voices', body); log(`Voice ID: ${voice.id}`); log(`登録結果: ${filename}`);
    return state;
  } finally { await lock.close(); await unlink(lockPath); }
}
async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--check')) throw new Error('使い方: node scripts/create-voice.mjs [--check]');
  const directory = path.join(projectRoot, 'recordings', 'my-voice'), config = await loadConfig();
  if (args.includes('--check')) {
    const { info } = await inspectRecordings(directory);
    console.log(JSON.stringify({ apiKeyConfigured: Boolean(config.OPENAI_API_KEY), directory, recordings: info, networkRequest: false }, null, 2)); return;
  }
  try { await registerVoice({ directory, config }); } catch (error) { throw new Error(redact(error.message, config.OPENAI_API_KEY)); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
