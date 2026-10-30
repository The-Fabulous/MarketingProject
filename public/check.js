import { encodeWav } from './wav.js';

const RATE = 16000, CHUNK = 60, OVERLAP = 4, PARALLEL = 3;
const DEFAULT_RULES = 'Мат и нецензурная лексика (в том числе завуалированная)\nСексуализация, сексуальные намёки\nОскорбления и унижение людей\nПризывы к насилию, разжигание ненависти';
const $ = selector => document.querySelector(selector);
const fileInput = $('#file'), rulesInput = $('#rules'), runButton = $('#run'), reportButton = $('#report'), status = $('#status');
const textBox = $('#text'), list = $('#findings'), drop = $('#drop'), progressBar = $('#progress');
let file, media, controller, phrases = [], failures = [], findings = [], selected = [], nextId = 0;

try { rulesInput.value = localStorage.getItem('rules') || DEFAULT_RULES; } catch { rulesInput.value = DEFAULT_RULES; }
rulesInput.addEventListener('input', () => { try { localStorage.setItem('rules', rulesInput.value); } catch {} });

// Тема: «Авто» следует за системой, выбор запоминается.
const themeButtons = document.querySelectorAll('.theme button');
const applyTheme = theme => {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme; else delete document.documentElement.dataset.theme;
  themeButtons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.theme === (theme || 'auto'))));
};
let savedTheme = 'auto';
try { savedTheme = localStorage.getItem('theme') || 'auto'; } catch {}
applyTheme(savedTheme);
themeButtons.forEach(button => button.addEventListener('click', () => {
  applyTheme(button.dataset.theme);
  try { localStorage.setItem('theme', button.dataset.theme); } catch {}
}));

['dragenter', 'dragover'].forEach(type => drop.addEventListener(type, () => drop.classList.add('over')));
['dragleave', 'drop'].forEach(type => drop.addEventListener(type, () => drop.classList.remove('over')));
const setRunLabel = running => { runButton.querySelector('span').textContent = running ? 'Остановить' : 'Проверить'; runButton.classList.toggle('stop', running); };
const setProgress = share => { progressBar.hidden = share == null; progressBar.firstElementChild.style.width = `${Math.round((share ?? 0) * 100)}%`; };

const clock = seconds => {
  const s = Math.max(0, Math.floor(seconds));
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map(n => String(n).padStart(2, '0')).join(':');
};
const seek = seconds => { if (!media) return; media.currentTime = Math.max(0, seconds - 0.5); media.play().catch(() => {}); };
const element = (tag, className, text) => Object.assign(document.createElement(tag), className ? { className } : {}, text != null ? { textContent: text } : {});

fileInput.addEventListener('change', () => {
  file = fileInput.files[0];
  if (media) { URL.revokeObjectURL(media.src); media.remove(); media = null; }
  runButton.disabled = !file;
  $('#layout').hidden = !file;
  phrases = []; failures = []; findings = []; selected = [];
  render();
  drop.classList.toggle('has-file', Boolean(file));
  $('#file-name').textContent = file ? file.name : 'Перетащите аудио или видео';
  $('#file-hint').textContent = file ? `${(file.size / 1024 / 1024).toFixed(1)} МБ · нажмите, чтобы заменить` : 'или нажмите, чтобы выбрать · MP3, WAV, M4A, MP4, WEBM';
  if (!file) return void (status.textContent = 'Выберите файл.');
  media = document.createElement(file.type.startsWith('video/') ? 'video' : 'audio');
  media.controls = true;
  media.src = URL.createObjectURL(file);
  media.addEventListener('timeupdate', follow);
  $('#player').append(media);
  status.textContent = `Файл: ${file.name}. Нажмите «Проверить».`;
});

async function extractAudio(blob) {
  const context = new AudioContext({ sampleRate: RATE });
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    const mono = new Float32Array(decoded.length);
    for (let c = 0; c < decoded.numberOfChannels; c++) {
      const data = decoded.getChannelData(c);
      for (let i = 0; i < data.length; i++) mono[i] += data[i] / decoded.numberOfChannels;
    }
    return mono;
  } catch {
    throw new Error('Не удалось извлечь звук. Поддерживаются MP3, WAV, M4A, OGG, MP4, WEBM; файлы других форматов сначала конвертируйте.');
  } finally { await context.close(); }
}

const toBase64 = blob => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result.split(',')[1]);
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

