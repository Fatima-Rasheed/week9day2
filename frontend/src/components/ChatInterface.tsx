import { useState, useRef, useEffect, useCallback } from 'react';
import axios from 'axios';
import ReactMarkdown from 'react-markdown';
import styles from './ChatInterface.module.css';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  type?: 'text' | 'table';
  timestamp: Date;
}

const SUGGESTED_QUESTIONS = [
  "Who has the highest score in Test cricket?",
  "Show me top 5 ODI run scorers",
  "List all players with average above 50 in T20",
  "How many centuries does Virat Kohli have in ODI?",
];

const QUICK_STATS = [
  { label: 'Test Cricket', emoji: '🏟️' },
  { label: 'ODI Records', emoji: '🏆' },
  { label: 'T20 Stats', emoji: '⚡' },
  { label: 'Player Profiles', emoji: '👤' },
];

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const STORAGE_KEY = 'cricket_ai_messages';

function loadMessages(): Message[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Array<Omit<Message, 'timestamp'> & { timestamp: string }>;
    // Revive timestamp strings back into Date objects
    return parsed.map(m => ({ ...m, timestamp: new Date(m.timestamp) }));
  } catch {
    return [];
  }
}

function saveMessages(msgs: Message[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(msgs));
  } catch {
    // storage quota exceeded — fail silently
  }
}

