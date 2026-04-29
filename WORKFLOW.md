# LangGraph Workflow Documentation

## Overview

The AI workflow consists of 5 sequential nodes that process user questions and return formatted answers.

## Workflow State

The shared state object passed between nodes:

```typescript
interface WorkflowState {
  question: string;           // User's original question
  isRelevant?: boolean;       // Is it cricket-related?
  relevancyReason?: string;   // Why relevant/not relevant
  generatedQuery?: any;       // MongoDB query object
  queryResults?: any[];       // Raw results from MongoDB
  formattedAnswer?: string;   // Final formatted answer
  answerType?: 'text' | 'table'; // How to display
  error?: string;             // Any error encountered
}
```

## Node 1: Relevancy Checker

**Purpose**: Filter out non-cricket questions early

**Process**:
1. Send question to Claude with relevancy prompt
2. Parse response for yes/no answer
3. If "no" → set error message and stop workflow
4. If "yes" → proceed to next node

**Example Prompts**:
- ✅ "Who scored the most runs in ODI?" → Relevant
- ✅ "Top 5 Test batsmen" → Relevant
- ❌ "Who won the FIFA World Cup?" → Not relevant
- ❌ "What's the weather today?" → Not relevant

**Output**: Updates `isRelevant` and `relevancyReason` in state

## Node 2: Query Generator

**Purpose**: Convert natural language to MongoDB query

**Process**:
1. Load schema description from JSON file
2. Construct prompt with schema + user question
3. Ask Claude to generate MongoDB query in specific JSON format
4. Parse and validate the JSON response
5. Store query object in state

**Query Object Format**:
```json
{
  "collection": "test" | "odi" | "t20",
  "operation": "find",
  "filter": { "country": "India" },
  "sort": { "runs": -1 },
  "limit": 5,
  "projection": { "name": 1, "runs": 1, "average": 1 }
}
```

**Example Conversions**:

| Question | Generated Query |
|----------|----------------|
| "Top 5 ODI run scorers" | `{ collection: "odi", filter: {}, sort: { runs: -1 }, limit: 5 }` |
| "Indian players in Test" | `{ collection: "test", filter: { country: "India" }, sort: {}, limit: 0 }` |
| "Virat Kohli's ODI stats" | `{ collection: "odi", filter: { name: "Virat Kohli" }, sort: {}, limit: 1 }` |

**Key Prompt Engineering**:
- Explicitly request JSON-only output (no markdown, no explanation)
- Provide complete schema with field names and types
- Include examples of valid queries
- Specify default collection if format not mentioned

## Node 3: Query Executor

**Purpose**: Execute MongoDB query and fetch results

**Process**:
1. Extract query parameters from state
2. Get MongoDB database connection
3. Select the correct collection
4. Build and execute the query with:
   - Filter conditions
   - Sort order
   - Projection (field selection)
   - Limit
5. Convert cursor to array
6. Store results in state

**Error Handling**:
- Invalid collection name → empty results
- Bad field names → MongoDB error caught
- Connection issues → error stored in state

**No AI involved** - pure database operation

## Node 4: Answer Formatter

**Purpose**: Convert raw data into human-readable format

**Process**:
1. Check if results are empty → return "No results found"
2. Send results + original question to Claude
3. Ask Claude to format as:
   - **Plain text** for single results or specific values
   - **Markdown table** for multiple records
4. Parse response and detect format type
5. Store formatted answer and type in state

**Formatting Rules**:

**Single Result** (text format):
```
Question: "Who has the highest score in Test cricket?"
Result: [{ name: "Brian Lara", highest_score: "400*" }]
Formatted: "Brian Lara holds the highest individual score in Test cricket with 400* against England."
```

**Multiple Results** (table format):
```
Question: "Top 5 ODI run scorers"
Result: [{ name: "Sachin", runs: 18426 }, ...]
Formatted:
| Name | Country | Runs | Average |
|------|---------|------|---------|
| Sachin Tendulkar | India | 18426 | 44.83 |
| Virat Kohli | India | 13848 | 58.18 |
...
```

**Table Detection**: Check if response contains `|` and `---` (markdown table syntax)

## Node 5: Final Response

**Purpose**: Package and return the final answer

**Process**:
1. Extract `formattedAnswer` and `answerType` from state
2. Return as structured response:
   ```json
   {
     "answer": "formatted text or table",
     "type": "text" | "table"
   }
   ```
3. NestJS controller sends this to frontend
4. Frontend renders based on type

**Simple pass-through node** - no processing

## Complete Flow Example

**User Question**: "Show me top 3 Indian ODI batsmen"

**Node 1 Output**:
```
isRelevant: true
relevancyReason: "Question asks about ODI cricket statistics"
```

**Node 2 Output**:
```json
{
  "collection": "odi",
  "filter": { "country": "India" },
  "sort": { "runs": -1 },
  "limit": 3,
  "projection": { "name": 1, "runs": 1, "average": 1 }
}
```

**Node 3 Output**:
```json
[
  { "name": "Sachin Tendulkar", "runs": 18426, "average": 44.83 },
  { "name": "Virat Kohli", "runs": 13848, "average": 58.18 },
  { "name": "MS Dhoni", "runs": 10773, "average": 50.57 }
]
```

**Node 4 Output**:
```
type: "table"
answer: "| Name | Runs | Average |\n|------|------|---------|..."
```

**Node 5 Output**:
```json
{
  "answer": "| Name | Runs | Average |\n...",
  "type": "table"
}
```

## Error Handling Strategy

Each node handles its own errors gracefully:

1. **Relevancy Checker**: If AI fails → assume not relevant
2. **Query Generator**: If parsing fails → return error message
3. **Query Executor**: If MongoDB fails → return empty results
4. **Answer Formatter**: If AI fails → return raw JSON
5. **Final Response**: Always returns a response (never crashes)

## Performance Considerations

- **AI Calls**: 3 per question (relevancy, query gen, formatting)
- **MongoDB Calls**: 1 per question
- **Average Response Time**: 3-5 seconds
- **Optimization**: Cache schema description, reuse DB connection

## Extending the Workflow

To add new capabilities:

1. **Add aggregation support**: Modify query generator to support `aggregate` operation
2. **Add caching**: Store common queries and results
3. **Add multi-query**: Allow questions that need multiple queries
4. **Add visualization**: Generate chart data for trends
5. **Add comparison**: Compare players side-by-side
