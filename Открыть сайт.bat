@echo off
chcp 65001 >nul
title Сайт Жанары
cd /d "%~dp0"
set "PATH=C:\Program Files\nodejs;%PATH%"

rem Already running (for example as the ZhanaraSite scheduled task): just open it.
curl.exe -s -o nul -m 3 http://127.0.0.1:3000/api/live && (
  start "" http://localhost:3000
  exit /b 0
)

if not exist "node_modules\vite" (
  echo Устанавливаю зависимости, это нужно один раз...
  call npm install
)

echo Собираю сайт...
call npm run build
if errorlevel 1 (
  echo.
  if exist "dist\index.html" (
    echo Не удалось собрать новую версию, запускаю прошлую сборку.
    echo Покажи это окно разработчику.
  ) else (
    echo Не удалось собрать сайт. Покажи это окно разработчику.
    pause
    exit /b 1
  )
)

echo.
echo Запускаю сайт под присмотром супервизора: после сбоя он перезапустится сам.
echo Чтобы сайт запускался без этого окна и после перезагрузки компьютера,
echo один раз выполни: powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
echo.
echo Сайт:    http://localhost:3000
echo Админка: http://localhost:3000/admin
echo.

start "" http://localhost:3000
node scripts\supervisor.js

echo.
echo Сервер остановлен. Чтобы снова открыть сайт, запусти этот файл ещё раз.
pause
