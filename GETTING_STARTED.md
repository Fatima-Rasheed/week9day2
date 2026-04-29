# Getting Started - Quick Guide

Welcome! This guide will get you up and running in 10 minutes.

## What You're Building

An AI-powered chat interface where users ask cricket statistics questions in natural language, and the system:
1. Validates the question is cricket-related
2. Converts it to a MongoDB query
3. Fetches the data
4. Returns a formatted answer (text or table)

## Prerequisites

Before starting, ensure you have:

- ✅ **Node.js 18+** installed ([Download](https://nodejs.org/))
- ✅ **MongoDB** running locally or MongoDB Atlas account ([Setup](https://www.mongodb.com/))
- ✅ **Groq API Key** ([Get one FREE](https://console.groq.com/))

## Quick Start (3 Steps)

### Step 1: Import Data (2 minutes)

```bash
cd scripts
npm install
cp .env.example .env
# Edit .env and set your MongoDB URI
npm run import
```

You should see:
```
✓ Imported 10 records into 'test' collection
✓ Imported 10 records into 'odi' collection
✓ Imported 10 records into 't20' collection
```

### Step 2: Start Backend (2 minutes)

```bash
cd backend
npm install
cp .env.example .env
# Edit .env and add your ANTHROPIC_API_KEY
npm run start:dev
```

You should see:
```
✓ Connected to MongoDB
🚀 Backend running on http://localhost:3001
```

### Step 3: Start Frontend (2 minutes)

```bash
cd frontend
npm install
cp .env.example .env.local
npm run dev
```

Open **http://localhost:3000** in your browser!

## Try It Out

Click on suggested questions or type your own:

- "Who has the highest score in Test cricket?"
- "Show me top 5 ODI run scorers"
- "List all Indian players in T20"

## How It Works

```
Your Question
    ↓
Frontend (Next.js) → Backend (NestJS) → LangGraph Workflow
                                            ↓
                                    5 AI Nodes Process:
                                    1. Check relevancy
                                    2. Generate MongoDB query
                                    3. Execute query
                                    4. Format answer
                                    5. Return result
                                            ↓
                                        MongoDB
                                            ↓
                                    Formatted Answer
```

## Project Structure

```
cricket-stats-ai/
├── backend/          # NestJS API (Port 3001)
├── frontend/         # Next.js UI (Port 3000)
├── scripts/          # Data import tools
├── data/             # CSV files with cricket stats
└── docs/             # All documentation
```

## Common Issues

### "MongoDB connection failed"
- Ensure MongoDB is running: `mongod`
- Check connection string in `.env` files

### "Groq API error"
- Verify your API key is correct
- Check you haven't exceeded rate limits (very generous on free tier)

### "Port already in use"
- Backend: Change `PORT` in `backend/.env`
- Frontend: Run `npm run dev -- -p 3002`

## Next Steps

1. **Read the docs**:
   - [SETUP.md](./SETUP.md) - Detailed setup instructions
   - [WORKFLOW.md](./WORKFLOW.md) - How the AI workflow works
   - [API.md](./API.md) - API documentation
   - [ARCHITECTURE.md](./ARCHITECTURE.md) - System architecture

2. **Customize**:
   - Add more cricket data to CSV files
   - Modify the UI styling
   - Add new query types
   - Implement caching

3. **Deploy**:
   - [DEPLOYMENT.md](./DEPLOYMENT.md) - Production deployment guide

## Example Questions to Try

### Simple Queries
- "Who scored the most runs in ODI?"
- "Highest score in Test cricket?"
- "How many centuries does Virat Kohli have?"

### Top N Queries
- "Top 5 ODI run scorers"
- "Best 10 Test batsmen"
- "Top 3 T20 players by strike rate"

### Filtered Queries
- "All Indian players in ODI"
- "Players with average above 50"
- "Australian batsmen in Test cricket"

### Format-Specific
- "Best ODI batsman"
- "Top T20 run scorer"
- "Test cricket highest score"

## Understanding the Response

### Text Response
For single values or specific information:
```
"Brian Lara holds the highest individual score 
in Test cricket with 400* against England."
```

### Table Response
For multiple records:
```
| Name             | Country   | Runs  | Average |
|------------------|-----------|-------|---------|
| Sachin Tendulkar | India     | 18426 | 44.83   |
| Virat Kohli      | India     | 13848 | 58.18   |
```

## Development Tips

### Hot Reload
Both frontend and backend support hot reload:
- Edit files and see changes instantly
- No need to restart servers

### Debugging
- **Backend logs**: Check terminal running `npm run start:dev`
- **Frontend logs**: Open browser DevTools console
- **MongoDB**: Use MongoDB Compass or `mongosh`

### Adding Data
1. Edit CSV files in `data/` folder
2. Run `cd scripts && npm run import`
3. Data is replaced (not appended)

## Architecture Overview

### Frontend (Next.js)
- **Port**: 3000
- **Main Component**: `ChatInterface.tsx`
- **Styling**: CSS Modules
- **API Client**: Axios

### Backend (NestJS)
- **Port**: 3001
- **Main Endpoint**: `POST /ask`
- **Workflow**: LangGraph (5 nodes)
- **AI**: Anthropic Claude

### Database (MongoDB)
- **Port**: 27017
- **Database**: cricket_stats
- **Collections**: test, odi, t20

## Key Files

| File | Purpose |
|------|---------|
| `backend/src/chat/langgraph.service.ts` | AI workflow logic |
| `frontend/src/components/ChatInterface.tsx` | Chat UI |
| `data/schema-description.json` | Database schema for AI |
| `scripts/import-data.js` | CSV to MongoDB importer |

## Performance

- **Average Response Time**: 3-5 seconds
- **AI Calls per Query**: 3 (relevancy, query gen, formatting)
- **Database Calls**: 1 per query

## Cost Estimation

### Development (Free)
- MongoDB: Free local or Atlas free tier
- Anthropic: ~$0.01 per query (pay as you go)

### Production (Monthly)
- VPS Hosting: ~$12
- MongoDB Atlas: Free tier or ~$57 for M10
- Anthropic API: Based on usage (~$6 per 1000 queries)

## Support & Resources

### Documentation
- [README.md](./README.md) - Project overview
- [SETUP.md](./SETUP.md) - Detailed setup
- [WORKFLOW.md](./WORKFLOW.md) - AI workflow explained
- [API.md](./API.md) - API reference
- [TESTING.md](./TESTING.md) - Testing guide
- [DEPLOYMENT.md](./DEPLOYMENT.md) - Deployment guide
- [ARCHITECTURE.md](./ARCHITECTURE.md) - System architecture

### External Resources
- [NestJS Docs](https://docs.nestjs.com/)
- [Next.js Docs](https://nextjs.org/docs)
- [MongoDB Docs](https://docs.mongodb.com/)
- [Anthropic API Docs](https://docs.anthropic.com/)

## What's Next?

### Immediate Improvements
1. Add more cricket data (expand CSV files)
2. Implement caching for common queries
3. Add user authentication
4. Improve error messages

### Advanced Features
1. Compare multiple players
2. Generate charts and visualizations
3. Support aggregation queries
4. Add real-time data updates
5. Multi-language support

### Production Readiness
1. Add rate limiting
2. Implement logging and monitoring
3. Set up CI/CD pipeline
4. Add automated tests
5. Security hardening

## Troubleshooting Checklist

If something doesn't work:

- [ ] Is MongoDB running? (`mongosh` to test)
- [ ] Is data imported? (Check MongoDB collections)
- [ ] Is backend running? (Visit http://localhost:3001/health)
- [ ] Is frontend running? (Visit http://localhost:3000)
- [ ] Are environment variables set? (Check .env files)
- [ ] Is API key valid? (Test in Anthropic console)
- [ ] Are ports available? (3000, 3001, 27017)
- [ ] Check logs for errors (terminal output)

## Success Checklist

You're ready when:

- ✅ MongoDB has 30 records (10 per collection)
- ✅ Backend starts without errors
- ✅ Frontend loads in browser
- ✅ Suggested questions work
- ✅ Custom questions return answers
- ✅ Tables render correctly
- ✅ Non-cricket questions are rejected

## Need Help?

1. Check the documentation files listed above
2. Review error messages in terminal/console
3. Verify all prerequisites are met
4. Check MongoDB and API connectivity

---

**Ready to build?** Start with Step 1 above! 🚀
