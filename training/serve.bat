@echo off
REM  ECNet inference server. Frees port 8000, then serves a checkpoint.
REM    serve                                   -> models\ECNet-7.pt (default)
REM    serve models\your.pt                    -> any checkpoint
REM    serve models\ECNet-7.pt --fake-above 80 -> override the AI threshold live
setlocal

set "CKPT=%~1"
if "%CKPT%"=="" set "CKPT=models\ECNet-7.pt"
if /I "%CKPT%"=="ecnet7" set "CKPT=models\ECNet-7.pt"

if not exist "%CKPT%" (
  echo ERROR: checkpoint not found: %CKPT%
  exit /b 1
)

echo Freeing port 8000 ...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr :8000 ^| findstr LISTENING') do taskkill /PID %%p /F >nul 2>&1

echo Starting server with %CKPT% %2 %3 %4 %5
python -m src.server --checkpoint "%CKPT%" %2 %3 %4 %5 %6 %7 %8 %9