async function checkChunk(samples, rules, signal) {
  const body = JSON.stringify({ rules, audio: await toBase64(encodeWav(samples, RATE)) });
  for (let attempt = 0; ; attempt++) {
    const response = await fetch('/api/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal });
    const result = await response.json();
    if (response.ok) return result;
    if (attempt >= 1 || [400, 403, 413, 415, 503].includes(response.status)) throw new Error(result.error || 'Ошибка проверки.');
  }
}

// Где выделить цитату во фразе: точное совпадение, иначе слово с той же основой, иначе вся фраза.
function locate(text, quote) {
  const low = text.toLowerCase().replace(/ё/g, 'е'), q = quote.toLowerCase().replace(/ё/g, 'е').trim();
  const exact = q ? low.indexOf(q) : -1;
  if (exact >= 0) return [exact, exact + q.length];
  for (const token of q.split(/[^\p{L}\p{N}]+/u).filter(t => t.length >= 3)) {
    const match = new RegExp(`[\\p{L}\\p{N}]*${token.slice(0, Math.max(3, token.length - 2))}[\\p{L}\\p{N}]*`, 'u').exec(low);
    if (match) return [match.index, match.index + match[0].length];
  }
  return [0, text.length];
}

function phraseNode(phrase) {
  const p = element('p');
  p.dataset.phrase = phrase.id;
  const time = element('button', 'time', clock(phrase.start));
  time.type = 'button';
  time.dataset.time = phrase.start;
  p.append(time);
  if (phrase.error) return p.append(element('span', 'failed', `⚠ не проверено: ${phrase.error}`)), p;
  const ranges = [];
  for (const finding of findings.filter(f => f.phraseId === phrase.id)) {
    const [from, to] = locate(phrase.text, finding.quote);
    const overlap = ranges.find(r => from < r.to && to > r.from);
    if (overlap) overlap.ids.push(finding.id); else ranges.push({ from, to, ids: [finding.id] });
  }
  let position = 0;
  for (const range of ranges.sort((a, b) => a.from - b.from)) {
    const mark = element('mark', '', phrase.text.slice(range.from, range.to));
    mark.dataset.ids = range.ids.join(' ');
    p.append(phrase.text.slice(position, range.from), mark);
    position = range.to;
  }
  p.append(phrase.text.slice(position));
  return p;
}

function render() {
  findings.sort((a, b) => a.time - b.time);
  const parts = [...phrases, ...failures].sort((a, b) => a.start - b.start);
  textBox.replaceChildren(...(parts.length ? parts.map(phraseNode)
    : [element('p', 'empty', controller ? 'Распознаю речь…' : 'Нажмите «Проверить» — здесь появится расшифровка с выделенными нарушениями.')]));
  $('#count').textContent = findings.length;
  list.replaceChildren(...(findings.length ? findings.map(finding => {
    const li = element('li');
    li.dataset.id = finding.id;
    li.append(element('span', 'time', clock(finding.time)), element('span', 'quote', finding.quote || '—'),
      element('span', 'rule', finding.rule), element('span', 'reason', finding.reason));
    return li;
  }) : [element('li', 'none', controller ? 'Пока не найдено.' : 'Нарушений нет.')]));
  highlight(selected);
  follow();
}

function highlight(ids) {
  document.querySelectorAll('.active').forEach(el => el.classList.remove('active'));
  const items = ids.map(id => list.querySelector(`li[data-id="${id}"]`)).filter(Boolean);
  const marks = [...textBox.querySelectorAll('mark')].filter(mark => mark.dataset.ids.split(' ').some(id => ids.includes(id)));
  [...items, ...marks].forEach(el => el.classList.add('active'));
  return { items, marks };
}

// Выделить нарушение в тексте и в списке, прокрутить к нему вторую колонку и перемотать плеер.
function select(ids, scrollTo) {
  selected = ids;
  const { items, marks } = highlight(ids);
  if (scrollTo === 'list') items[0]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  if (scrollTo === 'text') marks[0]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  const finding = findings.find(f => f.id === ids[0]);
  if (finding) seek(finding.time);
}

function follow() {
  const t = media?.currentTime ?? -1;
  const current = phrases.find(p => t >= p.start && t < p.end);
  textBox.querySelectorAll('p.now').forEach(p => p.classList.remove('now'));
  if (current) textBox.querySelector(`p[data-phrase="${current.id}"]`)?.classList.add('now');
}

textBox.addEventListener('click', event => {
  const mark = event.target.closest('mark'), time = event.target.closest('button.time');
  if (mark) select(mark.dataset.ids.split(' '), 'list');
  else if (time) seek(Number(time.dataset.time));
});
list.addEventListener('click', event => {
  const item = event.target.closest('li[data-id]');
  if (item) select([item.dataset.id], 'text');
});

// Фрагменты перекрываются: каждый оставляет себе только фразы, начавшиеся в его половине перекрытия.
function addResult(start, from, to, result) {
  const ids = result.segments.map(s => start + s.start >= from && start + s.start < to ? `p${nextId++}` : null);
  result.segments.forEach((s, i) => { if (ids[i]) phrases.push({ id: ids[i], start: start + s.start, end: start + s.end, text: s.text }); });
  for (const v of result.violations) {
    if (ids[v.segment]) findings.push({ id: `f${nextId++}`, phraseId: ids[v.segment], time: start + v.start, rule: v.rule, quote: v.quote, reason: v.reason });
  }
}

runButton.addEventListener('click', async () => {
  if (controller) { controller.abort(); return; }
  const rules = rulesInput.value.split('\n').map(rule => rule.trim()).filter(Boolean);
  if (!rules.length) return void (status.textContent = 'Укажите хотя бы одно правило.');
  if (rules.length > 20) return void (status.textContent = 'Максимум 20 правил.');
  controller = new AbortController();
  const { signal } = controller;
  phrases = []; failures = []; findings = []; selected = [];
  reportButton.hidden = true;
  render();
  setRunLabel(true);
  setProgress(0);
  status.textContent = 'Извлекаю звук из файла…';
  try {
    const audio = await extractAudio(file);
    const step = (CHUNK - OVERLAP) * RATE, size = CHUNK * RATE;
    const starts = [];
    for (let i = 0; i === 0 || i + OVERLAP * RATE < audio.length; i += step) starts.push(i);
    let done = 0, failed = 0, next = 0;
    const progress = () => {
      status.textContent = `Проверено ${done} из ${starts.length} фрагментов · длительность ${clock(audio.length / RATE)}`;
      setProgress(done / starts.length);
    };
    progress();
    const worker = async () => {
      while (next < starts.length && !signal.aborted) {
        const index = next++, offset = starts[index], samples = audio.subarray(offset, offset + size), start = offset / RATE;
        const from = index ? start + OVERLAP / 2 : 0, to = index < starts.length - 1 ? starts[index + 1] / RATE + OVERLAP / 2 : Infinity;
        if (samples.reduce((peak, s) => Math.max(peak, Math.abs(s)), 0) >= 0.01) {
          try {
            addResult(start, from, to, await checkChunk(samples, rules, signal));
          } catch (error) {
            if (signal.aborted) return;
            failed++;
            failures.push({ id: `p${nextId++}`, start, error: error.message });
          }
        }
        done++;
        progress();
        render();
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    status.textContent = signal.aborted ? `Проверка остановлена. Проверено ${done} из ${starts.length} фрагментов.`
      : `Готово. Нарушений: ${findings.length}.` + (failed ? ` Не удалось проверить фрагментов: ${failed} — см. текст.` : '')
        + (phrases.length || failed ? '' : ' Речь не обнаружена.');
    reportButton.hidden = false;
  } catch (error) {
    status.textContent = error.message;
  } finally {
    controller = null;
    setRunLabel(false);
    setProgress(null);
    render();
  }
});

reportButton.addEventListener('click', () => {
  const lines = [`Файл: ${file.name}`, `Правила:`, ...rulesInput.value.split('\n').filter(r => r.trim()).map(r => `  - ${r.trim()}`), '', `Нарушения (${findings.length}):`,
    ...findings.map(f => `[${clock(f.time)}] ${f.rule}${f.quote ? ` — «${f.quote}»` : ''}${f.reason ? ` — ${f.reason}` : ''}`), '', 'Расшифровка:',
    ...[...phrases, ...failures].sort((a, b) => a.start - b.start).map(t => `[${clock(t.start)}] ${t.error ? `не проверено: ${t.error}` : t.text}`)];
  const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/plain' })), download: `${file.name}.report.txt` });
  link.click();
  URL.revokeObjectURL(link.href);
});
