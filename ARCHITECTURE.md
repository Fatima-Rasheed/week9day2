# System Architecture

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         USER BROWSER                             │
│                    http://localhost:3000                         │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             │ HTTP Request
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                    NEXT.JS FRONTEND                              │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  ChatInterface Component                                  │  │
│  │  - Message state management                               │  │
│  │  - API communication                                      │  │
│  │  - Text/Table rendering                                   │  │
│  └──────────────────────────────────────────────────────────┘  │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             │ POST /ask
                             │ { question: "..." }
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                    NESTJS BACKEND API                            │
│                   http://localhost:3001                          │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  ChatController                                           │  │
│  │  └─> ChatService                                          │  │
│  │       └─> LangGraphService (Workflow Engine)             │  │
│  └──────────────────────────────────────────────────────────┘  │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                   LANGGRAPH WORKFLOW                             │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  NODE 1: Relevancy Checker                              │   │
│  │  ┌────────────────────────────────────────────────┐     │   │
│  │  │ Prompt: "Is this cricket-related?"            │     │   │
│  │  │ AI: Claude API                                 │────┼───┼──> Anthropic API
│  │  │ Output: isRelevant (true/false)               │     │   │
│  │  └────────────────────────────────────────────────┘     │   │
│  └─────────────────────────────────────────────────────────┘   │
│                             │                                    │
│                             ▼                                    │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  NODE 2: Query Generator                                │   │
│  │  ┌────────────────────────────────────────────────┐     │   │
│  │  │ Prompt: Schema + Question                     │     │   │
│  │  │ AI: Claude API                                 │────┼───┼──> Anthropic API
│  │  │ Output: MongoDB query JSON                    │     │   │
│  │  └────────────────────────────────────────────────┘     │   │
│  └─────────────────────────────────────────────────────────┘   │
│                             │                                    │
│                             ▼                                    │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  NODE 3: Query Executor                                 │   │
│  │  ┌────────────────────────────────────────────────┐     │   │
│  │  │ Parse query object                            │     │   │
│  │  │ Execute: db.collection.find()                 │────┼───┼──> MongoDB
│  │  │ Output: Raw results array                     │     │   │
│  │  └────────────────────────────────────────────────┘     │   │
│  └─────────────────────────────────────────────────────────┘   │
│                             │                                    │
│                             ▼                                    │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  NODE 4: Answer Formatter                               │   │
│  │  ┌────────────────────────────────────────────────┐     │   │
│  │  │ Prompt: Results + Question                    │     │   │
│  │  │ AI: Claude API                                 │────┼───┼──> Anthropic API
│  │  │ Output: Formatted text or table               │     │   │
│  │  └────────────────────────────────────────────────┘     │   │
│  └─────────────────────────────────────────────────────────┘   │
│                             │                                    │
│                             ▼                                    │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  NODE 5: Final Response                                 │   │
│  │  ┌────────────────────────────────────────────────┐     │   │
│  │  │ Package: { answer, type }                     │     │   │
│  │  │ Return to API                                  │     │   │
│  │  └────────────────────────────────────────────────┘     │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                      MONGODB DATABASE                            │
│                  mongodb://localhost:27017                       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │ test         │  │ odi          │  │ t20          │          │
│  │ collection   │  │ collection   │  │ collection   │          │
│  │              │  │              │  │              │          │
│  │ 10 players   │  │ 10 players   │  │ 10 players   │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
└─────────────────────────────────────────────────────────────────┘
```

## Request Flow Sequence

```
User: "Top 5 ODI run scorers"
    │
    ├─> Frontend: ChatInterface.tsx
    │   └─> setState({ messages: [..., userMessage] })
    │   └─> axios.post('/ask', { question })
    │
    ├─> Backend: ChatController
    │   └─> @Post('ask')
    │   └─> ChatService.processQuestion()
    │
    ├─> LangGraph Workflow
    │   │
    │   ├─> Node 1: Relevancy Check
    │   │   └─> Claude: "Is this cricket-related?"
    │   │   └─> Response: "yes"
    │   │   └─> state.isRelevant = true
    │   │
    │   ├─> Node 2: Generate Query
    │   │   └─> Claude: "Convert to MongoDB query"
    │   │   └─> Response: { collection: "odi", sort: { runs: -1 }, limit: 5 }
    │   │   └─> state.generatedQuery = {...}
    │   │
    │   ├─> Node 3: Execute Query
    │   │   └─> MongoDB: db.odi.find().sort({ runs: -1 }).limit(5)
    │   │   └─> Results: [Sachin, Virat, Ricky, ...]
    │   │   └─> state.queryResults = [...]
    │   │
    │   ├─> Node 4: Format Answer
    │   │   └─> Claude: "Format as table"
    │   │   └─> Response: "| Name | Runs |..."
    │   │   └─> state.formattedAnswer = "..."
    │   │   └─> state.answerType = "table"
    │   │
    │   └─> Node 5: Return
    │       └─> { answer: "...", type: "table" }
    │
    ├─> Backend Response
    │   └─> { success: true, answer: "...", type: "table" }
    │
    └─> Frontend: Render
        └─> Parse markdown table
        └─> Render HTML <table>
        └─> Display to user
