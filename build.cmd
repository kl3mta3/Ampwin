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
  echo [1/6] Selecting Node 24.15.0 via nvm...
  call nvm use 24.15.0 >nul 2>nul
) else (
  echo [1/6] nvm not found; using whatever "node" is on PATH.
)

where node >nul 2>nul || (echo ERROR: node is not on PATH. & goto :error)
for /f "delims=" %%V in ('node --version') do echo       node %%V

REM --- Close any running Ampwin / stray electron so build files aren't locked.
REM     We launch the PORTABLE at the end (runs from %TEMP%), never win-unpacked,
REM     so the build output never stays locked between runs. Give Windows a
REM     moment to release handles (Defender/SearchIndexer scan freshly written files).
echo [2/6] Closing any running Ampwin / electron...
taskkill /IM Ampwin.exe /F >nul 2>nul
taskkill /IM electron.exe /F >nul 2>nul
ping -n 3 127.0.0.1 >nul

REM --- Dependencies --------------------------------------------------------
if not exist "node_modules" (
  echo [3/6] Installing dependencies ^(first run^)...
  call npm install || goto :error
) else (
  echo [3/6] Dependencies present ^(delete node_modules to force reinstall^).
)

REM --- Clean the scratch build folder (safe: nothing runs from it) ---------
echo [4/6] Clearing scratch build folder...
if exist "dist-build" rmdir /s /q "dist-build" >nul 2>nul

REM --- Build (electron-vite compile + electron-builder package) ------------
echo [5/6] Building ^(electron-vite + electron-builder, ~1-2 min^)...
call npm run dist || goto :error

REM --- Deliver just the installers to dist-installer -----------------------
echo [6/6] Copying installers to dist-installer...
if not exist "dist-installer" mkdir "dist-installer"
del /q "dist-installer\*.exe"      >nul 2>nul
del /q "dist-installer\*.blockmap" >nul 2>nul
copy /y "dist-build\*.exe"      "dist-installer\" >nul || goto :error
copy /y "dist-build\*.blockmap" "dist-installer\" >nul 2>nul

echo.
echo ============================================
echo   Build complete
echo ============================================
for %%F in ("dist-installer\*portable.exe") do echo   Portable  : %%~fF
for %%F in ("dist-installer\*Setup*.exe")    do echo   Installer : %%~fF
echo   ^(folder build: %CD%\dist-build\win-unpacked\Ampwin.exe^)
echo.

REM --- Launch the PORTABLE (extracts to %TEMP%; does NOT lock the build
REM     output, so the next build won't be blocked). -------------------------
echo Launching portable...
for %%F in ("dist-installer\*portable.exe") do start "" "%%~fF"

endlocal
exit /b 0

:error
echo.
echo *** BUILD FAILED (exit code %errorlevel%) ***
echo Tip: close Ampwin if it's open, then run this again.
echo      If it keeps failing on a locked file, add a Microsoft Defender
echo      exclusion for this folder (Windows Security ^> Virus ^& threat
echo      protection ^> Manage settings ^> Exclusions), or reboot to clear
echo      the stale lock on dist-installer\win-unpacked.
endlocal
exit /b 1
