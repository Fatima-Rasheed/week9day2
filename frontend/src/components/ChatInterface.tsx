import { useState, useRef, useEffect, useCallback } from 'react';
import axios from 'axios';
import ReactMarkdown from 'react-markdown';
import styles from './ChatInterface.module.css';

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

interface Message {
  role: 'user' | 'assistant';
  content: string;
  type?: 'text' | 'table';
  timestamp: Date;
  memoryUsed?: boolean;
}

interface HistoryEntry {
  question: string;
  answer: string;
  timestamp: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const SUGGESTED_QUESTIONS = [
  'Who has the highest score in Test cricket?',
  'Show me top 5 ODI run scorers',
  'List all players with average above 50 in T20',
  'How many centuries does Virat Kohli have in ODI?',
];

const QUICK_STATS = [
  { label: 'Test Cricket', emoji: '🏟️' },
  { label: 'ODI Records', emoji: '🏆' },
  { label: 'T20 Stats', emoji: '⚡' },
  { label: 'Player Profiles', emoji: '👤' },
];

const STORAGE_KEY = 'cricket_ai_messages';
const USER_ID_KEY = 'cricket_ai_user_id';

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatHistoryTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

/** Generate or retrieve a stable userId stored in localStorage */
function getOrCreateUserId(): string {
  try {
    const existing = localStorage.getItem(USER_ID_KEY);
    if (existing) return existing;
    const id = `user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    localStorage.setItem(USER_ID_KEY, id);
    return id;
  } catch {
    return 'anonymous';
  }
}

function loadMessages(): Message[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Array<Omit<Message, 'timestamp'> & { timestamp: string }>;
    return parsed.map(m => ({ ...m, timestamp: new Date(m.timestamp) }));
  } catch {
    return [];
  }
}

function saveMessages(msgs: Message[]) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(msgs));
  } catch {
    // storage quota exceeded — fail silently
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

export default function ChatInterface() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [userId, setUserId] = useState('anonymous');

  // History panel
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historySummary, setHistorySummary] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [clearingMemory, setClearingMemory] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // ── Hydration ──────────────────────────────────────────────────────────────
  useEffect(() => {
    setMessages(loadMessages());
    setUserId(getOrCreateUserId());
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (hydrated) saveMessages(messages);
  }, [messages, hydrated]);

  // ── Scroll ─────────────────────────────────────────────────────────────────
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, loading]);

  // ── Fetch history panel data ───────────────────────────────────────────────
  const fetchHistory = useCallback(async () => {
    if (!userId || userId === 'anonymous') return;
    setHistoryLoading(true);
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
      const [histRes, sumRes] = await Promise.all([
        axios.get(`${apiUrl}/history/${userId}`),
        axios.get(`${apiUrl}/summary/${userId}`),
      ]);
      setHistory(histRes.data.history ?? []);
      setHistorySummary(sumRes.data.summary?.summary ?? null);
    } catch {
      // non-fatal
    } finally {
      setHistoryLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    if (showHistory) fetchHistory();
  }, [showHistory, fetchHistory]);

  // ── Clear memory ───────────────────────────────────────────────────────────
  const handleClearMemory = useCallback(async () => {
    if (!userId || userId === 'anonymous') return;
    if (!window.confirm('Clear all conversation memory from the database? This cannot be undone.')) return;
    setClearingMemory(true);
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
      await axios.delete(`${apiUrl}/memory/${userId}`);
      setHistory([]);
      setHistorySummary(null);
    } catch {
      // non-fatal
    } finally {
      setClearingMemory(false);
    }
  }, [userId]);

  // ── Send message ───────────────────────────────────────────────────────────
  const sendMessage = useCallback(
    async (question: string) => {
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
        const response = await axios.post(`${apiUrl}/ask`, { question, userId });

        const assistantMessage: Message = {
          role: 'assistant',
          content: response.data.answer,
          type: response.data.type,
          timestamp: new Date(),
          memoryUsed: response.data.memoryUsed,
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
    },
    [loading, userId],
  );

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

  const handleClearChat = () => {
    setMessages([]);
    sessionStorage.removeItem(STORAGE_KEY);
  };

  // ── Render helpers ─────────────────────────────────────────────────────────

  const renderMarkdownTable = (markdown: string) => {
    const allLines = markdown.trim().split('\n');

    // Extract optional title line (bold text before the table)
    let title = '';
    const tableLines: string[] = [];
    for (const line of allLines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (!trimmed.startsWith('|')) {
        // Non-table line — treat as title (strip markdown bold **)
        title = trimmed.replace(/\*\*/g, '');
      } else {
        tableLines.push(trimmed);
      }
    }

    if (tableLines.length < 2) return <pre>{markdown}</pre>;

    // First table line = headers, second = separator (skip it), rest = rows
    const headers = tableLines[0].split('|').map(h => h.trim()).filter(h => h);
    // Skip the separator row (all --- cells)
    const isSeparator = (line: string) => line.split('|').map(c => c.trim()).filter(c => c).every(c => /^-+$/.test(c));
    const dataLines = tableLines.slice(1).filter(l => !isSeparator(l));

    const rows = dataLines.map(line =>
      line.split('|').map(cell => cell.trim()).filter(cell => cell),
    );

    // Also extract footer line (summary text after the table, no |)
    const footerLines = allLines.filter(l => l.trim() && !l.trim().startsWith('|') && !l.trim().startsWith('**'));

    return (
      <div className={styles.tableContainer}>
        {title && <div className={styles.tableTitle}>{title}</div>}
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
        {footerLines.length > 0 && (
          <div className={styles.tableFooter}>{footerLines.join(' ')}</div>
        )}
      </div>
    );
  };

  const renderMessage = (message: Message, index: number) => {
    const isUser = message.role === 'user';
    // Auto-detect table: either explicitly typed as table, or content looks like markdown table
    const looksLikeTable = message.content.includes('|') &&
      message.content.split('\n').filter(l => l.trim().startsWith('|')).length >= 2;
    const isTable = (message.type === 'table' || looksLikeTable) && message.content.includes('|');

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
            {/* Memory indicator */}
            {!isUser && message.memoryUsed && (
              <span className={styles.memoryBadge} title="Answer used conversation memory">
                🧠 memory
              </span>
            )}
          </div>

          <div className={`${styles.message} ${styles[message.role]}`}>
            {isTable
              ? renderMarkdownTable(message.content)
              : (
                <div className={styles.messageContent}>
                  <ReactMarkdown>{message.content}</ReactMarkdown>
                </div>
              )}

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

  const charLimit = 300;
  const charLeft = charLimit - input.length;

  if (!hydrated) return null;

  return (
    <div className={styles.chatWrapper}>
      {/* ── History Panel ──────────────────────────────────────────────────── */}
      {/* Mobile backdrop — tap to close */}
      {showHistory && (
        <div
          className={styles.historyOverlay}
          onClick={() => setShowHistory(false)}
          aria-hidden="true"
        />
      )}
      <div className={`${styles.historyPanel} ${showHistory ? styles.historyPanelOpen : ''}`}>
        <div className={styles.historyHeader}>
          <span className={styles.historyTitle}>🧠 Memory &amp; History</span>
          <div className={styles.historyHeaderActions}>
            <button
              className={styles.clearMemoryBtn}
              onClick={handleClearMemory}
              disabled={clearingMemory || historyLoading}
              title="Clear all memory from database"
            >
              {clearingMemory ? '…' : '🗑 Clear Memory'}
            </button>
            <button
              className={styles.historyCloseBtn}
              onClick={() => setShowHistory(false)}
              aria-label="Close history panel"
            >
              ✕
            </button>
          </div>
        </div>

        {historyLoading ? (
          <div className={styles.historyLoading}>
            <div className={styles.typing}><span /><span /><span /></div>
          </div>
        ) : (
          <>
            {/* Memory summary */}
            {historySummary && (
              <div className={styles.summaryBox}>
                <div className={styles.summaryLabel}>📋 Memory Summary</div>
                <div className={styles.summaryText}>{historySummary}</div>
              </div>
            )}

            {/* Conversation history */}
            <div className={styles.historyList}>
              {history.length === 0 ? (
                <div className={styles.historyEmpty}>
                  No conversation history yet. Start chatting!
                </div>
              ) : (
                [...history].reverse().map((entry, i) => (
                  <div key={i} className={styles.historyEntry}>
                    <div className={styles.historyEntryTime}>
                      {formatHistoryTime(entry.timestamp)}
                    </div>
                    <div className={styles.historyEntryQ}>
                      <span className={styles.historyQIcon}>Q</span>
                      {entry.question}
                    </div>
                    <div className={styles.historyEntryA}>
                      <span className={styles.historyAIcon}>A</span>
                      {entry.answer.slice(0, 120)}{entry.answer.length > 120 ? '…' : ''}
                    </div>
                    {/* Re-ask button */}
                    <button
                      className={styles.reAskBtn}
                      onClick={() => {
                        setShowHistory(false);
                        sendMessage(entry.question);
                      }}
                    >
                      ↩ Ask again
                    </button>
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </div>

      {/* ── Main Chat ──────────────────────────────────────────────────────── */}
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
                <span>⚡</span> Powered by AI · Real cricket data · 🧠 Memory enabled
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
            <span className={styles.inputHintText}>Press Enter to send · Shift+Enter for new line</span>
            <div className={styles.inputHintActions}>
              {/* History toggle */}
              <button
                className={styles.historyToggleBtn}
                onClick={() => setShowHistory(v => !v)}
                title="View conversation history &amp; memory"
              >
                🧠 Memory
              </button>
              {messages.length > 0 && (
                <button
                  className={styles.clearBtn}
                  onClick={handleClearChat}
                  title="Clear chat history"
                >
                  🗑 Clear
                </button>
              )}
            </div>
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
    </div>
  );
}
