@echo off
title FinSphere demo launcher
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-demo.ps1" %*
echo.
pause
