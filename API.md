# API Documentation

## Base URL

```
http://localhost:3001
```

## Endpoints

### POST /ask

Submit a cricket statistics question and get an AI-generated answer.

**Request**:
```json
{
  "question": "Who has the highest score in Test cricket?"
}
```

**Response** (Text):
```json
{
  "success": true,
  "answer": "Brian Lara holds the highest individual score in Test cricket with 400* against England.",
  "type": "text"
}
```

**Response** (Table):
```json
{
  "success": true,
  "answer": "| Name | Country | Runs | Average |\n|------|---------|------|---------|...",
  "type": "table"
}
```

**Response** (Error):
```json
{
  "success": false,
  "answer": "Sorry, I can only answer cricket-related questions.",
  "type": "text"
}
```

**Status Codes**:
- `200 OK`: Request processed successfully
- `400 Bad Request`: Invalid request body
- `500 Internal Server Error`: Server error

**Example cURL**:
```bash
curl -X POST http://localhost:3001/ask \
  -H "Content-Type: application/json" \
  -d '{"question": "Top 5 ODI run scorers"}'
```

**Example JavaScript**:
```javascript
const response = await fetch('http://localhost:3001/ask', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ question: 'Top 5 ODI run scorers' })
});

const data = await response.json();
console.log(data.answer);
```

## Question Types Supported

### 1. Top N Queries
- "Top 5 ODI run scorers"
- "Show me best 10 Test batsmen"
- "List top 3 T20 players by strike rate"

### 2. Specific Player Queries
- "Virat Kohli's ODI stats"
- "How many centuries does Sachin have?"
- "What is Rohit Sharma's average in T20?"

### 3. Filtered Queries
- "All Indian players in ODI"
- "Players with average above 50 in Test"
- "Australian batsmen with 10000+ runs"

### 4. Comparison Queries
- "Who has more runs: Sachin or Virat in ODI?"
- "Compare Kohli and Rohit in T20"

### 5. Statistical Queries
- "Highest score in Test cricket"
- "Most centuries in ODI"
- "Best bowling average in T20"

## Response Format Details

### Text Response
Used for:
- Single player information
- Specific values (highest score, most wickets)
- Yes/no answers
- Error messages

Example:
```
"Sachin Tendulkar scored 18,426 runs in ODI cricket with an average of 44.83."
```

### Table Response
Used for:
- Multiple players (2+)
- Top N lists
- Filtered results
- Comparison data

Example:
```markdown
| Name | Country | Matches | Runs | Average |
|------|---------|---------|------|---------|
| Sachin Tendulkar | India | 463 | 18426 | 44.83 |
| Virat Kohli | India | 295 | 13848 | 58.18 |
```

## Error Handling

### Non-Cricket Questions
```json
{
  "success": true,
  "answer": "Sorry, I can only answer cricket-related questions.",
  "type": "text"
}
```

### No Results Found
```json
{
  "success": true,
  "answer": "No results found for your query.",
  "type": "text"
}
```

### Server Error
```json
{
  "success": false,
  "answer": "Sorry, I encountered an error processing your question.",
  "type": "text",
  "error": "Detailed error message"
}
```

## Rate Limiting

Currently no rate limiting is implemented. For production:
- Implement rate limiting per IP
- Add authentication/API keys
- Cache common queries

## CORS Configuration

The API allows requests from:
- `http://localhost:3000` (Next.js frontend)

To add more origins, edit `backend/src/main.ts`:
```typescript
app.enableCors({
  origin: ['http://localhost:3000', 'https://your-domain.com'],
  credentials: true,
});
```

## Database Schema

### Collections

**test** - Test cricket statistics
**odi** - ODI cricket statistics  
**t20** - T20 cricket statistics

### Fields

All collections have the same schema:

| Field | Type | Description |
|-------|------|-------------|
| name | string | Player full name |
| country | string | Country name |
| matches | number | Matches played |
| innings | number | Innings batted |
| runs | number | Total runs scored |
| highest_score | string | Highest score (e.g., "400*") |
| average | number | Batting average |
| strike_rate | number | Strike rate |
| centuries | number | Number of 100s |
| fifties | number | Number of 50s |
| wickets | number | Wickets taken |
| bowling_average | number | Bowling average |
| economy | number | Economy rate |

## Testing the API

### Using Postman

1. Create a new POST request
2. URL: `http://localhost:3001/ask`
3. Headers: `Content-Type: application/json`
4. Body (raw JSON):
   ```json
   {
     "question": "Who has the highest score in Test cricket?"
   }
   ```
5. Send and view response

### Using Browser Console

```javascript
fetch('http://localhost:3001/ask', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ question: 'Top 5 ODI run scorers' })
})
.then(r => r.json())
.then(console.log);
```

## Future Enhancements

Potential API improvements:

1. **GET /stats/:format/:player** - Direct player stats
2. **POST /compare** - Compare multiple players
3. **GET /formats** - List available formats
4. **POST /upload** - Upload new CSV data
5. **GET /health** - Health check endpoint
6. **WebSocket support** - Real-time streaming responses
