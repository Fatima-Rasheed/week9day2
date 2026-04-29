# Visual Guide - Cricket Stats AI

## 🎨 User Interface Preview

### Chat Interface Layout
```
┌─────────────────────────────────────────────────────────────┐
│  🏏 Cricket Stats AI                                        │
│  Ask me anything about cricket statistics!                  │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Try asking:                                                 │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Who has the highest score in Test cricket?         │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Show me top 5 ODI run scorers                       │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ List all players with average above 50 in T20      │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                              │
├─────────────────────────────────────────────────────────────┤
│  [Type your question here...]                    [Send]     │
└─────────────────────────────────────────────────────────────┘
```

### After User Asks a Question
```
┌─────────────────────────────────────────────────────────────┐
│  🏏 Cricket Stats AI                                        │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│                    ┌──────────────────────────────────┐     │
│                    │ Top 5 ODI run scorers            │     │
│                    └──────────────────────────────────┘     │
│                                                              │
│  ┌────────────────────────────────────────────────────┐    │
│  │ Here are the top 5 ODI run scorers:               │    │
│  │                                                     │    │
│  │ Name              Country   Runs    Average        │    │
│  │ ───────────────────────────────────────────────    │    │
│  │ Sachin Tendulkar  India     18426   44.83         │    │
│  │ Virat Kohli       India     13848   58.18         │    │
│  │ Ricky Ponting     Australia 13704   42.03         │    │
│  │ Kumar Sangakkara  Sri Lanka 14234   41.98         │    │
│  │ Rohit Sharma      India     10866   49.16         │    │
│  └────────────────────────────────────────────────────┘    │
│                                                              │
├─────────────────────────────────────────────────────────────┤
│  [Type your question here...]                    [Send]     │
└─────────────────────────────────────────────────────────────┘
```

## 🔄 Workflow Visualization

### Complete Request Flow
```
┌─────────────┐
│    USER     │
│  Types:     │
│  "Top 5     │
│   ODI       │
│   scorers"  │
└──────┬──────┘
       │
       ▼
┌─────────────────────────────────────────────────────────────┐
│                    FRONTEND (Next.js)                        │
│  ┌────────────────────────────────────────────────────┐    │
│  │  1. User types question                            │    │
│  │  2. Click Send button                              │    │
│  │  3. Show loading indicator (...)                   │    │
│  │  4. POST /ask with { question: "..." }             │    │
│  └────────────────────────────────────────────────────┘    │
└────────────────────────────┬────────────────────────────────┘
                             │
                             │ HTTP POST
                             │
┌────────────────────────────▼────────────────────────────────┐
│                    BACKEND (NestJS)                          │
│  ┌────────────────────────────────────────────────────┐    │
│  │  ChatController receives request                   │    │
│  │         ↓                                           │    │
│  │  ChatService.processQuestion()                     │    │
│  │         ↓                                           │    │
│  │  LangGraphService.runWorkflow()                    │    │
│  └────────────────────────────────────────────────────┘    │
└────────────────────────────┬────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│              LANGGRAPH WORKFLOW (5 Nodes)                    │
│                                                               │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ NODE 1: Relevancy Checker                           │   │
│  │ ┌─────────────────────────────────────────────┐    │   │
│  │ │ Prompt: "Is this cricket-related?"          │    │   │
│  │ │ AI Response: "Yes, it's about ODI stats"    │────┼───┼──> Claude API
│  │ │ Decision: PROCEED                            │    │   │
│  │ └─────────────────────────────────────────────┘    │   │
│  └─────────────────────────────────────────────────────┘   │
│                             ↓                                │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ NODE 2: Query Generator                             │   │
│  │ ┌─────────────────────────────────────────────┐    │   │
│  │ │ Prompt: Schema + "Top 5 ODI scorers"        │    │   │
│  │ │ AI Response: {                               │────┼───┼──> Claude API
│  │ │   collection: "odi",                         │    │   │
│  │ │   sort: { runs: -1 },                        │    │   │
│  │ │   limit: 5                                   │    │   │
│  │ │ }                                            │    │   │
│  │ └─────────────────────────────────────────────┘    │   │
│  └─────────────────────────────────────────────────────┘   │
│                             ↓                                │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ NODE 3: Query Executor                              │   │
│  │ ┌─────────────────────────────────────────────┐    │   │
│  │ │ Execute: db.odi.find()                      │────┼───┼──> MongoDB
│  │ │          .sort({ runs: -1 })                │    │   │
│  │ │          .limit(5)                           │    │   │
│  │ │ Results: [Sachin, Virat, Ricky, ...]       │    │   │
│  │ └─────────────────────────────────────────────┘    │   │
│  └─────────────────────────────────────────────────────┘   │
│                             ↓                                │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ NODE 4: Answer Formatter                            │   │
│  │ ┌─────────────────────────────────────────────┐    │   │
│  │ │ Prompt: "Format these 5 results as table"   │────┼───┼──> Claude API
│  │ │ AI Response: Markdown table                  │    │   │
│  │ │ Type: "table"                                │    │   │
│  │ └─────────────────────────────────────────────┘    │   │
│  └─────────────────────────────────────────────────────┘   │
│                             ↓                                │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ NODE 5: Final Response                              │   │
│  │ ┌─────────────────────────────────────────────┐    │   │
│  │ │ Return: {                                    │    │   │
│  │ │   answer: "| Name | Runs |...",             │    │   │
│  │ │   type: "table"                              │    │   │
│  │ │ }                                            │    │   │
│  │ └─────────────────────────────────────────────┘    │   │
│  └─────────────────────────────────────────────────────┘   │
└────────────────────────────┬────────────────────────────────┘
                             │
                             │ JSON Response
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                    FRONTEND (Next.js)                        │
│  ┌────────────────────────────────────────────────────┐    │
│  │  1. Receive response                               │    │
│  │  2. Parse markdown table                           │    │
│  │  3. Render as HTML table                           │    │
│  │  4. Display to user                                │    │
│  └────────────────────────────────────────────────────┘    │
└────────────────────────────┬────────────────────────────────┘
                             │
                             ▼
                      ┌─────────────┐
                      │    USER     │
                      │  Sees table │
                      │  with top 5 │
                      │   players   │
                      └─────────────┘
```