export default function ChatInterface() {
  const [messages, setMessages] = useState<Message[]>(() => loadMessages());
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Persist messages to localStorage whenever they change
  useEffect(() => {
    saveMessages(messages);
  }, [messages]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, loading]);

  const sendMessage = useCallback(async (question: string) => {
    if (!question.trim() || loading) return;

    const userMessage: Message = {
      role: 'user',
      content: question,
      timestamp: new Date(),
    };
    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setLoading(true);

    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
      const response = await axios.post(`${apiUrl}/ask`, { question });

      const assistantMessage: Message = {
        role: 'assistant',
        content: response.data.answer,
        type: response.data.type,
        timestamp: new Date(),
      };
      setMessages(prev => [...prev, assistantMessage]);
    } catch {
      setMessages(prev => [
        ...prev,
        {
          role: 'assistant',
          content: '⚠️ Something went wrong. Please check your connection and try again.',
          type: 'text',
          timestamp: new Date(),
        },
      ]);
    } finally {
      setLoading(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [loading]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    sendMessage(input);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  const handleCopy = async (text: string, idx: number) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx(null), 2000);
    } catch {
      // clipboard not available
    }
  };

  const renderMarkdownTable = (markdown: string) => {
    const lines = markdown.trim().split('\n').filter(line => line.trim());
    if (lines.length < 2) return <pre>{markdown}</pre>;

    const headers = lines[0].split('|').map(h => h.trim()).filter(h => h);
    const rows = lines.slice(2).map(line =>
      line.split('|').map(cell => cell.trim()).filter(cell => cell)
    );

    return (
      <div className={styles.tableContainer}>
        <table className={styles.table}>
          <thead>
            <tr>
              {headers.map((header, i) => <th key={i}>{header}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) => <td key={j}>{cell}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  const renderMessage = (message: Message, index: number) => {
    const isUser = message.role === 'user';
    const isTable = message.type === 'table' && message.content.includes('|');

    return (
      <div
        key={index}
        className={`${styles.messageRow} ${isUser ? styles.userRow : styles.assistantRow}`}
      >
        {/* Avatar */}
        <div className={`${styles.avatar} ${isUser ? styles.avatarUser : styles.avatarBot}`}>
          {isUser ? '👤' : '🤖'}
        </div>

        {/* Bubble + meta */}
        <div className={styles.bubbleWrapper}>
          <div className={styles.roleMeta}>
            <span className={styles.roleName}>{isUser ? 'You' : 'Cricket AI'}</span>
            <span className={styles.timestamp}>{formatTime(message.timestamp)}</span>
          </div>

          <div className={`${styles.message} ${styles[message.role]}`}>
            {isTable
              ? renderMarkdownTable(message.content)
              : (
                <div className={styles.messageContent}>
                  <ReactMarkdown>{message.content}</ReactMarkdown>
                </div>
              )
            }

            {/* Copy button */}
            <button
              className={`${styles.copyBtn} ${!isUser ? styles.copyBtnAssistant : ''}`}
              onClick={() => handleCopy(message.content, index)}
              title="Copy"
            >
              {copiedIdx === index ? '✓ Copied' : '⎘ Copy'}
            </button>
          </div>
        </div>
      </div>
    );
  };

  const handleClearChat = () => {
    setMessages([]);
    localStorage.removeItem(STORAGE_KEY);
  };

  const charLimit = 300;
  const charLeft = charLimit - input.length;

  return (
    <div className={styles.chatContainer}>
      {/* Messages */}
      <div className={styles.messagesContainer}>

        {/* Welcome state */}
        {messages.length === 0 && (
          <div className={styles.welcomeScreen}>
            <div className={styles.welcomeHero}>
              <div className={styles.welcomeOrb}>🏏</div>
              <h2 className={styles.welcomeTitle}>What would you like to know?</h2>
              <p className={styles.welcomeSubtitle}>
                Ask about player stats, records, rankings, and more
              </p>
            </div>

            {/* Quick stat chips */}
            <div className={styles.quickStats}>
              {QUICK_STATS.map((s, i) => (
                <span key={i} className={styles.statChip}>
                  <span className={styles.statChipDot} />
                  {s.emoji} {s.label}
                </span>
              ))}
            </div>

            <span className={styles.suggestionsLabel}>Try asking</span>
            <div className={styles.suggestedQuestions}>
              {SUGGESTED_QUESTIONS.map((q, i) => (
                <button
                  key={i}
                  className={styles.suggestionButton}
                  onClick={() => sendMessage(q)}
                >
                  {q}
                </button>
              ))}
            </div>

            <p className={styles.poweredBy}>
              <span>⚡</span> Powered by AI · Real cricket data
            </p>
          </div>
        )}

        {/* Conversation start divider */}
        {messages.length > 0 && (
          <div className={styles.dateDivider}>
            <span className={styles.dateDividerText}>Today</span>
          </div>
        )}

        {/* Messages */}
        {messages.map((msg, idx) => renderMessage(msg, idx))}

        {/* Typing indicator */}
        {loading && (
          <div className={`${styles.messageRow} ${styles.assistantRow}`}>
            <div className={`${styles.avatar} ${styles.avatarBot}`}>🤖</div>
            <div className={styles.bubbleWrapper}>
              <div className={styles.roleMeta}>
                <span className={styles.roleName}>Cricket AI</span>
              </div>
              <div className={`${styles.message} ${styles.assistant}`}>
                <div className={styles.typing}>
                  <span /><span /><span />
                </div>
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className={styles.inputArea}>
        <div className={styles.inputHint}>
          <span className={styles.inputHintDot} />
          Press Enter to send · Shift+Enter for new line
          {messages.length > 0 && (
            <button
              className={styles.clearBtn}
              onClick={handleClearChat}
              title="Clear chat history"
            >
              🗑 Clear chat
            </button>
          )}
        </div>

        <form onSubmit={handleSubmit} className={styles.inputForm}>
          <div className={styles.inputWrapper}>
            <span className={styles.inputIcon}>🔍</span>
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={e => setInput(e.target.value.slice(0, charLimit))}
              onKeyDown={handleKeyDown}
              placeholder="Ask about cricket stats, records, players…"
              className={styles.input}
              disabled={loading}
              autoComplete="off"
            />
            {input.length > charLimit * 0.8 && (
              <span className={`${styles.charCount} ${charLeft < 30 ? styles.charCountWarn : ''}`}>
                {charLeft}
              </span>
            )}
          </div>

          <button
            type="submit"
            className={styles.sendButton}
            disabled={loading || !input.trim()}
            title="Send message"
          >
            ➤
          </button>
        </form>
      </div>
    </div>
  );
}
