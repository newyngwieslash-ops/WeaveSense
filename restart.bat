@echo off
rem ===========================================================================
rem  Zhishi Loom - one-click (re)start on the fixed local port 8080
rem
rem  Behaviour
rem    port 8080 free                   -> start the whole stack
rem    port 8080 held by THIS app       -> kill that instance and restart it
rem    port 8080 held by ANYTHING ELSE  -> report an error, start nothing
rem
rem  How "is it this app?" is decided: Docker container identity, never the
rem  process name. With Docker Desktop the published port is owned by
rem  com.docker.backend (its port proxy), not by the container, so a
rem  process-name test would read our own app as a foreign process - and the
rem  earlier version of this script force-killed that owner, i.e. it could take
rem  the Docker engine down instead of the app.
rem
rem  This file was previously frozen by the project owner; 2026-09-24 it was
rem  rewritten on request to add the port-ownership rules above.
rem ===========================================================================
setlocal EnableExtensions
cd /d "%~dp0"

if /i "%~1"=="__RUN__" goto run
if /i "%~1"=="__CHECK_DOCKER__" goto check_docker
cmd /k call "%~f0" __RUN__
exit /b 0

:check_docker
call :refresh_path
where docker >nul 2>&1
if errorlevel 1 call :find_docker
where docker >nul 2>&1
if errorlevel 1 exit /b 1
call :ensure_docker
exit /b %errorlevel%

:run
title Zhishi Loom
color 07

set "PORT=8080"
set "APP_WAS_RUNNING=0"
set "PORT_OWNER_PID="
set "PORT_OWNER_NAME="
set "OTHER_CONTAINER="
set "LOG_DIR=artifacts\logs"
set "LOG_FILE=%LOG_DIR%\restart.log"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>&1

echo ========================================
echo   Zhishi Loom  restart  (Docker)
echo ========================================
echo.

call :refresh_path
call :log "--- restart.bat run --- cwd=%CD%"

if not exist "docker-compose.yml" goto err_nofile

rem The launcher promises a fixed port. If the compose file stopped publishing
rem it, stop here rather than silently come up somewhere the user did not ask for.
rem Ask compose for the resolved config and read it from a file: piping
rem `docker compose config` straight into a for /f hangs the script, and grepping
rem the compose text instead matched this file's own explanatory comment.
set "CFG_OUT=%TEMP%\loom-compose-config.txt"
del "%CFG_OUT%" >nul 2>&1
call :compose config >"%CFG_OUT%" 2>nul
set "PORT_MAPPED="
for /f "tokens=2 delims=: " %%P in ('findstr /c:"published:" "%CFG_OUT%" 2^>nul') do (
  if "%%~P"=="%PORT%" set "PORT_MAPPED=1"
)
del "%CFG_OUT%" >nul 2>&1
if not defined PORT_MAPPED goto err_portconfig

where docker >nul 2>&1
if errorlevel 1 call :find_docker
where docker >nul 2>&1
if errorlevel 1 goto err_nodocker

call :ensure_docker
if errorlevel 1 goto err_nodaemon

call :configure_local_defaults

set "COMPOSE_KIND=v2"
docker compose version >nul 2>&1
if errorlevel 1 goto try_legacy

:compose_ok
echo [2/5] Checking port %PORT% ownership...
call :detect_port
if "%APP_WAS_RUNNING%"=="1" goto port_ours
if defined PORT_OWNER_PID goto err_portbusy
goto port_free

:try_legacy
echo [WARN] docker compose v2 not available; trying docker-compose v1...
set "COMPOSE_KIND=legacy"
goto compose_ok

:port_ours
echo       Port %PORT% is this app. It will be killed and restarted.
rem No parentheses in these messages: a bare `echo %~1` inside :log treats
rem `(` as a block opener and the call produces no output at all - which is
rem why step 2 was missing from the log while every other step was present.
call :log "step 2: port %PORT% owned by this app, container %APP_CONTAINER:~0,12% - restart"
goto port_checked

:port_free
echo       Port %PORT% is free.
call :log "step 2: port %PORT% free - fresh start"
goto port_checked

:port_checked
echo [2/5] Stop old stack, keep volumes...
call :ensure_docker
if errorlevel 1 goto err_nodaemon
call :compose down
if errorlevel 1 echo [WARN] compose down failed, continue anyway.