```

## Component Interaction Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                        Frontend Layer                         │
├──────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌─────────────┐      ┌──────────────┐                      │
│  │   index.tsx │─────>│ ChatInterface│                      │
│  │  (Home Page)│      │  Component   │                      │
│  └─────────────┘      └──────┬───────┘                      │
│                              │                                │
│                              │ axios.post()                   │
│                              │                                │
└──────────────────────────────┼────────────────────────────────┘
                               │
                               │ HTTP
                               │
┌──────────────────────────────┼────────────────────────────────┐
│                        Backend Layer                          │
├──────────────────────────────┼────────────────────────────────┤
│                              ▼                                 │
│  ┌──────────────────────────────────────┐                    │
│  │      ChatController                   │                    │
│  │  @Post('ask')                         │                    │
│  └──────────────┬───────────────────────┘                    │
│                 │                                              │
│                 ▼                                              │
│  ┌──────────────────────────────────────┐                    │
│  │      ChatService                      │                    │
│  │  processQuestion()                    │                    │
│  └──────────────┬───────────────────────┘                    │
│                 │                                              │
│                 ▼                                              │
│  ┌──────────────────────────────────────┐                    │
│  │   LangGraphService                    │                    │
│  │   runWorkflow()                       │                    │
│  │   ├─ checkRelevancy()                 │                    │
│  │   ├─ generateQuery()                  │                    │
│  │   ├─ executeQuery() ──────────────────┼────> MongoDB      │
│  │   ├─ formatAnswer()                   │                    │
│  │   └─ return result                    │                    │
│  └──────────────┬───────────────────────┘                    │
│                 │                                              │
│                 │ callAI() ──────────────────────────────────┼────> Anthropic
│                 │                                              │       API
└─────────────────┼──────────────────────────────────────────────┘
                  │
                  ▼
┌──────────────────────────────────────────────────────────────┐
│                      Database Layer                           │
├──────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌──────────────────────────────────────┐                    │
│  │   DatabaseService                     │                    │
│  │   - MongoClient connection            │                    │
│  │   - getDb() returns Db instance       │                    │
│  └──────────────┬───────────────────────┘                    │
│                 │                                              │
│                 ▼                                              │
│  ┌──────────────────────────────────────┐                    │
│  │   MongoDB Collections                 │                    │
│  │   ├─ test                             │                    │
│  │   ├─ odi                              │                    │
│  │   └─ t20                              │                    │
│  └───────────────────────────────────────┘                    │
└──────────────────────────────────────────────────────────────┘
```

## Data Model

### MongoDB Schema (All Collections)

```javascript
{
  _id: ObjectId("..."),              // Auto-generated
  name: "Sachin Tendulkar",          // String
  country: "India",                  // String
  matches: 463,                      // Number
  innings: 452,                      // Number
  runs: 18426,                       // Number
  highest_score: "200*",             // String (includes * for not out)
  average: 44.83,                    // Number (float)
  strike_rate: 86.23,                // Number (float)
  centuries: 49,                     // Number (integer)
  fifties: 96,                       // Number (integer)
  wickets: 154,                      // Number (integer)
  bowling_average: 44.48,            // Number (float)
  economy: 5.13                      // Number (float)
}
```

### State Object (LangGraph)

