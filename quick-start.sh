#!/bin/bash

echo "🏏 Cricket Stats AI - Quick Start Script"
echo "========================================"
echo ""

# Check if MongoDB is running
echo "Checking MongoDB connection..."
if ! mongosh --eval "db.version()" > /dev/null 2>&1; then
    echo "❌ MongoDB is not running. Please start MongoDB first."
    echo "   Run: mongod --dbpath /path/to/data"
    exit 1
fi
echo "✓ MongoDB is running"
echo ""

# Import data
echo "Step 1: Importing cricket data..."
cd scripts
if [ ! -f ".env" ]; then
    cp .env.example .env
    echo "Created scripts/.env - please configure if needed"
fi
npm install --silent
node import-data.js
cd ..
echo ""

# Setup backend
echo "Step 2: Setting up backend..."
cd backend
if [ ! -f ".env" ]; then
    cp .env.example .env
    echo "⚠️  Created backend/.env - PLEASE ADD YOUR GROQ_API_KEY!"
    echo "   Get FREE API key at: https://console.groq.com/"
    echo "   Edit backend/.env and add your key"
    exit 1
fi
npm install --silent
echo "✓ Backend dependencies installed"
cd ..
echo ""

# Setup frontend
echo "Step 3: Setting up frontend..."
cd frontend
if [ ! -f ".env.local" ]; then
    cp .env.example .env.local
fi
npm install --silent
echo "✓ Frontend dependencies installed"
cd ..
echo ""

echo "✅ Setup complete!"
echo ""
echo "To start the application:"
echo ""
echo "Terminal 1 (Backend):"
echo "  cd backend && npm run start:dev"
echo ""
echo "Terminal 2 (Frontend):"
echo "  cd frontend && npm run dev"
echo ""
echo "Then open: http://localhost:3000"
