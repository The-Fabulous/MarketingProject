@echo off
chcp 65001 >nul
cd /d "%~dp0"
title MarketingProject

where node >nul 2>nul || (echo Установите Node.js 22 или новее: https://nodejs.org & pause & exit /b 1)
where python >nul 2>nul || (echo Установите Python 3.12: https://www.python.org/downloads/ ^(при установке отметьте "Add python.exe to PATH"^) & pause & exit /b 1)

if not exist .env (
  copy .env.example .env >nul
  echo Впишите ключ Alem после OPENAI_API_KEY= и сохраните файл. Затем закройте Блокнот.
  notepad .env
)

if not exist .venv\Scripts\python.exe (
  echo Первый запуск: устанавливаю распознавание речи. Это займёт несколько минут...
  python -m venv .venv || goto fail
  .venv\Scripts\python -m pip install --disable-pip-version-check -r requirements.txt || goto fail
  where nvidia-smi >nul 2>nul && (
    echo Найдена видеокарта NVIDIA: ставлю библиотеки CUDA ^(~1 ГБ^)...
    .venv\Scripts\python -m pip install --disable-pip-version-check nvidia-cublas-cu12 "nvidia-cudnn-cu12==9.*" || goto fail
  )
)

start "Whisper - распознавание речи" cmd /k ".venv\Scripts\python stt_server.py"
start "Сайт" cmd /k "node --env-file=.env server.mjs"

echo Жду запуска. При первом запуске скачивается модель распознавания (~1.6 ГБ), это может занять 5-15 минут...
:wait
timeout /t 3 >nul
powershell -NoProfile -Command "foreach ($p in 8001, 3000) { try { (New-Object Net.Sockets.TcpClient).Connect('127.0.0.1', $p) } catch { exit 1 } }" || goto wait

set URL=http://localhost:3000/check
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (start "" "%ProgramFiles%\Google\Chrome\Application\chrome.exe" %URL%) else (start "" %URL%)
echo Готово: %URL%
echo Чтобы остановить, закройте окна "Whisper" и "Сайт".
timeout /t 10 >nul
exit /b 0

:fail
echo Установка не удалась. Посмотрите сообщение выше.
pause
exit /b 1
