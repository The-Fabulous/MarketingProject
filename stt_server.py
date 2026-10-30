"""Локальное бесплатное распознавание речи (faster-whisper) с OpenAI-совместимым /v1/audio/transcriptions.

Запуск: npm run stt   (или .venv\\Scripts\\python stt_server.py)
Настройки (переменные окружения): WHISPER_MODEL (large-v3-turbo), WHISPER_DEVICE (auto | cuda | cpu),
WHISPER_VAD (0 | 1 — фильтр тишины), STT_PORT (8001).
"""
import io
import json
import os
import re
import sys
import threading
from email.parser import BytesParser
from email.policy import HTTP
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# CUDA-библиотеки из pip-пакетов nvidia-* на Windows нужно явно добавить в путь поиска DLL.
for lib in ('cublas', 'cudnn'):
    for site in map(Path, sys.path):
        bin_dir = site / 'nvidia' / lib / 'bin'
        if bin_dir.is_dir():
            os.add_dll_directory(str(bin_dir))
            os.environ['PATH'] = f"{bin_dir}{os.pathsep}{os.environ['PATH']}"

import numpy as np
from faster_whisper import WhisperModel

MODEL = os.environ.get('WHISPER_MODEL', 'large-v3-turbo')
DEVICE = os.environ.get('WHISPER_DEVICE', 'auto')
PORT = int(os.environ.get('STT_PORT', '8001'))
# Фильтр тишины (VAD) вырезает пение под музыку, поэтому по умолчанию выключен; тихие фрагменты пропускает браузер.
VAD = os.environ.get('WHISPER_VAD', '0') == '1'
MAX_BODY = 50 * 1024 * 1024
# Фразы, которые Whisper выдумывает на музыке и тишине (наследие субтитров в обучающих данных).
HALLUCINATIONS = re.compile(r'субтитр|продолжение следует|подписывайтесь на канал|спасибо за просмотр|amara\.org', re.IGNORECASE)


def load_model():
    if DEVICE in ('auto', 'cuda'):
        try:
            model = WhisperModel(MODEL, device='cuda', compute_type='float16')
            list(model.transcribe(np.zeros(16000, dtype=np.float32))[0])  # проверка, что CUDA реально работает
            return model, 'cuda'
        except Exception as error:
            if DEVICE == 'cuda':
                raise
            print(f'Видеокарта недоступна ({error}), использую процессор.', flush=True)
    return WhisperModel(MODEL, device='cpu', compute_type='int8'), 'cpu'


print(f'Загружаю модель {MODEL} (при первом запуске она скачивается)…', flush=True)
model, device = load_model()
lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    def reply(self, code, value):
        body = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path.rstrip('/') != '/v1/audio/transcriptions':
            return self.reply(404, {'error': {'message': 'Not found'}})
        size = int(self.headers.get('Content-Length') or 0)
        content_type = self.headers.get('Content-Type', '')
        if not 0 < size <= MAX_BODY or not content_type.startswith('multipart/form-data'):
            return self.reply(400, {'error': {'message': 'Expected multipart/form-data up to 50 MB'}})
        form = BytesParser(policy=HTTP).parsebytes(f'Content-Type: {content_type}\r\n\r\n'.encode() + self.rfile.read(size))
        fields, granularities = {}, set()
        for part in form.iter_parts():
            name, value = part.get_param('name', header='content-disposition'), part.get_payload(decode=True)
            fields[name] = value
            if name == 'timestamp_granularities[]':
                granularities.add(value.decode().strip())
        if not fields.get('file'):
            return self.reply(400, {'error': {'message': 'Missing file'}})
        language = (fields.get('language') or b'').decode().strip() or None
        try:
            with lock:
                segments, _ = model.transcribe(io.BytesIO(fields['file']), language=language, beam_size=5, vad_filter=VAD,
                                               condition_on_previous_text=False, word_timestamps='word' in granularities)
                segments = [s for s in segments if s.text.strip() and not HALLUCINATIONS.search(s.text)]
        except Exception as error:
            return self.reply(400, {'error': {'message': f'Could not decode audio: {error}'}})
        result = {'text': ' '.join(s.text.strip() for s in segments),
                  'segments': [{'start': round(s.start, 2), 'end': round(s.end, 2), 'text': s.text.strip()} for s in segments]}
        if 'word' in granularities:
            result['words'] = [{'start': round(w.start, 2), 'end': round(w.end, 2), 'word': w.word.strip()} for s in segments for w in s.words or []]
        self.reply(200, result)

    def log_message(self, *args):
        pass


print(f'Распознавание речи: http://127.0.0.1:{PORT}/v1 (модель {MODEL}, {device})', flush=True)
ThreadingHTTPServer.allow_reuse_address = os.name != 'nt'  # на Windows иначе второй запуск молча занимает тот же порт
ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
