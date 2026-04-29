@echo off
echo 🏏 Cricket Stats AI - Quick Start Script
echo ========================================
echo.

REM Import data
echo Step 1: Importing cricket data...
cd scripts
if not exist ".env" (
    copy .env.example .env
    echo Created scripts/.env - please configure if needed
)
call npm install
call node import-data.js
cd ..
echo.

REM Setup backend
echo Step 2: Setting up backend...
cd backend
if not exist ".env" (
    copy .env.example .env
    echo ⚠️  Created backend/.env - PLEASE ADD YOUR GROQ_API_KEY!
    echo    Get FREE API key at: https://console.groq.com/
    echo    Edit backend/.env and add your key
    pause
    exit /b 1
)
call npm install
echo ✓ Backend dependencies installed
cd ..
echo.

REM Setup frontend
echo Step 3: Setting up frontend...
cd frontend
if not exist ".env.local" (
    copy .env.example .env.local
)
call npm install
echo ✓ Frontend dependencies installed
cd ..
echo.

echo ✅ Setup complete!
echo.
echo To start the application:
echo.
echo Terminal 1 (Backend):
echo   cd backend ^&^& npm run start:dev
echo.
echo Terminal 2 (Frontend):
echo   cd frontend ^&^& npm run dev
echo.
echo Then open: http://localhost:3000
pause
