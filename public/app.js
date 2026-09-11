import { MAX_SECONDS, CONSENT_JA, SAMPLE_JA, SOURCE_URL, mergeChunks, encodeWav, analyzeAudio, qualityNotes, createZip, safeName } from './audio-utils.js';

const $ = id => document.getElementById(id);
const steps = ['setup', 'consent', 'sample', 'export'];
const copy = {
  setup: ['いい声は、いい準備から。', 'マイクを整えて、あなたの声をクリアに残しましょう。', '録音する前に', '約1分で準備', '2つの録音で、準備完了。', '同意音声と声のサンプルを別々に録音。同じ本人の声で、続けて録るのがおすすめです。'],
  consent: ['まずは、あなたの同意を。', '本人の声で、指定の同意文を録音します。', 'この文章を、そのまま読み上げる', '日本語の指定文', '同意文だけを、正確に。', '名前や挨拶は加えず、表示された文章だけを読みます。読み間違えたら、新しいテイクを録りましょう。'],
  sample: ['あなたらしい声を、残そう。', '話し方も、間の取り方も。再現したい声で録音しましょう。', '自然な声で、読み上げる', '目安 10〜30秒', '声の調子を、最後まで。', '話す速さや声の高さ、アクセントをそろえてください。参考原稿は自由に編集できます。複数の文を、落ち着いて話しましょう。'],
  export: ['声の準備が、できました。', '2つの音声を確認して、登録用のファイルを保存しましょう。']
};
let step = 'setup', phase = 'idle', takes = [], chosen = { consent: null, sample: null }, database = null;
let audioContext, stream, source, capture, mute, captureKind, captureScript, captureName, captureSettings;
let chunks = [], frameCount = 0, generation = 0, starting = false, stopping = false, currentWave = [], peak = 0;
let volatileStorage = false, storageWrites = 0, initializing = true;
const audioUrls = new Map();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const textNode = (tag, text, className) => { const node = document.createElement(tag); node.textContent = text; if (className) node.className = className; return node; };
function notice(message) { $('notice').textContent = message; $('notice').hidden = !message; }
function selected(kind) { return takes.find(take => take.id === chosen[kind]); }
function recordingUrl(take) { if (!audioUrls.has(take.id)) audioUrls.set(take.id, URL.createObjectURL(take.blob)); return audioUrls.get(take.id); }
function resetReview() { $('review-consent').checked = false; $('review-quality').checked = false; }
function dbTransaction(mode, action) {
  return new Promise((resolve, reject) => {
    const tx = database.transaction('recordings', mode); const request = action(tx.objectStore('recordings'));
    tx.oncomplete = () => resolve(request?.result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('Storage aborted'));
  });
}
function storageFailure() { volatileStorage = true; $('save-status').textContent = '一時保存中・WAVで保存してください'; notice('ブラウザーへの保存ができません。ページを閉じる前に、各テイクの「WAVを保存」で録音をダウンロードしてください。'); }
function savePreferences() {
  try { localStorage.setItem('voice-prep-settings', JSON.stringify({ name: $('voice-name').value, script: $('sample-script').value, chosen })); } catch { storageFailure(); }
}
async function initStorage() {
  try {
    const open = indexedDB.open('voice-prep-studio', 1);
    database = await new Promise((resolve, reject) => { open.onupgradeneeded = () => open.result.createObjectStore('recordings', { keyPath: 'id' }); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); open.onblocked = () => reject(new Error('Storage blocked')); });
    takes = (await dbTransaction('readonly', store => store.getAll())).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const prefs = JSON.parse(localStorage.getItem('voice-prep-settings') || '{}');
    if (typeof prefs.name === 'string') $('voice-name').value = prefs.name;
    if (typeof prefs.script === 'string') $('sample-script').value = prefs.script;
    for (const kind of ['consent', 'sample']) chosen[kind] = takes.some(t => t.id === prefs.chosen?.[kind] && t.kind === kind) ? prefs.chosen[kind] : takes.filter(t => t.kind === kind).at(-1)?.id || null;
  } catch { storageFailure(); }
  initializing = false; render();
}
function switchStep(value) {
  if (phase === 'recording' || phase === 'saving' || starting) return;
  if (phase !== 'idle') releaseMicrophone();
  pausePlayers(); step = value; notice(volatileStorage ? '一時保存中です。ページを閉じる前にWAVを保存してください。' : ''); render();
}
function pausePlayers() { document.querySelectorAll('audio').forEach(audio => audio.pause()); }
function render() {
  document.querySelectorAll('[data-step]').forEach(button => { const active = button.dataset.step === step; button.classList.toggle('active', active); if (active) button.setAttribute('aria-current', 'step'); else button.removeAttribute('aria-current'); });
  $('page-title').textContent = copy[step][0]; $('page-description').textContent = copy[step][1];
  $('record-workspace').hidden = step === 'export'; $('export-panel').hidden = step !== 'export';
  for (const kind of ['consent', 'sample']) $(kind + '-check').textContent = selected(kind) ? '✓' : '';
  if (step === 'export') renderExport();
  else {
    for (const content of ['setup', 'consent', 'sample']) $(content + '-content').hidden = content !== step;
    $('script-eyebrow').textContent = `STEP 0${steps.indexOf(step) + 1} / ${step.toUpperCase()}`;
    $('script-title').textContent = copy[step][2]; $('script-chip').textContent = copy[step][3]; $('guide-title').textContent = copy[step][4]; $('guide-text').textContent = copy[step][5];
    $('next-button').textContent = step === 'setup' ? '同意音声へ →' : step === 'consent' ? '声のサンプルへ →' : '確認・書き出しへ →';
    $('bottom-note').textContent = step === 'setup' ? 'まずはマイクの入力を確認しましょう。' : selected(step) ? '選択したテイクは、あとから変更できます。' : '録音後に試聴して、テイクを選びましょう。';
    $('takes-section').hidden = step === 'setup'; renderTakes();
  }
  updateControls();
}
function updateControls() {
  const busy = initializing || ['countdown', 'connecting', 'recording', 'saving'].includes(phase);
  document.body.classList.toggle('recording', phase === 'recording'); document.body.classList.toggle('monitoring', phase === 'monitoring');
  for (const button of document.querySelectorAll('[data-step], #next-button')) button.disabled = busy;
  $('microphone').disabled = phase !== 'idle'; $('sample-script').disabled = busy; $('voice-name').disabled = busy; $('reset-script').disabled = busy;
  $('record-button').disabled = initializing || phase === 'saving' || stopping;
  document.querySelectorAll('.take input, .take button').forEach(control => { control.disabled = busy; });
  document.querySelectorAll('audio').forEach(audio => { audio.controls = !busy; });
  $('state-label').textContent = ({ idle: 'マイク未接続', connecting: 'マイクに接続中…', monitoring: 'マイクテスト中', countdown: 'まもなく録音を開始', recording: '録音中', saving: '録音を保存中…' })[phase];
  $('record-button-label').textContent = phase === 'recording' ? '録音を停止' : ['countdown', 'connecting'].includes(phase) ? 'キャンセル' : phase === 'monitoring' ? 'テストを終了' : phase === 'saving' ? '保存中…' : step === 'setup' ? 'マイクをテスト' : '録音をはじめる';
  $('record-hint').textContent = step === 'setup' ? '入力音量の確認のみ・保存されません' : '3秒のカウントダウン後に開始・29.9秒で自動停止';
  $('time-limit').textContent = step === 'setup' ? 'マイクテスト' : '録音上限 29.9秒';
  if (phase === 'idle') { $('level-meter').value = -60; $('level-db').textContent = '— dBFS'; }
}
function setTime(seconds) { $('time-display').textContent = `00:${seconds.toFixed(1).padStart(4, '0')}`; $('record-progress').value = seconds; }
async function enumerateMics() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try { const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput'); const value = $('microphone').value; $('microphone').replaceChildren(new Option('既定のマイク', '')); devices.forEach((d, i) => $('microphone').add(new Option(d.label || `マイク ${i + 1}`, d.deviceId))); if ([...$('microphone').options].some(o => o.value === value)) $('microphone').value = value; } catch { /* A recording can still use the default device. */ }
}
function microphoneError(error) {
  const errors = { NotAllowedError: 'マイクが許可されていません。ブラウザーのアドレスバーのサイト設定と、Windowsのマイク権限を確認してから再試行してください。', NotFoundError: 'マイクが見つかりません。接続を確認してください。', NotReadableError: 'マイクを使用できません。他の録音アプリを閉じて再試行してください。', OverconstrainedError: '選択したマイクを使用できません。「既定のマイク」に変更して再試行してください。' };
  return errors[error.name] || `録音を開始できませんでした。Chrome / Edge の最新版で http://127.0.0.1:4317 を開き、再試行してください。（${error.message}）`;
}
async function connectMicrophone(token) {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('マイクには localhost または HTTPS でのアクセスが必要です');
  const deviceId = $('microphone').value;
  const acquired = await navigator.mediaDevices.getUserMedia({ audio: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), channelCount: { ideal: 1 }, sampleRate: { ideal: 48000 }, echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
  if (token !== generation) { acquired.getTracks().forEach(track => track.stop()); return false; }
  stream = acquired; audioContext = new AudioContext({ sampleRate: 48000 }); await audioContext.resume();
  const context = audioContext; await context.audioWorklet.addModule('/capture-worklet.js');
  if (token !== generation) { await context.close().catch(() => {}); return false; }
  source = context.createMediaStreamSource(acquired); capture = new AudioWorkletNode(context, 'voice-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] }); mute = context.createGain(); mute.gain.value = 0;
  source.connect(capture).connect(mute).connect(context.destination);
  capture.port.onmessage = onCaptureMessage;
  const track = acquired.getAudioTracks()[0], settings = track.getSettings();
  captureSettings = { device: track.label, captureSampleRate: settings.sampleRate, outputSampleRate: context.sampleRate, channels: 1, bitDepth: 16, echoCancellation: settings.echoCancellation ?? null, noiseSuppression: settings.noiseSuppression ?? null, autoGainControl: settings.autoGainControl ?? null };
  $('format-label').textContent = `WAV · ${context.sampleRate / 1000} kHz · MONO · 16 BIT`;
  $('device-hint').textContent = track.label || 'マイクに接続しました。';
  const settingLabel = value => value === true ? 'ON' : value === false ? 'OFF' : '確認不可';
  $('actual-settings').textContent = `ブラウザーの実設定：ノイズ抑制 ${settingLabel(settings.noiseSuppression)} / エコー除去 ${settingLabel(settings.echoCancellation)} / 自動音量 ${settingLabel(settings.autoGainControl)}`;
  track.addEventListener('ended', () => { if (token !== generation) return; notice('マイクの接続が切れました。録音できた部分を保存します。'); if (phase === 'recording') { capture.port.postMessage({ type: 'stop' }); } else releaseMicrophone(); });
  context.onstatechange = () => { if (token === generation && ['suspended', 'interrupted'].includes(context.state) && phase === 'recording') { notice('録音が中断されました。ここまでの音声を保存します。内容を確認して録り直してください。'); finishRecording('interrupted'); } };
  await enumerateMics(); return token === generation;
}
function releaseMicrophone() {
  generation++; starting = false; stopping = false;
  if (capture) capture.port.onmessage = null;
  source?.disconnect(); capture?.disconnect(); mute?.disconnect();
  stream?.getTracks().forEach(track => track.stop());
  audioContext?.close().catch(() => {});
  stream = source = capture = mute = audioContext = null;
  $('countdown').hidden = true; currentWave = []; peak = 0; phase = 'idle'; updateControls();
}
async function begin() {
  notice(''); pausePlayers(); setTime(0); const token = ++generation; starting = true; phase = 'connecting'; updateControls();
  try {
    if (!await connectMicrophone(token)) return;
    if (step === 'setup') { starting = false; phase = 'monitoring'; updateControls(); return; }
    phase = 'countdown'; updateControls(); $('countdown').hidden = false;
    for (let count = 3; count > 0; count--) { if (token !== generation) return; $('countdown').textContent = count; await delay(1000); }
    if (token !== generation) return;
    $('countdown').hidden = true; captureKind = step; captureScript = step === 'consent' ? CONSENT_JA : $('sample-script').value; captureName = $('voice-name').value.trim() || 'my-voice'; chunks = []; frameCount = 0;
    phase = 'recording'; starting = false; updateControls();
    capture.port.postMessage({ type: 'start', maxFrames: Math.floor(audioContext.sampleRate * MAX_SECONDS) });
  } catch (error) { if (token !== generation) return; releaseMicrophone(); notice(microphoneError(error)); }
}
function onCaptureMessage({ data }) {
  if (data.type === 'meter') { currentWave = data.wave; peak = data.peak; const db = data.rms > 0 ? 20 * Math.log10(data.rms) : -60; $('level-meter').value = db; $('level-db').textContent = `${Math.max(-60, db).toFixed(0)} dBFS`; }
  if (data.type === 'chunk' && phase === 'recording') { chunks.push(data.chunk); frameCount += data.chunk.length; setTime(frameCount / audioContext.sampleRate); }
  if (data.type === 'stopped' && phase === 'recording') finishRecording(data.reason);
}
async function finishRecording(reason) {
  if (phase !== 'recording') return;
  const sampleRate = audioContext.sampleRate, settings = captureSettings;
  phase = 'saving'; updateControls();
  const samples = mergeChunks(chunks, Math.floor(sampleRate * MAX_SECONDS)); chunks = [];
  releaseMicrophone(); phase = 'saving'; updateControls();
  try {
    if (samples.length === 0) { notice('音声を取得できませんでした。マイクを確認し、もう一度録音してください。'); return; }
    const metrics = analyzeAudio(samples, sampleRate);
    const take = { id: crypto.randomUUID(), kind: captureKind, name: captureName, script: captureScript, createdAt: new Date().toISOString(), sampleRate, settings, metrics, stopReason: reason, blob: new Blob([encodeWav(samples, sampleRate)], { type: 'audio/wav' }) };
    takes.push(take); chosen[take.kind] = take.id; resetReview();
    if (database) { storageWrites++; try { await dbTransaction('readwrite', store => store.put(take)); } catch { storageFailure(); } finally { storageWrites--; } }
    else storageFailure();
    savePreferences(); setTime(metrics.duration);
    if (reason === 'limit') notice('29.9秒で自動停止しました。文の途中で切れていないか、最後まで試聴してください。');
  } catch (error) { notice(`録音の処理に失敗しました。もう一度録音してください。（${error.message}）`); }
  finally { phase = 'idle'; stopping = false; render(); }
}
function renderTakes() {
  const list = $('takes-list'); list.replaceChildren(); if (!['consent', 'sample'].includes(step)) return;
  const relevant = takes.filter(t => t.kind === step); $('take-count').textContent = relevant.length;
  if (!relevant.length) { list.append(textNode('p', '録音すると、ここで試聴・選択できます。', 'fine-print')); return; }
  relevant.forEach((take, index) => {
    const active = chosen[step] === take.id, row = textNode('article', '', `take${active ? ' selected' : ''}`), head = textNode('div', '', 'take-head'), label = document.createElement('label'), radio = document.createElement('input');
    radio.type = 'radio'; radio.name = 'selected-take'; radio.checked = active; radio.setAttribute('aria-label', `テイク ${String(index + 1).padStart(2, '0')} を選択`);
    radio.addEventListener('change', () => { chosen[step] = take.id; resetReview(); savePreferences(); render(); });
    label.append(radio, `テイク ${String(index + 1).padStart(2, '0')}`); head.append(label, textNode('span', new Date(take.createdAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }), 'take-time'));
    const metrics = textNode('p', `${take.metrics.duration.toFixed(1)}秒 · ${take.sampleRate / 1000} kHz · ${(take.blob.size / 1024).toFixed(0)} KB · ピーク ${take.metrics.peakDb.toFixed(1)} dBFS`, 'take-metrics');
    const audio = document.createElement('audio'); audio.controls = true; audio.preload = 'metadata'; audio.src = recordingUrl(take); audio.setAttribute('aria-label', `テイク ${index + 1} を試聴`);
    audio.addEventListener('play', () => document.querySelectorAll('audio').forEach(other => { if (other !== audio) other.pause(); }));
    const actions = textNode('div', '', 'take-actions'), link = textNode('a', '↓ WAVを保存'); link.href = recordingUrl(take); link.download = `${safeName(take.name)}_${take.kind}_${index + 1}.wav`;
    const remove = textNode('button', '削除'); remove.setAttribute('aria-label', `テイク ${index + 1} を削除`); remove.addEventListener('click', async () => {
      if (remove.dataset.confirm !== 'yes') { remove.dataset.confirm = 'yes'; remove.textContent = 'もう一度押して削除'; setTimeout(() => { if (remove.isConnected) { remove.dataset.confirm = ''; remove.textContent = '削除'; } }, 4000); return; }
      if (database) { try { await dbTransaction('readwrite', store => store.delete(take.id)); } catch { notice('保存済みテイクを削除できませんでした。再試行してください。'); return; } }
      audio.pause(); takes = takes.filter(t => t.id !== take.id); URL.revokeObjectURL(audioUrls.get(take.id)); audioUrls.delete(take.id);
      if (chosen[take.kind] === take.id) chosen[take.kind] = takes.filter(t => t.kind === take.kind).at(-1)?.id || null;
      resetReview(); savePreferences(); render();
    });
    actions.append(link, remove); if (active) actions.append(textNode('span', '✓ 書き出しに使用', 'take-summary'));
    row.append(head, metrics, audio);
    const notes = qualityNotes(take.metrics, take.kind); notes.forEach(note => row.append(textNode('p', note, 'quality-note')));
    if (!notes.length) row.append(textNode('p', '音量・長さの簡易チェックで注意点はありません。内容は試聴で確認してください。', 'quality-note ok'));
    row.append(actions); list.prepend(row);
  });
}
function renderExport() {
  $('export-files').replaceChildren();
  for (const kind of ['consent', 'sample']) {
    const take = selected(kind), card = textNode('div', '', 'export-file'); card.append(textNode('h3', kind === 'consent' ? '01  同意音声' : '02  声のサンプル'));
    if (take) {
      card.append(textNode('p', `${kind}.wav · ${take.metrics.duration.toFixed(1)}秒 · ${(take.blob.size / 1024).toFixed(0)} KB`));
      const audio = document.createElement('audio'); audio.controls = true; audio.src = recordingUrl(take); audio.preload = 'metadata'; audio.setAttribute('aria-label', `${kind === 'consent' ? '同意音声' : '声のサンプル'}を最終試聴`); audio.addEventListener('play', () => document.querySelectorAll('audio').forEach(other => { if (other !== audio) other.pause(); })); card.append(audio);
      qualityNotes(take.metrics, kind).forEach(note => card.append(textNode('p', note, 'quality-note')));
    } else card.append(textNode('p', 'まだ録音がありません。'));
    const change = textNode('button', take ? 'テイクを確認・変更 →' : '録音する →', 'secondary-button'); change.addEventListener('click', () => switchStep(kind)); card.append(change); $('export-files').append(card);
  }
  updateExportButton();
}
function updateExportButton() {
  const ready = selected('consent') && selected('sample'), reviewed = $('review-consent').checked && $('review-quality').checked;
  $('export-button').disabled = !ready || !reviewed;
  $('export-status').textContent = !ready ? '同意音声と声のサンプルを録音すると書き出せます。' : !reviewed ? '試聴後に、上の2つの確認項目にチェックを入れてください。' : '2本のWAVと録音情報を、ZIPファイルで保存します。';
}
function download(data, mime, name) { const url = URL.createObjectURL(new Blob([data], { type: mime })); const link = document.createElement('a'); link.href = url; link.download = name; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000); }
async function exportRecordings() {
  if ($('export-button').disabled) return;
  $('export-button').disabled = true;
  try {
    const consent = selected('consent'), sample = selected('sample'), name = safeName($('voice-name').value), exportedAt = new Date().toISOString();
    const metadata = { app: 'Voice Recorder for OpenAI', version: 1, voiceName: $('voice-name').value, exportedAt, guide: SOURCE_URL, documentationChecked: '2026-09-12', language: 'ja', reviewedByUser: { exactConsentAndSameSpeaker: true, playbackQuality: true }, automaticChecks: 'Level and duration heuristics only. No speech recognition, speaker verification, token counting, or eligibility verification.', recordings: [consent, sample].map(({ blob, ...take }) => ({ ...take, file: `${take.kind}.wav`, bytes: blob.size })) };
    const readme = `Voice Recorder for OpenAI — 録音セット\r\n\r\n声の名前: ${$('voice-name').value}\r\n書き出し日時: ${exportedAt}\r\n\r\nconsent.wav: 日本語の同意音声\r\nsample.wav: 同じ本人による声のサンプル\r\nrecording-info.json: 録音条件、簡易チェック結果、読み上げ用原稿（文字起こしではありません）\r\n\r\n登録の流れ\r\n1. OpenAIのカスタム音声の利用資格とプロジェクト権限を確認します。\r\n2. POST /v1/audio/voice_consents に name、language=ja、recording=consent.wav を送信します。\r\n3. 返された同意IDを指定し、POST /v1/audio/voices に name、consent、audio_sample=sample.wav を送信します。\r\n4. 作成されたvoice IDを保存します。APIキーは信頼できるサーバーで管理します。\r\n\r\n録音要件（確認日: 2026-09-12）\r\n同意音声は公式の指定文だけを本人が読みます。サンプルも同じ本人の声が必要です。\r\nサンプルは30秒以内。本ツールは余裕を持って29.9秒で停止し、非圧縮16-bit PCM、モノラルWAVで保存します。\r\nガイドのGPT-Live向け準備要件では、サンプルに5秒以上の実発話、15トークン以上の文字起こし相当の内容、10〜30秒の複数の文を求め、各アップロードは10 MiBまでとしています。\r\n本ツールは音声認識・トークン数・話者一致・文面の一致・利用資格を判定しません。activeSecondsは一定音量以上の区間の概算で、実発話時間ではありません。\r\n入力レベルやクリッピングの表示は目安です。最終的な録音内容と品質は試聴で確認してください。\r\n録音の外部送信やAPI登録は行っていません。ZIP自体はAPIへ送らず、展開したWAVを使用してください。\r\n\r\n最新の公式ガイド: ${SOURCE_URL}\r\n`;
    const zip = createZip([{ name: 'consent.wav', data: new Uint8Array(await consent.blob.arrayBuffer()) }, { name: 'sample.wav', data: new Uint8Array(await sample.blob.arrayBuffer()) }, { name: 'recording-info.json', data: JSON.stringify(metadata, null, 2) }, { name: 'README.txt', data: '\ufeff' + readme }]);
    download(zip, 'application/zip', `${name}_voice-recordings.zip`); $('export-status').textContent = 'ZIPのダウンロードを開始しました。保存先のファイルを確認してください。';
  } catch (error) { notice(`書き出しに失敗しました。各テイクのWAV保存も利用できます。（${error.message}）`); }
  finally { $('export-button').disabled = false; }
}
let lastPaint = 0;
function drawWave(timestamp) {
  requestAnimationFrame(drawWave); if (timestamp - lastPaint < 50 || step === 'export' || document.hidden) return; lastPaint = timestamp;
  const canvas = $('waveform'), rect = canvas.getBoundingClientRect(), ratio = window.devicePixelRatio || 1;
  if (!rect.width) return;
  if (canvas.width !== Math.round(rect.width * ratio) || canvas.height !== Math.round(rect.height * ratio)) { canvas.width = Math.round(rect.width * ratio); canvas.height = Math.round(rect.height * ratio); }
  const ctx = canvas.getContext('2d'); ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, rect.width, rect.height);
  const bars = Math.floor(rect.width / 5), center = rect.height / 2;
  for (let i = 0; i < bars; i++) {
    const value = currentWave.length ? Math.abs(currentWave[Math.floor(i / bars * currentWave.length)]) : 0;
    const height = Math.max(3, Math.min(rect.height - 12, value * rect.height * 3));
    ctx.fillStyle = currentWave.length ? peak > .98 ? '#d9543c' : phase === 'recording' ? '#d77b64' : '#8ba899' : '#d9dde3';
    ctx.beginPath(); ctx.roundRect(i * 5, center - height / 2, 2, height, 1); ctx.fill();
  }
}
$('consent-script').textContent = CONSENT_JA; $('sample-script').value = SAMPLE_JA;
document.querySelectorAll('[data-step]').forEach(button => button.addEventListener('click', () => switchStep(button.dataset.step)));
$('next-button').addEventListener('click', () => switchStep(steps[steps.indexOf(step) + 1]));
$('record-button').addEventListener('click', () => { if (phase === 'recording') { stopping = true; capture.port.postMessage({ type: 'stop' }); updateControls(); } else if (phase !== 'idle') releaseMicrophone(); else begin(); });
$('voice-name').addEventListener('input', savePreferences); $('sample-script').addEventListener('input', savePreferences);
$('reset-script').addEventListener('click', () => { $('sample-script').value = SAMPLE_JA; savePreferences(); });
for (const id of ['review-consent', 'review-quality']) $(id).addEventListener('change', updateExportButton);
$('export-button').addEventListener('click', exportRecordings);
window.addEventListener('beforeunload', event => { if (['recording', 'saving'].includes(phase) || storageWrites || (volatileStorage && takes.length)) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('pagehide', releaseMicrophone);
navigator.mediaDevices?.addEventListener('devicechange', enumerateMics);
render(); await initStorage(); await enumerateMics(); requestAnimationFrame(drawWave);