## 📊 Data Flow Diagram

```
CSV Files                MongoDB              LangGraph           Frontend
─────────               ────────              ─────────           ────────

test.csv     ──┐
               │
odi.csv      ──┼──> Import  ──> test coll.
               │    Script       odi coll.  ──> Query  ──> Format ──> Display
t20.csv      ──┘                 t20 coll.      Data       Answer     to User
                                    ▲             │          │
                                    │             ▼          │
                                    └──────── Execute ◄──────┘
                                              Query
```

## 🗂️ File Structure Visual

```
cricket-stats-ai/
│
├── 📁 backend/
│   ├── 📁 src/
│   │   ├── 📁 chat/
│   │   │   ├── 📄 chat.controller.ts      ← API endpoint
│   │   │   ├── 📄 chat.service.ts         ← Business logic
│   │   │   ├── 📄 langgraph.service.ts    ← ⭐ AI workflow
│   │   │   └── 📄 chat.module.ts
│   │   ├── 📁 database/
│   │   │   ├── 📄 database.service.ts     ← MongoDB connection
│   │   │   └── 📄 database.module.ts
│   │   ├── 📄 app.module.ts
│   │   └── 📄 main.ts                     ← Entry point
│   ├── 📄 package.json
│   ├── 📄 tsconfig.json
│   └── 📄 .env.example
│
├── 📁 frontend/
│   ├── 📁 src/
│   │   ├── 📁 components/
│   │   │   ├── 📄 ChatInterface.tsx       ← ⭐ Main UI
│   │   │   └── 📄 ChatInterface.module.css
│   │   ├── 📁 pages/
│   │   │   ├── 📄 index.tsx               ← Home page
│   │   │   └── 📄 _app.tsx
│   │   └── 📁 styles/
│   │       ├── 📄 globals.css
│   │       └── 📄 Home.module.css
│   ├── 📄 package.json
│   ├── 📄 next.config.js
│   └── 📄 .env.example
│
├── 📁 scripts/
│   ├── 📄 import-data.js                  ← ⭐ Data importer
│   ├── 📄 package.json
│   └── 📄 .env.example
│
├── 📁 data/
│   ├── 📄 sample_test_players.csv         ← Test data
│   ├── 📄 sample_odi_players.csv          ← ODI data
│   ├── 📄 sample_t20_players.csv          ← T20 data
│   └── 📄 schema-description.json         ← ⭐ Schema for AI
│
└── 📄 Documentation files (10+)

⭐ = Critical files
```

## 🎯 Component Interaction Map

```
┌─────────────────────────────────────────────────────────────┐
│                         Browser                              │
│  ┌────────────────────────────────────────────────────┐    │
│  │              ChatInterface.tsx                      │    │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐         │    │
│  │  │ Messages │  │  Input   │  │  Send    │         │    │
│  │  │  State   │  │  Field   │  │  Button  │         │    │
│  │  └──────────┘  └──────────┘  └──────────┘         │    │
│  └────────────────────────────────────────────────────┘    │
└────────────────────────────┬────────────────────────────────┘
                             │
                             │ axios.post()
                             │
┌────────────────────────────▼────────────────────────────────┐
│                      NestJS Server                           │
│  ┌────────────────────────────────────────────────────┐    │
│  │           ChatController                            │    │
│  │  @Post('ask')                                       │    │
│  │  async ask(@Body() dto)                             │    │
│  └────────────────────┬───────────────────────────────┘    │
│                       │                                      │
│  ┌────────────────────▼───────────────────────────────┐    │
│  │           ChatService                               │    │
│  │  processQuestion(question)                          │    │
│  └────────────────────┬───────────────────────────────┘    │
│                       │                                      │
│  ┌────────────────────▼───────────────────────────────┐    │
│  │        LangGraphService                             │    │
│  │  runWorkflow(question)                              │    │
│  │  ├─ checkRelevancy()                                │    │
│  │  ├─ generateQuery()                                 │    │
│  │  ├─ executeQuery() ──────────────────────┐         │    │
│  │  ├─ formatAnswer()                        │         │    │
│  │  └─ return result                         │         │    │
│  └───────────────────────────────────────────┼─────────┘    │
│                                               │               │
│  ┌───────────────────────────────────────────▼─────────┐    │
│  │        DatabaseService                              │    │
│  │  getDb() → MongoDB connection                       │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

## 🔐 Environment Configuration Map

```
┌─────────────────────────────────────────────────────────────┐
│                    scripts/.env                              │
│  ┌────────────────────────────────────────────────────┐    │
│  │ MONGODB_URI=mongodb://localhost:27017/cricket_stats│    │
│  └────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                    backend/.env                              │
│  ┌────────────────────────────────────────────────────┐    │
│  │ MONGODB_URI=mongodb://localhost:27017/cricket_stats│    │
│  │ ANTHROPIC_API_KEY=sk-ant-api03-...                 │    │
│  │ PORT=3001                                           │    │
│  └────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                  frontend/.env.local                         │
│  ┌────────────────────────────────────────────────────┐    │
│  │ NEXT_PUBLIC_API_URL=http://localhost:3001          │    │
│  └────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

