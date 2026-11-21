@echo off
title FinSphere demo - stop
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-demo.ps1" %*
echo.
pause
