import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from './server.mjs';

test('static allowlist, missing key, WAV forwarding and transcript response', async () => {
  let payload;
  const server = createServer({ env: { OPENAI_API_KEY: 'test-secret' }, request: async (url, options) => {
    assert.equal(url, 'https://llm.alem.ai/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer test-secret');
    payload = JSON.parse(options.body);
    return Response.json({ choices: [{ message: { content: 'Привет, мир.' } }] });
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base)).status, 200);
    assert.equal((await fetch(`${base}/.env`)).status, 404);
    const wav = Buffer.alloc(48); wav.write('RIFF'); wav.write('WAVE', 8);
    const response = await fetch(`${base}/api/transcribe`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav });
    assert.deepEqual(await response.json(), { text: 'Привет, мир.' });
    assert.equal(payload.model, 'gemma4');
    assert.equal(payload.messages[0].content[1].input_audio.data, wav.toString('base64'));
    assert.equal((await fetch(`${base}/api/transcribe`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: 'invalid' })).status, 400);
  } finally { await new Promise(resolve => server.close(resolve)); }
  const unconfigured = createServer({ env: {} });
  await new Promise(resolve => unconfigured.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${unconfigured.address().port}/api/transcribe`, { method: 'POST' });
    assert.equal(response.status, 503);
  } finally { await new Promise(resolve => unconfigured.close(resolve)); }
});
