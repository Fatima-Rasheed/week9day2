# Testing Guide

## Manual Testing Checklist

### 1. Data Import Test

```bash
cd scripts
npm run import
```

**Expected Output**:
```
✓ Imported 10 records into 'test' collection
✓ Imported 10 records into 'odi' collection
✓ Imported 10 records into 't20' collection
✓ All data imported successfully!
```

**Verify in MongoDB**:
```bash
mongosh cricket_stats
db.odi.countDocuments()  # Should return 10
db.test.countDocuments() # Should return 10
db.t20.countDocuments()  # Should return 10
```

### 2. Backend API Test

Start backend:
```bash
cd backend
npm run start:dev
```

**Test with cURL**:
```bash
# Test 1: Simple question
curl -X POST http://localhost:3001/ask \
  -H "Content-Type: application/json" \
  -d '{"question": "Who has the highest score in Test cricket?"}'

# Test 2: Top N query
curl -X POST http://localhost:3001/ask \
  -H "Content-Type: application/json" \
  -d '{"question": "Top 5 ODI run scorers"}'

# Test 3: Non-cricket question
curl -X POST http://localhost:3001/ask \
  -H "Content-Type: application/json" \
  -d '{"question": "Who won the FIFA World Cup?"}'
```

### 3. Frontend UI Test

Start frontend:
```bash
cd frontend
npm run dev
```

Open http://localhost:3000

**Test Cases**:

1. **Suggested Questions**
   - Click each suggested question
   - Verify response appears
   - Check formatting (text vs table)

2. **Custom Questions**
   - Type: "Virat Kohli ODI stats"
   - Type: "Top 3 Indian players in T20"
   - Type: "Who is the best football player?" (should reject)

3. **UI Elements**
   - Typing indicator appears while loading
   - Messages scroll automatically
   - Tables render correctly
   - Send button disables when empty

## Test Scenarios

### Scenario 1: Text Response

**Input**: "Who has the highest score in Test cricket?"

**Expected**:
- Response type: `text`
- Content: Mentions "Brian Lara" and "400*"
- Format: Plain sentence

### Scenario 2: Table Response

**Input**: "Show me top 5 ODI run scorers"

**Expected**:
- Response type: `table`
- Content: Markdown table with 5 rows
- Columns: Name, Country, Runs, Average (or similar)
- Data: Sachin Tendulkar should be #1

### Scenario 3: Filtered Query

**Input**: "List all Indian players in ODI"

**Expected**:
- Response type: `table`
- Content: Only Indian players
- Should include: Sachin, Virat, Rohit, MS Dhoni, etc.

### Scenario 4: Specific Player

**Input**: "Virat Kohli's ODI statistics"

**Expected**:
- Response type: `text` or `table`
- Content: Virat's stats (runs, average, centuries)
- Accurate numbers from database

### Scenario 5: Non-Cricket Question

**Input**: "What's the weather today?"

**Expected**:
- Response type: `text`
- Content: "Sorry, I can only answer cricket-related questions."

### Scenario 6: Format-Specific Query

**Input**: "Top 3 T20 batsmen"

**Expected**:
- Response type: `table`
- Content: Data from T20 collection only
- Should include players like Virat, Rohit, Babar

### Scenario 7: Comparison Query

**Input**: "Who has more runs: Sachin or Virat in ODI?"

**Expected**:
- Response type: `text`
- Content: Comparison with numbers
- Answer: Sachin (18,426 vs 13,848)

## Edge Cases

### Empty Results

**Input**: "Players from Zimbabwe in ODI"

**Expected**: "No results found for your query."

### Ambiguous Format

**Input**: "Top 5 run scorers" (no format specified)

**Expected**: Should default to ODI and return results

### Misspelled Names

**Input**: "Virat Kohlee stats"

**Expected**: Either no results or fuzzy match if implemented

### Complex Aggregations

**Input**: "Average runs of all Indian players"

**Expected**: May fail if aggregation not implemented
Should return graceful error message

## Performance Testing

### Response Time Benchmarks

| Query Type | Expected Time | Acceptable Time |
|------------|---------------|-----------------|
| Simple text | 2-3 seconds | < 5 seconds |
| Table (5 rows) | 3-4 seconds | < 6 seconds |
| Filtered query | 3-5 seconds | < 7 seconds |
| Non-cricket | 1-2 seconds | < 3 seconds |

### Load Testing

Use Apache Bench or similar:
```bash
# 100 requests, 10 concurrent
ab -n 100 -c 10 -p question.json -T application/json \
  http://localhost:3001/ask
```

**question.json**:
```json
{"question": "Top 5 ODI run scorers"}
```

## Error Testing

### 1. MongoDB Down

Stop MongoDB and send a question.

**Expected**: Error message, not a crash

### 2. Invalid API Key

Set wrong ANTHROPIC_API_KEY.

**Expected**: Error message about API authentication

### 3. Malformed Request

```bash
curl -X POST http://localhost:3001/ask \
  -H "Content-Type: application/json" \
  -d '{"invalid": "data"}'
```

**Expected**: 400 Bad Request

### 4. Network Timeout

Simulate slow network to Anthropic API.

**Expected**: Timeout error, graceful handling

## Debugging Tips

### Backend Logs

Check console output for:
- MongoDB connection status
- AI API calls and responses
- Generated MongoDB queries
- Error stack traces

### Frontend Console

Open browser DevTools:
- Check Network tab for API calls
- Look for JavaScript errors
- Verify request/response payloads

### MongoDB Queries

Test queries directly:
```javascript
// In mongosh
use cricket_stats

// Test query from logs
db.odi.find({}).sort({ runs: -1 }).limit(5)
```

### AI Prompt Testing

Copy prompts from logs and test in Claude directly to verify responses.

## Automated Testing (Future)

### Backend Unit Tests

```typescript
// chat.service.spec.ts
describe('ChatService', () => {
  it('should process cricket question', async () => {
    const result = await service.processQuestion('Top 5 ODI');
    expect(result.success).toBe(true);
    expect(result.type).toBe('table');
  });
});
```

### Frontend Component Tests

```typescript
// ChatInterface.test.tsx
describe('ChatInterface', () => {
  it('should render suggested questions', () => {
    render(<ChatInterface />);
    expect(screen.getByText(/Top 5 ODI/)).toBeInTheDocument();
  });
});
```

### Integration Tests

```typescript
// e2e.test.ts
describe('End-to-End', () => {
  it('should answer cricket question', async () => {
    const response = await request(app)
      .post('/ask')
      .send({ question: 'Top 5 ODI run scorers' });
    
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
  });
});
```

## Test Data Validation

Verify sample data accuracy:

```javascript
// In mongosh
use cricket_stats

// Check Sachin's ODI stats
db.odi.findOne({ name: "Sachin Tendulkar" })
// Should show: runs: 18426, average: 44.83

// Check Brian Lara's Test stats
db.test.findOne({ name: "Brian Lara" })
// Should show: highest_score: "400*"
```

## Continuous Testing

### Pre-Commit Checklist
- [ ] All dependencies installed
- [ ] MongoDB running and data imported
- [ ] Backend starts without errors
- [ ] Frontend starts without errors
- [ ] At least 3 test questions work
- [ ] No console errors in browser

### Pre-Deployment Checklist
- [ ] All environment variables set
- [ ] Production MongoDB configured
- [ ] API keys valid
- [ ] CORS configured for production domain
- [ ] Error handling tested
- [ ] Performance acceptable
- [ ] Security review completed
