@echo off
setlocal EnableExtensions
cd /d "%~dp0"

if /i "%~1"=="__RUN__" goto run
cmd /k call "%~f0" __RUN__
exit /b 0

:run
title Zhishi Loom
color 07

echo ========================================
echo   Zhishi Loom  restart  (Docker)
echo ========================================
echo.

call :refresh_path

if not exist "docker-compose.yml" goto err_nofile

where docker >nul 2>&1
if errorlevel 1 call :find_docker
where docker >nul 2>&1
if errorlevel 1 goto err_nodocker

docker info >nul 2>&1
if errorlevel 1 goto err_nodaemon

set "COMPOSE_KIND=v2"
docker compose version >nul 2>&1
if errorlevel 1 goto try_legacy
goto compose_ok

:try_legacy
docker-compose version >nul 2>&1
if errorlevel 1 goto err_nocompose
set "COMPOSE_KIND=legacy"

:compose_ok
echo [1/5] Free port 8080 if needed...
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }" >nul 2>&1

echo [2/5] Stop old stack, keep volumes...
call :compose down
if errorlevel 1 echo [WARN] compose down failed, continue anyway.

echo [3/5] Build and start stack...
call :compose up --build -d
if errorlevel 1 goto err_up

echo [4/5] Waiting for http://127.0.0.1:8080 ...
set /a WAITED=0
set /a MAXWAIT=600

:wait_loop
curl.exe -sf --max-time 2 http://127.0.0.1:8080/ >nul 2>&1
if not errorlevel 1 goto ready
timeout /t 3 /nobreak >nul
set /a WAITED+=3
if %WAITED% LSS %MAXWAIT% goto wait_loop
goto err_timeout

:ready
echo [5/5] Ready, opening browser...
start "" "http://127.0.0.1:8080"
echo.
echo Opened http://127.0.0.1:8080
echo Telegram login is still manual. See the docs folder.
echo Close this window or Ctrl+C stops logs only, not containers.
echo.
call :compose logs -f
echo.
echo Done. Press any key to close.
pause >nul
exit /b 0

:err_nofile
echo [ERROR] docker-compose.yml not found.
echo Put restart.bat in the project root, then double-click again.
goto fail

:err_nodocker
echo [ERROR] Docker not found in PATH.
echo Install Docker Desktop, start it, then double-click again.
goto fail

:err_nodaemon
echo [ERROR] Docker engine is not running.
echo Start Docker Desktop, wait until it is ready, then retry.
goto fail

:err_nocompose
echo [ERROR] Docker Compose not found.
goto fail

:err_up
echo [ERROR] docker compose up failed. Scroll up for the log.
goto fail

:err_timeout
echo [ERROR] Control plane not ready after about 10 minutes.
echo Containers were left running. Check: docker compose logs
goto fail

:fail
echo.
echo Press any key to close.
pause >nul
exit /b 1

:compose
if /i "%COMPOSE_KIND%"=="legacy" goto compose_legacy
docker compose %*
goto compose_done
:compose_legacy
docker-compose %*
:compose_done
exit /b %errorlevel%

:find_docker
if exist "C:\Program Files\Docker\Docker\resources\bin\docker.exe" set "PATH=C:\Program Files\Docker\Docker\resources\bin;%PATH%"
if exist "E:\DockerThings\DockerAnZhuang\resources\bin\docker.exe" set "PATH=E:\DockerThings\DockerAnZhuang\resources\bin;%PATH%"
exit /b 0

:refresh_path
for /f "tokens=2*" %%A in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v PATH 2^>nul ^| findstr /i "PATH"') do set "PATH=%%B;%PATH%"
for /f "tokens=2*" %%A in ('reg query "HKCU\Environment" /v PATH 2^>nul ^| findstr /i "PATH"') do set "PATH=%%B;%PATH%"
exit /b 0
