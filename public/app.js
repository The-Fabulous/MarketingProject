import { encodeWav } from './wav.js';

const button = document.querySelector('#record');
const status = document.querySelector('#status');
const output = document.querySelector('#transcript');
let recorder, stream, timer, context;

async function toWav(blob) {
  context = new AudioContext({ sampleRate: 16000 });
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    const rendered = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
    const source = rendered.createBufferSource();
    source.buffer = decoded;
    source.connect(rendered.destination);
    source.start();
    return encodeWav((await rendered.startRendering()).getChannelData(0));
  } finally { await context.close(); context = null; }
}

button.addEventListener('click', async () => {
  if (recorder?.state === 'recording') { button.disabled = true; recorder.stop(); return; }
  button.disabled = true;
  status.textContent = 'Разрешите доступ к микрофону…';
  try {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error('Откройте страницу в Chrome или Edge через localhost или HTTPS.');
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const chunks = [];
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = async () => {
      clearTimeout(timer);
      stream.getTracks().forEach(track => track.stop());
      button.disabled = true;
      status.textContent = 'Расшифровываю запись…';
      try {
        const audio = await toWav(new Blob(chunks, { type: recorder.mimeType }));
        const response = await fetch('/api/transcribe', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: audio, signal: AbortSignal.timeout(100000) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Ошибка расшифровки.');
        output.value = result.text;
        status.textContent = result.text ? 'Расшифровка готова.' : 'Речь не обнаружена. Попробуйте ещё раз.';
      } catch (error) { status.textContent = error.message; }
      finally { button.textContent = 'Начать ввод микрофоном'; button.disabled = false; }
    };
    recorder.onerror = () => { status.textContent = 'Ошибка записи микрофона.'; if (recorder.state !== 'inactive') recorder.stop(); };
    recorder.start();
    button.textContent = 'Остановить и расшифровать';
    button.disabled = false;
    status.textContent = 'Идёт запись…';
    timer = setTimeout(() => { if (recorder.state === 'recording') { button.disabled = true; recorder.stop(); } }, 120000);
  } catch (error) {
    stream?.getTracks().forEach(track => track.stop());
    status.textContent = error.name === 'NotAllowedError' ? 'Доступ к микрофону запрещён. Разрешите его в браузере.' : error.message;
    button.disabled = false;
  }
});
window.addEventListener('pagehide', () => { clearTimeout(timer); stream?.getTracks().forEach(track => track.stop()); });
