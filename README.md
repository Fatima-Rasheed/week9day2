# 🏏 AI-Powered Cricket Stats System

A complete full-stack application that allows users to query cricket statistics using natural language, powered by LangGraph AI workflow and Claude.

## ✨ Features

- 🤖 **AI-Powered**: Natural language question processing with Groq (FREE & FAST!)
- 📊 **Smart Formatting**: Automatic text or table responses
- 🔍 **Intelligent Queries**: Converts questions to MongoDB queries
- 🏏 **Multi-Format**: Supports Test, ODI, and T20 cricket stats
- ⚡ **Real-time**: Ultra-fast responses with Groq's inference
- 🎨 **Modern UI**: Clean, responsive chat interface
- 💰 **Free to Run**: Groq API is free with generous limits!

## 🚀 Quick Start

**Get running in 3 steps:**

```bash
# 1. Import cricket data
cd scripts && npm install && npm run import

# 2. Start backend (get FREE Groq API key at console.groq.com)
cd ../backend && npm install && npm run start:dev

# 3. Start frontend
cd ../frontend && npm install && npm run dev
```

Open **http://localhost:3000** and start asking questions!

**New to Groq?** Check [GROQ_SETUP.md](./GROQ_SETUP.md) for a 2-minute setup guide.

## 📚 Documentation

We have comprehensive documentation to help you:

- **[GROQ_SETUP.md](./GROQ_SETUP.md)** - Get your FREE Groq API key (2 min) ⭐
- **[WHY_GROQ.md](./WHY_GROQ.md)** - Why Groq is perfect for this project
- **[GETTING_STARTED.md](./GETTING_STARTED.md)** - 10-minute quick start guide
- **[SETUP.md](./SETUP.md)** - Detailed setup instructions
- **[WORKFLOW.md](./WORKFLOW.md)** - How the AI workflow works
- **[API.md](./API.md)** - API documentation
- **[ARCHITECTURE.md](./ARCHITECTURE.md)** - System architecture
- **[VISUAL_GUIDE.md](./VISUAL_GUIDE.md)** - Visual diagrams and UI mockups
- **[TESTING.md](./TESTING.md)** - Testing guide
- **[DEPLOYMENT.md](./DEPLOYMENT.md)** - Production deployment
- **[DOCUMENTATION_INDEX.md](./DOCUMENTATION_INDEX.md)** - Complete documentation index

**Total: 77 pages of documentation** covering everything you need!

## 🏗️ Architecture

```
User Question → Next.js Frontend → NestJS Backend → LangGraph Workflow
                                                            ↓
                                                    5 AI Nodes:
                                                    1. Relevancy Check
                                                    2. Query Generation
                                                    3. Query Execution
                                                    4. Answer Formatting
                                                    5. Final Response
                                                            ↓
                                                        MongoDB
```

## 📁 Project Structure

```
cricket-stats-ai/
├── backend/          # NestJS API with LangGraph workflow
├── frontend/         # Next.js chat interface
├── scripts/          # MongoDB data import tools
├── data/             # Sample cricket statistics (30 players)
└── docs/             # 11 comprehensive documentation files
```

## 🛠️ Technology Stack

- **Frontend**: Next.js 14 + React 18 + TypeScript
- **Backend**: NestJS 10 + TypeScript
- **Database**: MongoDB 6
- **AI**: Groq API (Llama 3.1 70B) - FREE & Ultra-fast!
- **Workflow**: LangGraph pattern (5 nodes)

## 💬 Example Questions

Try asking:

- "Who has the highest score in Test cricket?"
- "Show me top 5 ODI run scorers"
- "List all Indian players in T20"
- "How many centuries does Virat Kohli have?"
- "Players with average above 50 in ODI"

## 📊 Sample Data

Includes 30 player records across three formats:
- **Test Cricket**: 10 players (Sachin, Brian Lara, Ricky Ponting, etc.)
- **ODI Cricket**: 10 players (Sachin, Virat Kohli, Rohit Sharma, etc.)
- **T20 Cricket**: 10 players (Virat Kohli, Rohit Sharma, Babar Azam, etc.)

## 🎯 What You Get

✅ Complete working application  
✅ AI-powered query processing  
✅ 5-node LangGraph workflow  
✅ Modern chat interface  
✅ Sample cricket data  
✅ 77 pages of documentation  
✅ Deployment guides  
✅ Testing scenarios  
✅ Production-ready code  

## 🚀 Next Steps

1. **Start**: Follow [GETTING_STARTED.md](./GETTING_STARTED.md)
2. **Learn**: Read [WORKFLOW.md](./WORKFLOW.md) to understand the AI
3. **Customize**: Add more data, modify UI, extend features
4. **Deploy**: Use [DEPLOYMENT.md](./DEPLOYMENT.md) for production

## 📞 Need Help?

- Check [DOCUMENTATION_INDEX.md](./DOCUMENTATION_INDEX.md) for all guides
- Review [SETUP.md](./SETUP.md) for troubleshooting
- See [TESTING.md](./TESTING.md) for testing scenarios

---

**Built with ❤️ using NestJS, Next.js, MongoDB, and Claude AI**
