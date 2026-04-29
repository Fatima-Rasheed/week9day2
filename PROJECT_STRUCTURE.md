# Project Structure

```
cricket-stats-ai/
│
├── backend/                          # NestJS Backend API
│   ├── src/
│   │   ├── chat/
│   │   │   ├── chat.controller.ts    # POST /ask endpoint
│   │   │   ├── chat.service.ts       # Business logic
│   │   │   ├── chat.module.ts        # Module definition
│   │   │   └── langgraph.service.ts  # LangGraph workflow (5 nodes)
│   │   │
│   │   ├── database/
│   │   │   ├── database.service.ts   # MongoDB connection
│   │   │   └── database.module.ts    # Global database module
│   │   │
│   │   ├── app.module.ts             # Root module
│   │   └── main.ts                   # Application entry point
│   │
│   ├── package.json                  # Dependencies
│   ├── tsconfig.json                 # TypeScript config
│   ├── nest-cli-config.json          # NestJS CLI config
│   └── .env.example                  # Environment variables template
│
├── frontend/                         # Next.js Frontend
│   ├── src/
│   │   ├── components/
│   │   │   ├── ChatInterface.tsx     # Main chat component
│   │   │   └── ChatInterface.module.css
│   │   │
│   │   ├── pages/
│   │   │   ├── _app.tsx              # App wrapper
│   │   │   └── index.tsx             # Home page
│   │   │
│   │   └── styles/
│   │       ├── globals.css           # Global styles
│   │       └── Home.module.css       # Home page styles
│   │
│   ├── package.json                  # Dependencies
│   ├── tsconfig.json                 # TypeScript config
│   ├── next.config.js                # Next.js config
│   └── .env.example                  # Environment variables template
│
├── scripts/                          # Data import scripts
│   ├── import-data.js                # MongoDB CSV import
│   ├── package.json                  # Dependencies
│   └── .env.example                  # MongoDB URI
│
├── data/                             # Cricket statistics data
│   ├── sample_test_players.csv       # Test cricket data
│   ├── sample_odi_players.csv        # ODI cricket data
│   ├── sample_t20_players.csv        # T20 cricket data
│   └── schema-description.json       # MongoDB schema for AI
│
├── README.md                         # Project overview
├── SETUP.md                          # Setup instructions
├── WORKFLOW.md                       # LangGraph workflow details
├── API.md                            # API documentation
├── PROJECT_STRUCTURE.md              # This file
├── quick-start.sh                    # Linux/Mac setup script
├── quick-start.bat                   # Windows setup script
└── .gitignore                        # Git ignore rules
```

## Component Responsibilities

### Backend Components

#### `chat.controller.ts`
- Exposes POST /ask endpoint
- Validates request body
- Delegates to ChatService

#### `chat.service.ts`
- Orchestrates the workflow
- Handles errors gracefully
- Returns structured responses

#### `langgraph.service.ts` ⭐ Core AI Logic
- **Node 1**: Relevancy Checker - Filters non-cricket questions
- **Node 2**: Query Generator - Converts NL to MongoDB query
- **Node 3**: Query Executor - Runs MongoDB queries
- **Node 4**: Answer Formatter - Formats as text/table
- **Node 5**: Final Response - Returns to API

#### `database.service.ts`
- Manages MongoDB connection
- Provides database instance to services
- Handles connection lifecycle

### Frontend Components

#### `ChatInterface.tsx`
- Main chat UI component
- Manages message state
- Handles API communication
- Renders text and table responses
- Shows suggested questions
- Displays typing indicator

#### `index.tsx`
- Home page layout
- Header with title
- Embeds ChatInterface

### Data Files

#### CSV Files
- Sample data for 10 players per format
- Real statistics from cricket history
- Used for MongoDB import

#### `schema-description.json`
- Complete field definitions
- Injected into AI prompts
- Ensures accurate query generation

## Data Flow

```
User Types Question
        ↓
ChatInterface.tsx
        ↓
POST /ask → chat.controller.ts
        ↓
chat.service.ts
        ↓
langgraph.service.ts
        ↓
┌─────────────────────────────────┐
│  Node 1: Relevancy Checker      │ → Claude API
│  Node 2: Query Generator        │ → Claude API
│  Node 3: Query Executor         │ → MongoDB
│  Node 4: Answer Formatter       │ → Claude API
│  Node 5: Final Response         │
└─────────────────────────────────┘
        ↓
Response { answer, type }
        ↓
ChatInterface.tsx
        ↓
Render as Text or Table
```

## Technology Stack

### Backend
- **Framework**: NestJS 10.x
- **Language**: TypeScript
- **Database**: MongoDB 6.x
- **AI**: Anthropic Claude API
- **HTTP Client**: Axios

### Frontend
- **Framework**: Next.js 14.x
- **Language**: TypeScript
- **UI**: React 18.x
- **Styling**: CSS Modules
- **HTTP Client**: Axios

### Database
- **MongoDB Collections**:
  - `test` - Test cricket stats
  - `odi` - ODI cricket stats
  - `t20` - T20 cricket stats

## Environment Variables

### Backend (.env)
```
MONGODB_URI=mongodb://localhost:27017/cricket_stats
ANTHROPIC_API_KEY=sk-ant-...
PORT=3001
```

### Frontend (.env.local)
```
NEXT_PUBLIC_API_URL=http://localhost:3001
```

### Scripts (.env)
```
MONGODB_URI=mongodb://localhost:27017/cricket_stats
```

## Port Configuration

- **Frontend**: 3000 (Next.js dev server)
- **Backend**: 3001 (NestJS API)
- **MongoDB**: 27017 (default)

## Key Design Decisions

### Why 3 Collections Instead of 1?
- Cleaner queries (no format filtering needed)
- Better performance (smaller collections)
- Mirrors natural cricket data organization
- Easier for AI to generate correct queries

### Why LangGraph Pattern?
- Clear separation of concerns (5 distinct nodes)
- Easy to debug (inspect state at each node)
- Extensible (add new nodes without breaking existing)
- Stateful (shared state across nodes)

### Why NestJS?
- Built-in dependency injection
- Modular architecture
- TypeScript first-class support
- Production-ready features

### Why Next.js?
- Server-side rendering capability
- File-based routing
- Built-in API routes (if needed)
- Great developer experience

## File Size Estimates

```
backend/          ~50 KB (source code)
frontend/         ~30 KB (source code)
scripts/          ~5 KB
data/             ~10 KB (CSV files)
node_modules/     ~500 MB (all dependencies)
```

## Development vs Production

### Development
- Hot reload enabled
- Detailed error messages
- No caching
- CORS allows localhost

### Production Recommendations
- Build optimized bundles
- Enable caching (Redis)
- Add rate limiting
- Use environment-specific configs
- Add authentication
- Use production MongoDB cluster
- Enable HTTPS
- Add monitoring/logging