```typescript
interface WorkflowState {
  question: string;              // "Top 5 ODI run scorers"
  isRelevant?: boolean;          // true
  relevancyReason?: string;      // "Cricket statistics question"
  generatedQuery?: {
    collection: string;          // "odi"
    operation: string;           // "find"
    filter: object;              // {}
    sort: object;                // { runs: -1 }
    limit: number;               // 5
    projection: object;          // { name: 1, runs: 1 }
  };
  queryResults?: Array<any>;     // [{ name: "Sachin", ... }, ...]
  formattedAnswer?: string;      // "| Name | Runs |..."
  answerType?: 'text' | 'table'; // "table"
  error?: string;                // null or error message
}
```

## Technology Stack Details

### Frontend Stack
```
Next.js 14.1.0
├── React 18.2.0
├── TypeScript 5.3.3
├── Axios 1.6.5
└── CSS Modules (built-in)
```

### Backend Stack
```
NestJS 10.3.0
├── TypeScript 5.3.3
├── MongoDB Driver 6.3.0
├── Axios 1.6.5 (for Anthropic API)
├── class-validator 0.14.1
└── class-transformer 0.5.1
```

### Database
```
MongoDB 6.x
└── Collections: test, odi, t20
```

### External APIs
```
Anthropic Claude API
└── Model: claude-3-5-sonnet-20241022
```

## Deployment Architecture

### Development
```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Next.js    │────>│   NestJS    │────>│  MongoDB    │
│  :3000      │     │   :3001     │     │  :27017     │
│  (dev mode) │     │  (watch)    │     │  (local)    │
└─────────────┘     └─────────────┘     └─────────────┘
```

### Production (VPS)
```
┌─────────────┐
│   Nginx     │ :80/:443 (SSL)
│  (Reverse   │
│   Proxy)    │
└──────┬──────┘
       │
       ├──────> Frontend :3000 (PM2)
       │
       └──────> Backend :3001 (PM2)
                    │
                    └──────> MongoDB :27017
```

### Production (Cloud)
```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Vercel    │────>│   Railway   │────>│  MongoDB    │
│  (Frontend) │     │  (Backend)  │     │   Atlas     │
│   Global    │     │   Regional  │     │   Cloud     │
└─────────────┘     └─────────────┘     └─────────────┘
```

## Security Layers

```
┌──────────────────────────────────────────────────────────┐
│  Layer 1: Network Security                                │
│  - HTTPS/SSL encryption                                   │
│  - Firewall rules                                         │
│  - IP whitelisting                                        │
└──────────────────────────────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────────┐
│  Layer 2: Application Security                            │
│  - CORS configuration                                     │
│  - Rate limiting                                          │
│  - Input validation                                       │
│  - Helmet security headers                                │
└──────────────────────────────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────────┐
│  Layer 3: Database Security                               │
│  - Authentication required                                │
│  - Encrypted connections                                  │
│  - Access control                                         │
└──────────────────────────────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────────┐
│  Layer 4: API Security                                    │
│  - API key management                                     │
│  - Environment variables                                  │
│  - No secrets in code                                     │
└──────────────────────────────────────────────────────────┘
```

## Scalability Considerations

### Horizontal Scaling
```
                    ┌─────────────┐
                    │ Load        │
                    │ Balancer    │
                    └──────┬──────┘
                           │
         ┌─────────────────┼─────────────────┐
         │                 │                 │
         ▼                 ▼                 ▼
    ┌─────────┐       ┌─────────┐      ┌─────────┐
    │Backend 1│       │Backend 2│      │Backend 3│
    └────┬────┘       └────┬────┘      └────┬────┘
         │                 │                 │
         └─────────────────┼─────────────────┘
                           │
                           ▼
                    ┌─────────────┐
                    │  MongoDB    │
                    │  Cluster    │
                    └─────────────┘
```

### Caching Layer
```
Frontend ──> Backend ──> Redis Cache ──> MongoDB
                            │
                            └─> Cache Hit: Return
                            └─> Cache Miss: Query DB
```

## Monitoring Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Application Logs                                         │
│  - NestJS Logger                                          │
│  - PM2 Logs                                               │
└────────────────────────┬─────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────────┐
│  Error Tracking                                           │
│  - Sentry                                                 │
│  - Stack traces                                           │
└────────────────────────┬─────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────────┐
│  Performance Monitoring                                   │
│  - Response times                                         │
│  - API call metrics                                       │
│  - Database query performance                             │
└────────────────────────┬─────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────────┐
│  Alerting                                                 │
│  - Email/SMS notifications                                │
│  - Slack integration                                      │
└──────────────────────────────────────────────────────────┘
```
