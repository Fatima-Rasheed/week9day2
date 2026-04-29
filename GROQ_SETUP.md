# Groq API Setup Guide

## Why Groq?

✅ **FREE** - Generous free tier  
✅ **FAST** - Ultra-fast inference (10x faster than others)  
✅ **POWERFUL** - Llama 3.1 70B model  
✅ **EASY** - OpenAI-compatible API  

## Getting Your Groq API Key

### Step 1: Sign Up
1. Go to https://console.groq.com/
2. Click "Sign Up" (free account)
3. Verify your email

### Step 2: Get API Key
1. Log in to Groq Console
2. Click on "API Keys" in the sidebar
3. Click "Create API Key"
4. Copy your API key (starts with `gsk_...`)

### Step 3: Add to Project
1. Open `backend/.env`
2. Add your key:
   ```
   GROQ_API_KEY=gsk_your_actual_key_here
   ```

## Groq Free Tier Limits

- **Requests per minute**: 30
- **Requests per day**: 14,400
- **Tokens per minute**: 6,000

**This is MORE than enough for development and testing!**

## Models Available

The project uses **llama-3.1-70b-versatile** which is:
- Fast and accurate
- Great for structured outputs
- Perfect for query generation

Other models you can try:
- `llama-3.1-8b-instant` - Even faster, good for simple tasks
- `mixtral-8x7b-32768` - Good for longer contexts
- `gemma2-9b-it` - Lightweight alternative

## Switching Models

To use a different model, edit `backend/src/chat/langgraph.service.ts`:

```typescript
const response = await axios.post(
  'https://api.groq.com/openai/v1/chat/completions',
  {
    model: 'llama-3.1-8b-instant', // Change this
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
    max_tokens: 2000,
  },
  // ...
);
```

## Cost Comparison

| Provider | Free Tier | Cost per 1M tokens |
|----------|-----------|-------------------|
| **Groq** | ✅ Generous | FREE (in beta) |
| Anthropic | $5 credit | $3-15 |
| OpenAI | $5 credit | $0.50-60 |

## Testing Your Setup

After adding your API key:

```bash
cd backend
npm run start:dev
```

You should see:
```
✓ Connected to MongoDB
🚀 Backend running on http://localhost:3001
```

Then test with a question in the frontend!

## Troubleshooting

### "Invalid API key"
- Make sure you copied the full key (starts with `gsk_`)
- Check for extra spaces in .env file
- Regenerate key if needed

### "Rate limit exceeded"
- Free tier: 30 requests/minute
- Wait a minute and try again
- Consider upgrading if needed (still very cheap)

### "Model not found"
- Check model name spelling
- Use one of the supported models listed above

## Performance Tips

1. **Use llama-3.1-8b-instant** for faster responses
2. **Lower temperature** (0.1-0.3) for more consistent outputs
3. **Reduce max_tokens** if responses are too long

## Groq vs Anthropic

| Feature | Groq | Anthropic |
|---------|------|-----------|
| Speed | ⚡ Ultra-fast | Normal |
| Free Tier | ✅ Generous | $5 credit |
| Cost | FREE (beta) | $3-15/1M tokens |
| Quality | Excellent | Excellent |
| Best For | This project! | Complex reasoning |

**For this cricket stats project, Groq is the better choice!**

## Additional Resources

- [Groq Documentation](https://console.groq.com/docs)
- [Groq Playground](https://console.groq.com/playground)
- [Model Comparison](https://console.groq.com/docs/models)

---

**Ready to start?** Get your free API key at https://console.groq.com/ 🚀