echo [3/5] Build and start stack...
call :ensure_docker
if errorlevel 1 goto err_nodaemon
call :compose up --build -d
if not errorlevel 1 goto stack_started
echo [WARN] Build failed. Retrying with existing local images...
call :compose up --no-build -d
if errorlevel 1 goto err_up

:stack_started

echo [4/5] Waiting for http://127.0.0.1:%PORT% ...
call :log "step 4: wait for readiness"
set /a WAITED=0
set /a MAXWAIT=600

:wait_loop
curl.exe -sf --max-time 2 http://127.0.0.1:%PORT%/ >nul 2>&1
if not errorlevel 1 goto ready
call :sleep 3
set /a WAITED+=3
if %WAITED% LSS %MAXWAIT% goto wait_loop
goto err_timeout

:ready
echo [5/5] Ready, opening browser...
call :log "step 5: ready after %WAITED%s; opening browser"
start "" "http://127.0.0.1:%PORT%"
echo.
echo Opened http://127.0.0.1:%PORT%
echo Log: %LOG_FILE%
echo Telegram login is still manual. See the docs folder.
echo Close this window or Ctrl+C stops logs only, not containers.
echo.
call :compose logs -f
echo.
echo Done. Press any key to close.
pause >nul
exit /b 0

rem --------------------------------------------------------------------------
rem  Port ownership. Sets APP_WAS_RUNNING=1 when the published port belongs to
rem  this compose project's app container; otherwise leaves PORT_OWNER_PID set
rem  for the caller to report.
rem --------------------------------------------------------------------------
:detect_port
for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)" 2^>nul`) do set "PORT_OWNER_PID=%%P"

set "APP_CONTAINER="
for /f "usebackq delims=" %%C in (`docker compose ps -q app 2^>nul`) do set "APP_CONTAINER=%%C"
set "PUB_CONTAINER="
rem The quotes around "publish=%PORT%" are required: without them cmd eats the
rem `=` inside a for /f backquote and the filter silently matches nothing,
rem which made our own app look like a foreign process.
for /f "usebackq delims=" %%C in (`docker ps --filter "publish=%PORT%" -q 2^>nul`) do set "PUB_CONTAINER=%%C"

rem Compare on the 12-char short id: `compose ps -q` prints 64 chars, `docker ps -q` 12.
set "A12="
set "P12="
if defined APP_CONTAINER set "A12=%APP_CONTAINER:~0,12%"
if defined PUB_CONTAINER set "P12=%PUB_CONTAINER:~0,12%"
if defined A12 if defined P12 if /i "%A12%"=="%P12%" set "APP_WAS_RUNNING=1"

if not defined PORT_OWNER_PID exit /b 0
if "%APP_WAS_RUNNING%"=="1" exit /b 0

rem Not ours. Record what holds it, preferring the container name when the
rem owner is another Docker project, so the error can actually name it.
for /f "usebackq delims=" %%N in (`docker ps --filter "publish=%PORT%" --format "{{.Names}}" 2^>nul`) do set "OTHER_CONTAINER=%%N"
if defined OTHER_CONTAINER exit /b 0
for /f "tokens=1 delims=," %%N in ('tasklist /fi "PID eq %PORT_OWNER_PID%" /fo csv /nh 2^>nul') do set "PORT_OWNER_NAME=%%~N"
exit /b 0

rem ---------------------------------- errors ---------------------------------
:err_nofile
echo [ERROR] docker-compose.yml not found.
echo Put restart.bat in the project root, then double-click again.
call :log "FATAL docker-compose.yml not found"
goto fail

:err_portconfig
echo [ERROR] docker-compose.yml no longer publishes port %PORT%.
echo         This launcher starts the app on the fixed port %PORT%; refusing to
echo         start it somewhere else. Update the port here and in the compose
echo         file together if %PORT% is really being changed.
call :log "FATAL compose no longer publishes %PORT%"
goto fail

:err_nodocker
echo [ERROR] Docker not found in PATH.
echo Install Docker Desktop, start it, then double-click again.
call :log "FATAL docker not found in PATH"
goto fail

:err_nodaemon
echo [ERROR] Docker engine did not become ready after automatic recovery.
echo Open Docker Desktop once, then retry. Volumes were not removed.
goto fail

