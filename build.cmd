@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ============================================
echo   Ampwin build
echo ============================================
echo.

REM --- Node 20+ via nvm-windows, if present -------------------------------
where nvm >nul 2>nul
if %errorlevel%==0 (
  echo [1/5] Selecting Node 24.15.0 via nvm...
  call nvm use 24.15.0 >nul 2>nul
) else (
  echo [1/5] nvm not found; using whatever "node" is on PATH.
)

REM Confirm node is usable and new enough-ish
where node >nul 2>nul || (echo ERROR: node is not on PATH. & goto :error)
for /f "delims=" %%V in ('node --version') do echo       node %%V

REM --- Close any running Ampwin so its files aren't locked ------------------
echo [2/5] Closing any running Ampwin...
taskkill /IM Ampwin.exe /F >nul 2>nul

REM --- Dependencies --------------------------------------------------------
if not exist "node_modules" (
  echo [3/5] Installing dependencies ^(first run^)...
  call npm install || goto :error
) else (
  echo [3/5] Dependencies present ^(delete node_modules to force reinstall^).
)

REM --- Remove previous installer(s) so only the fresh build remains --------
echo [4/5] Clearing old installer output...
if exist "dist-installer\*.exe"      del /q "dist-installer\*.exe"      >nul 2>nul
if exist "dist-installer\*.blockmap" del /q "dist-installer\*.blockmap" >nul 2>nul

REM --- Build ---------------------------------------------------------------
echo [5/5] Building ^(electron-vite + electron-builder, ~1-2 min^)...
call npm run dist || goto :error

echo.
echo ============================================
echo   Build complete
echo ============================================
for %%F in ("dist-installer\*portable.exe") do echo   Portable  : %%~fF
for %%F in ("dist-installer\*Setup*.exe")    do echo   Installer : %%~fF
echo   Folder    : %CD%\dist-installer\win-unpacked\Ampwin.exe
echo.

REM --- Launch the freshly built app (remove these lines to skip) -----------
echo Launching...
start "" "%CD%\dist-installer\win-unpacked\Ampwin.exe"

endlocal
exit /b 0

:error
echo.
echo *** BUILD FAILED (exit code %errorlevel%) ***
echo Tip: close Ampwin if it's open, then run this again.
endlocal
exit /b 1