## 📈 Response Type Decision Tree

```
                    User Question
                         │
                         ▼
              ┌──────────────────────┐
              │  Relevancy Check     │
              └──────────┬───────────┘
                         │
         ┌───────────────┴───────────────┐
         │                               │
         ▼                               ▼
    Cricket-related?              Not cricket-related
         │                               │
         │                               ▼
         │                    "Sorry, cricket only"
         │                         (text response)
         │
         ▼
    Generate Query
         │
         ▼
    Execute Query
         │
         ▼
    ┌────────────────┐
    │ Results Count? │
    └────────┬───────┘
             │
    ┌────────┴────────┐
    │                 │
    ▼                 ▼
  0 results        1+ results
    │                 │
    ▼                 │
"No results"          │
(text response)       │
                      │
         ┌────────────┴────────────┐
         │                         │
         ▼                         ▼
    1 result                  2+ results
         │                         │
         ▼                         ▼
  Plain sentence            Markdown table
  (text response)          (table response)
```

## 🚀 Deployment Architecture Options

### Option 1: Single VPS
```
┌─────────────────────────────────────────┐
│           VPS Server                     │
│  ┌─────────────────────────────────┐   │
│  │  Nginx (Reverse Proxy)          │   │
│  │  :80 / :443                      │   │
│  └──────────┬──────────────────────┘   │
│             │                            │
│    ┌────────┴────────┐                  │
│    │                 │                  │
│    ▼                 ▼                  │
│  Frontend         Backend               │
│  :3000            :3001                 │
│  (PM2)            (PM2)                 │
│                     │                   │
│                     ▼                   │
│                  MongoDB                │
│                  :27017                 │
└─────────────────────────────────────────┘
```

### Option 2: Cloud Services
```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Vercel     │────>│   Railway    │────>│   MongoDB    │
│  (Frontend)  │     │  (Backend)   │     │    Atlas     │
│   Global     │     │   Regional   │     │    Cloud     │
└──────────────┘     └──────────────┘     └──────────────┘
```

## 📊 Database Collections Visual

```
MongoDB: cricket_stats
│
├── Collection: test
│   ├── Document 1: { name: "Sachin", runs: 15921, ... }
│   ├── Document 2: { name: "Brian Lara", runs: 11953, ... }
│   └── ... (10 documents)
│
├── Collection: odi
│   ├── Document 1: { name: "Sachin", runs: 18426, ... }
│   ├── Document 2: { name: "Virat", runs: 13848, ... }
│   └── ... (10 documents)
│
└── Collection: t20
    ├── Document 1: { name: "Virat", runs: 4188, ... }
    ├── Document 2: { name: "Rohit", runs: 4231, ... }
    └── ... (10 documents)
```

## 🎨 Color Scheme

```
Primary Colors:
┌────────┐ ┌────────┐
│ #667eea│ │ #764ba2│  Gradient (Purple/Blue)
└────────┘ └────────┘

Secondary Colors:
┌────────┐ ┌────────┐ ┌────────┐
│ #f8f9fa│ │ #e9ecef│ │ #495057│  Grays
└────────┘ └────────┘ └────────┘

Accent:
┌────────┐
│ #667eea│  Interactive elements
└────────┘
```

## 📱 Responsive Design

```
Desktop (1200px+)          Tablet (768px)         Mobile (375px)
┌─────────────────┐       ┌──────────┐           ┌─────┐
│                 │       │          │           │     │
│   Chat Area     │       │  Chat    │           │Chat │
│   (Wide)        │       │  Area    │           │Area │
│                 │       │          │           │     │
│   [Input]       │       │ [Input]  │           │[In] │
└─────────────────┘       └──────────┘           └─────┘
```

---

**This visual guide helps you understand the system at a glance!**

For detailed information, refer to the other documentation files.