:err_portbusy
echo.
echo [ERROR] Port %PORT% is in use by something that is NOT this app.
echo.
if defined OTHER_CONTAINER echo         Docker container : %OTHER_CONTAINER%
if defined PORT_OWNER_NAME echo         Process          : %PORT_OWNER_NAME%  (PID %PORT_OWNER_PID%)
if not defined PORT_OWNER_NAME if not defined OTHER_CONTAINER echo         PID              : %PORT_OWNER_PID%
echo         Local address    : 127.0.0.1:%PORT%
echo.
echo         Nothing was stopped and the app was NOT started. Free that port
echo         (or stop the other app), then run this script again.
call :log "FATAL port %PORT% busy: container=%OTHER_CONTAINER% process=%PORT_OWNER_NAME% pid=%PORT_OWNER_PID%"
goto fail

:err_up
echo [ERROR] docker compose up failed. Scroll up for the log.
call :log "FATAL compose up failed"
goto fail

:err_timeout
echo [ERROR] Control plane not ready after about 10 minutes.
echo Containers were left running. Check: docker compose logs
call :log "FATAL not ready after %MAXWAIT%s"
goto fail

:fail
echo.
echo Log: %LOG_FILE%
echo Press any key to close.
pause >nul
exit /b 1

rem --------------------------------- helpers ---------------------------------
:log
echo %~1
>>"%LOG_FILE%" echo [%DATE% %TIME%] %~1
exit /b 0

:sleep
rem %1 = seconds. Used by the readiness wait loop.
powershell -NoProfile -Command "Start-Sleep -Seconds %~1" >nul 2>&1
exit /b 0

:compose
if /i "%COMPOSE_KIND%"=="legacy" goto compose_legacy
docker compose %*
goto compose_done
:compose_legacy
docker-compose %*
:compose_done
exit /b %errorlevel%

:ensure_docker
docker info >nul 2>&1
if not errorlevel 1 exit /b 0

echo [INFO] Docker engine is unavailable. Starting Docker Desktop...
docker desktop start >nul 2>&1
if errorlevel 1 call :start_docker_desktop
call :wait_docker 30
if not errorlevel 1 exit /b 0

echo [WARN] Docker Desktop is running without an engine. Cold restarting it...
docker desktop stop --force >nul 2>&1
docker desktop start >nul 2>&1
if errorlevel 1 call :start_docker_desktop
call :wait_docker 180
exit /b %errorlevel%

:wait_docker
set /a DOCKER_WAITED=0
:wait_docker_loop
docker info >nul 2>&1
if not errorlevel 1 exit /b 0
if %DOCKER_WAITED% GEQ %~1 exit /b 1
timeout /t 3 /nobreak >nul
set /a DOCKER_WAITED+=3
goto wait_docker_loop

:start_docker_desktop
if exist "C:\Program Files\Docker\Docker\Docker Desktop.exe" start "" /b "C:\Program Files\Docker\Docker\Docker Desktop.exe"
exit /b 0

:configure_local_defaults
set "LOCAL_SECRET="
for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "[guid]::NewGuid().ToString('N')"`) do set "LOCAL_SECRET=%%I"
if not defined LOCAL_SECRET set "LOCAL_SECRET=%RANDOM%%RANDOM%%RANDOM%%RANDOM%"
if not defined CRON_SECRET set "CRON_SECRET=local-cron-%LOCAL_SECRET%"
if not defined WECHAT_GATEWAY_TOKEN set "WECHAT_GATEWAY_TOKEN=local-gateway-%LOCAL_SECRET%"
if not defined WECHAT_PRIMARY_ALLOWED_HOSTS set "WECHAT_PRIMARY_ALLOWED_HOSTS=wechat-fixture"
exit /b 0

:find_docker
if exist "C:\Program Files\Docker\Docker\resources\bin\docker.exe" set "PATH=C:\Program Files\Docker\Docker\resources\bin;%PATH%"
if exist "E:\DockerThings\DockerAnZhuang\resources\bin\docker.exe" set "PATH=E:\DockerThings\DockerAnZhuang\resources\bin;%PATH%"
exit /b 0

:refresh_path
for /f "tokens=2*" %%A in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v PATH 2^>nul ^| findstr /i "PATH"') do set "PATH=%%B;%PATH%"
for /f "tokens=2*" %%A in ('reg query "HKCU\Environment" /v PATH 2^>nul ^| findstr /i "PATH"') do set "PATH=%%B;%PATH%"
exit /b 0
