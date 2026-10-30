import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from './server.mjs';

const wav = Buffer.alloc(48); wav.write('RIFF'); wav.write('WAVE', 8);
const listen = async server => { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}`; };
const close = server => new Promise(resolve => server.close(resolve));

test('static allowlist, missing key, WAV forwarding to speech recognition', async () => {
  let form;
  const server = createServer({ env: { OPENAI_API_KEY: 'test-secret', STT_API_KEY: 'stt-secret', STT_MODEL: 'whisper-x' }, request: async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:8001/v1/audio/transcriptions');
    assert.equal(options.headers.Authorization, 'Bearer stt-secret');
    form = options.body;
    return Response.json({ text: ' Привет, мир. ' });
  } });
  const base = await listen(server);
  try {
    assert.equal((await fetch(base)).status, 200);
    assert.equal((await fetch(`${base}/check`)).status, 200);
    assert.equal((await fetch(`${base}/.env`)).status, 404);
    const response = await fetch(`${base}/api/transcribe`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav });
    assert.deepEqual(await response.json(), { text: 'Привет, мир.' });
    assert.equal(form.get('model'), 'whisper-x');
    assert.deepEqual(Buffer.from(await form.get('file').arrayBuffer()), wav);
    assert.equal((await fetch(`${base}/api/transcribe`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: 'invalid' })).status, 400);
  } finally { await close(server); }
  const unconfigured = createServer({ env: {} });
  const other = await listen(unconfigured);
  try { assert.equal((await fetch(`${other}/api/transcribe`, { method: 'POST' })).status, 503); } finally { await close(unconfigured); }
});

test('rule check: transcribes, sends phrases and rules to Gemma, maps violations to phrase time', async () => {
  let prompt, reply = '```json\n{"violations":[{"segment":2,"rule":2,"quote":"дурак","reason":"Оскорбление"},{"segment":9,"rule":1},{"segment":1,"rule":7}]}\n```';
  const segments = [{ start: 0, end: 3.2, text: 'Привет всем.' }, { start: 3.2, end: 5, text: 'Ну ты и дурак.' }];
  const server = createServer({ env: { OPENAI_API_KEY: 'k' }, request: async (url, options) => {
    if (url.endsWith('/audio/transcriptions')) return Response.json({ text: 'Привет всем. Ну ты и дурак.', segments: segments.map(s => ({ ...s, id: 0 })),
      words: [['Привет', 0], ['всем.', 1], ['Ну', 3.2], ['ты', 3.5], ['и', 3.8], ['дурак.', 4.1]].map(([word, start]) => ({ word, start, end: start + 0.3 })) });
    assert.equal(url, 'https://llm.alem.ai/v1/chat/completions');
    prompt = JSON.parse(options.body).messages[0].content;
    return Response.json({ choices: [{ message: { content: reply } }] });
  } });
  const base = await listen(server);
  const check = body => fetch(`${base}/api/check`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const response = await check({ rules: ['Мат', 'Оскорбления', ' '], audio: wav.toString('base64') });
    assert.deepEqual(await response.json(), { segments, violations: [{ segment: 1, rule: 'Оскорбления', quote: 'дурак', start: 4.1, reason: 'Оскорбление' }] });
    assert.match(prompt, /1\. Мат\n2\. Оскорбления\n\n/);
    assert.match(prompt, /\[1\] Привет всем\.\n\[2\] Ну ты и дурак\./);
    assert.equal((await check({ rules: [], audio: wav.toString('base64') })).status, 400);
    assert.equal((await check({ rules: ['Мат'], audio: 'AAAA' })).status, 400);
    reply = 'Извините, не могу';
    assert.equal((await check({ rules: ['Мат'], audio: wav.toString('base64') })).status, 502);
  } finally { await close(server); }
});
