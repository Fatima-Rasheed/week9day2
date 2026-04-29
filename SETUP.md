# Setup Guide

## Prerequisites

- Node.js 18+ and npm
- MongoDB (local or cloud instance)
- Anthropic API key (for Claude AI)

## Step-by-Step Setup

### 1. MongoDB Setup

Start MongoDB locally or use MongoDB Atlas (cloud):

```bash
# Local MongoDB (if installed)
mongod --dbpath /path/to/data

# Or use MongoDB Atlas and get your connection string
```

### 2. Import Cricket Data

```bash
cd scripts
npm install
cp .env.example .env
# Edit .env and set MONGODB_URI
npm run import
```

Expected output:
```
✓ Imported 10 records into 'test' collection
✓ Imported 10 records into 'odi' collection
✓ Imported 10 records into 't20' collection
✓ All data imported successfully!
```

### 3. Backend Setup

```bash
cd backend
npm install
cp .env.example .env
```

Edit `backend/.env`:
```
MONGODB_URI=mongodb://localhost:27017/cricket_stats
GROQ_API_KEY=your_actual_api_key_here
PORT=3001
```

Start the backend:
```bash
npm run start:dev
```

You should see:
```
✓ Connected to MongoDB
🚀 Backend running on http://localhost:3001
```

### 4. Frontend Setup

```bash
cd frontend
npm install
cp .env.example .env.local
```

Edit `frontend/.env.local`:
```
NEXT_PUBLIC_API_URL=http://localhost:3001
```

Start the frontend:
```bash
npm run dev
```

Open http://localhost:3000 in your browser.

## Testing the System

Try these questions in the chat interface:

1. "Who has the highest score in Test cricket?"
2. "Show me top 5 ODI run scorers"
3. "List all Indian players in ODI"
4. "How many centuries does Virat Kohli have?"

## Troubleshooting

### MongoDB Connection Issues
- Ensure MongoDB is running
- Check the connection string in .env files
- Verify network access if using MongoDB Atlas

### Backend API Errors
- Check if ANTHROPIC_API_KEY is set correctly
- Verify MongoDB data was imported successfully
- Check backend logs for detailed error messages

### Frontend Not Connecting
- Ensure backend is running on port 3001
- Check NEXT_PUBLIC_API_URL in .env.local
- Check browser console for CORS errors

## Architecture Overview

```
User Question
    ↓
Next.js Frontend (Port 3000)
    ↓
NestJS Backend (Port 3001)
    ↓
LangGraph Workflow:
    1. Relevancy Checker → Is it cricket-related?
    2. Query Generator → Convert to MongoDB query
    3. Query Executor → Run against MongoDB
    4. Answer Formatter → Format as text/table
    5. Final Response → Return to user
    ↓
MongoDB (cricket_stats database)
```

## Adding More Data

To add more cricket players:

1. Edit CSV files in `data/` folder
2. Run the import script again:
   ```bash
   cd scripts
   npm run import
   ```

The script will replace existing data with new data.
