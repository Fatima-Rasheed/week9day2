import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../database/database.service';
import axios from 'axios';

// ─────────────────────────────────────────────────────────────────────────────
// MEMORY TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface ConversationEntry {
  userId: string;
  question: string;
  answer: string;
  timestamp: Date;
}

export interface MemorySummary {
  userId: string;
  summary: string;
  updatedAt: Date;
  entryCount: number;
}

// How many conversation turns to keep before summarising
const MEMORY_SUMMARISE_THRESHOLD = 5;

interface WorkflowState {
  question: string;
  userId: string;
  isRelevant?: boolean;
  relevancyReason?: string;
  // Memory
  conversationHistory?: ConversationEntry[];
  memorySummary?: string;
  enrichedQuestion?: string;
  // Query
  generatedQuery?: any;
  queryResults?: any[];
  formattedAnswer?: string;
  answerType?: 'text' | 'table';
  error?: string;
}

/**
 * Model fallback chain — tried in order when a model hits rate limits.
 * llama-3.3-70b-versatile is best for query generation; falls back to smaller models.
 */
const GROQ_MODEL_CHAIN = [
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'gemma2-9b-it',
  'mixtral-8x7b-32768',
];

// ─────────────────────────────────────────────────────────────────────────────
// SHARED CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Words that should never be treated as a player name.
 * Tests a single-word capture group.
 */
const GENERIC_SINGLE_WORD =
  /^(?:a|the|this|that|team|player|match|game|cricket|all|any|every|which|what|who|how|when|where|why|me|us|him|her|them|it|did|has|have|had|is|was|were|are|be|been|being)$/i;

/**
 * Multi-word phrases that look like a name extraction but aren't.
 * e.g. "this player", "the player", "that team".
 */
const GENERIC_PHRASE = /^(this|that|the|a)\s+(player|team|batter|batsman|bowler|match|game|cricketer)$/i;

/**
 * Returns true when a captured string is a real candidate for a player name.
 */
function isValidPlayerName(name: string): boolean {
  if (!name || name.length < 3) return false;
  if (GENERIC_SINGLE_WORD.test(name)) return false;
  if (GENERIC_PHRASE.test(name)) return false;
  if (/^\d+$/.test(name)) return false; // pure numbers
  return true;
}

@Injectable()
export class LangGraphService {
  private schemaDescription: any;

  constructor(
    private configService: ConfigService,
    private databaseService: DatabaseService,
  ) {
    this.schemaDescription = {};
    console.log('✓ Schema initialized');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PUBLIC: GET CONVERSATION HISTORY
  // ─────────────────────────────────────────────────────────────────────────────

  async getHistory(userId: string): Promise<ConversationEntry[]> {
    const db = this.databaseService.getDb();
    return db
      .collection('conversations')
      .find({ userId })
      .sort({ timestamp: -1 })
      .limit(50)
      .toArray() as unknown as ConversationEntry[];
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PUBLIC: GET MEMORY SUMMARY
  // ─────────────────────────────────────────────────────────────────────────────

  async getMemorySummary(userId: string): Promise<MemorySummary | null> {
    const db = this.databaseService.getDb();
    return db
      .collection('summaries')
      .findOne({ userId }) as unknown as MemorySummary | null;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PUBLIC: CLEAR MEMORY
  // ─────────────────────────────────────────────────────────────────────────────

  async clearMemory(userId: string): Promise<{ deleted: number }> {
    const db = this.databaseService.getDb();
    const [convResult] = await Promise.all([
      db.collection('conversations').deleteMany({ userId }),
      db.collection('summaries').deleteOne({ userId }),
    ]);
    console.log(`=== MEMORY CLEARED for user ${userId}: ${convResult.deletedCount} conversations removed ===`);
    return { deleted: convResult.deletedCount };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PUBLIC ENTRY POINT
  // ─────────────────────────────────────────────────────────────────────────────

  async runWorkflow(
    question: string,
    userId = 'anonymous',
  ): Promise<{ answer: string; type: 'text' | 'table'; memoryUsed: boolean }> {
    const state: WorkflowState = { question, userId };

    // ── Node 1: Relevancy Checker ─────────────────────────────────────────────
    await this.checkRelevancy(state);
    if (!state.isRelevant) {
      return {
        answer: state.relevancyReason ?? 'I can only answer cricket-related questions.',
        type: 'text',
        memoryUsed: false,
      };
    }

    // ── Node 2: Memory Retriever ──────────────────────────────────────────────
    await this.retrieveMemory(state);

    // ── Node 3: Query Generator (with memory context) ─────────────────────────
    // For clear follow-up questions (pronouns, vague phrases, no explicit entity)
    // skip rule-based entirely — the AI uses enrichedQuestion with full context.
    // For all other questions, try rule-based first (fast, zero tokens).
    const skipRuleBased = this.isFollowUpQuestion(state);
    if (!skipRuleBased) {
      this.tryRuleBasedQuery(state);
    } else {
      console.log(`=== FOLLOW-UP DETECTED: skipping rule-based, using AI with context ===`);
    }
    if (!state.generatedQuery) {
      await this.generateQuery(state);
    }

    if (state.error || !state.generatedQuery) {
      return {
        answer: `Sorry, I could not generate a query for that question. Error: ${state.error ?? 'unknown'}. Please try rephrasing.`,
        type: 'text',
        memoryUsed: !!(state.memorySummary || state.conversationHistory?.length),
      };
    }

    // ── Node 4: Query Executor ────────────────────────────────────────────────
    await this.executeQuery(state);

    if (state.error) {
      return {
        answer: `Sorry, there was an error running the query: ${state.error}`,
        type: 'text',
        memoryUsed: !!(state.memorySummary || state.conversationHistory?.length),
      };
    }

    // executeQuery may have set formattedAnswer directly (e.g. empty collection warning)
    if (!state.formattedAnswer) {
      // ── Node 5: Answer Formatter ──────────────────────────────────────────
      await this.formatAnswer(state);
    }

    // ── Node 6: Memory Saver ──────────────────────────────────────────────────
    await this.saveMemory(state);

    // ── Node 7: Final Response ────────────────────────────────────────────────
    return {
      answer: state.formattedAnswer ?? 'No results found.',
      type: state.answerType ?? 'text',
      memoryUsed: !!(state.memorySummary || state.conversationHistory?.length),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // NODE 1: RELEVANCY CHECKER
  // ─────────────────────────────────────────────────────────────────────────────

  private async checkRelevancy(state: WorkflowState): Promise<void> {
    const q = state.question.toLowerCase().trim();

    // Fast keyword check — if clearly cricket-related, skip AI call
    const cricketKeywords = [
      'cricket', 'odi', 't20', 'test match', 'wicket', 'batsman', 'bowler',
      'innings', 'over', 'run', 'century', 'fifty', 'player', 'team', 'match',
      'score', 'average', 'stats', 'record', 'icc', 'bcci', 'ecb', 'squad',
      'captain', 'batting', 'bowling', 'fielding', 'stumping', 'catch',
      'lbw', 'no ball', 'wide', 'boundary', 'six', 'four', 'duck',
    ];

    const hasCricketKeyword = cricketKeywords.some(kw => q.includes(kw));
    if (hasCricketKeyword) {
      state.isRelevant = true;
      return;
    }

    // Contextual follow-up: short questions that reference prior context
    const followUpPatterns = [
      /^(and\s+)?(what\s+about|how\s+about|what\s+about\s+in)\s+/i,
      /^(and\s+)?(in\s+)?(test|odi|t20i?)\s*(cricket)?[?!.]?$/i,
      /^(same\s+for|compare\s+with|vs\.?|versus)\s+/i,
      /^(who|what|how|when|where|which)\s+/i,
    ];

    const isFollowUp = followUpPatterns.some(p => p.test(q));
    if (isFollowUp) {
      state.isRelevant = true;
      return;
    }

    // Clearly off-topic patterns
    const offTopicPatterns = [
      /\b(weather|stock|price|recipe|cook|movie|film|music|song|politic|election|war|covid|vaccine|crypto|bitcoin)\b/i,
    ];

    if (offTopicPatterns.some(p => p.test(q))) {
      state.isRelevant = false;
      state.relevancyReason =
        "I'm a cricket statistics assistant. I can only answer questions about cricket players, matches, and records. Please ask me something cricket-related!";
      return;
    }

    // Default: allow through (cricket-only app)
    state.isRelevant = true;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // NODE 2: MEMORY RETRIEVER
  // ─────────────────────────────────────────────────────────────────────────────

  private async retrieveMemory(state: WorkflowState): Promise<void> {
    try {
      const db = this.databaseService.getDb();

      // Fetch last 5 conversation turns for this user
      const recentHistory = await db
        .collection('conversations')
        .find({ userId: state.userId })
        .sort({ timestamp: -1 })
        .limit(5)
        .toArray() as unknown as ConversationEntry[];

      state.conversationHistory = recentHistory.reverse(); // oldest first

      // Fetch existing summary
      const summaryDoc = await db
        .collection('summaries')
        .findOne({ userId: state.userId }) as unknown as MemorySummary | null;

      if (summaryDoc?.summary) {
        state.memorySummary = summaryDoc.summary;
      }

      // Build enriched question using memory context
      if (state.conversationHistory.length > 0 || state.memorySummary) {
        state.enrichedQuestion = this.buildEnrichedQuestion(state);
        // Resolve pronouns in the raw question so rule-based path also benefits
        this.resolvePronouns(state);
      } else {
        state.enrichedQuestion = state.question;
      }

      console.log(
        `=== MEMORY: ${state.conversationHistory.length} recent turns, summary: ${!!state.memorySummary} ===`,
      );
    } catch (err) {
      console.warn('Memory retrieval failed (non-fatal):', err.message);
      state.enrichedQuestion = state.question;
      state.conversationHistory = [];
    }
  }

  /**
   * Strips markdown table syntax from an answer so it can be used as plain-text
   * context in follow-up question enrichment.
   */
  private stripTableToSummary(answer: string): string {
    // If it doesn't look like a table, return as-is (truncated)
    if (!answer.includes('|')) {
      return answer.slice(0, 300);
    }

    // Extract the bold header line (e.g. "**Virat Kohli (India) — Career Statistics**")
    const headerMatch = answer.match(/\*\*([^*]+)\*\*/);
    const header = headerMatch ? headerMatch[1] : '';

    // Extract column headers from the first table row
    const lines = answer.split('\n').filter(l => l.trim());
    const tableLines = lines.filter(l => l.trim().startsWith('|'));
    if (tableLines.length === 0) return answer.slice(0, 300);

    const colHeaders = tableLines[0]
      .split('|')
      .map(h => h.trim())
      .filter(h => h && h !== '---');

    // Extract data rows (skip header and separator rows)
    const dataRows = tableLines
      .slice(2) // skip header row and separator row
      .slice(0, 5) // take at most 5 rows for context
      .map(row =>
        row
          .split('|')
          .map(c => c.trim())
          .filter(c => c),
      );

    if (dataRows.length === 0) return header || answer.slice(0, 300);

    // Build a compact plain-text summary
    const rowSummaries = dataRows.map(cells =>
      colHeaders
        .map((col, i) => (cells[i] && cells[i] !== '-' ? `${col}: ${cells[i]}` : null))
        .filter(Boolean)
        .join(', '),
    );

    const summary = header
      ? `${header} — ${rowSummaries.join(' | ')}`
      : rowSummaries.join(' | ');

    return summary.slice(0, 400);
  }

  /**
   * Builds a context-enriched version of the question by appending recent
   * conversation history so the query generator understands follow-up questions.
   */
  private buildEnrichedQuestion(state: WorkflowState): string {
    const parts: string[] = [];

    if (state.memorySummary) {
      parts.push(`[Memory Summary: ${state.memorySummary}]`);
    }

    if (state.conversationHistory && state.conversationHistory.length > 0) {
      const historyLines = state.conversationHistory
        .map(e => `Q: ${e.question}\nA: ${this.stripTableToSummary(e.answer)}`)
        .join('\n---\n');
      parts.push(`[Recent conversation:\n${historyLines}\n]`);
    }

    parts.push(`Current question: ${state.question}`);
    return parts.join('\n\n');
  }

  /**
   * Resolves pronouns and vague references in state.question using conversation
   * history, so the rule-based query path can identify the correct entity.
   *
   * Examples:
   *   "what is his shirt number?"  → "what is Babar Azam shirt number?"
   *   "how many ODI runs did he score?" → "how many ODI runs did Babar Azam score?"
   *   "what about her bowling style?" → "what about [player] bowling style?"
   *   "same for India?" → "same for India?"  (team already explicit, no change)
   */
  private resolvePronouns(state: WorkflowState): void {
    const q = state.question;

    // Only act if the question contains a pronoun/vague reference
    const hasPronoun = /\b(he|his|him|she|her|they|their|them|the player|same player|that player|this player|the team|same team|that team)\b/i.test(q);
    if (!hasPronoun) return;

    // Extract the most recently mentioned player name from history
    const history = state.conversationHistory ?? [];
    let lastPlayerName: string | null = null;

    // Walk history newest-first to find the last mentioned entity
    for (let i = history.length - 1; i >= 0; i--) {
      const entry = history[i];

      // ── Try to extract from the previous QUESTION (most reliable) ──────────
      // "tell me about Babar Azam", "Babar Azam ODI stats", "info on Virat Kohli"
      const qPatterns = [
        /(?:about|of|for|on|is)\s+(?:player\s+)?([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){1,3})/,
        /^([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){1,3})\s+(?:odi|t20|test|stats|batting|bowling|profile|info)/i,
      ];
      for (const pat of qPatterns) {
        const m = entry.question.match(pat);
        if (m) {
          const candidate = m[1].trim().replace(/[?!.]+$/, '');
          if (isValidPlayerName(candidate) && !/\b(odi|t20|test|stats|batting|bowling|match|team)\b/i.test(candidate)) {
            lastPlayerName = candidate;
            break;
          }
        }
      }
      if (lastPlayerName) break;

      // ── Try to extract from the ANSWER ────────────────────────────────────
      const answer = entry.answer;

      // "**Mohammad Babar Azam**'s shirt number..." or "**Babar Azam (Pakistan)**"
      const boldMatch = answer.match(/\*\*([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){1,4})(?:\s*\([^)]*\))?\*\*/);
      if (boldMatch) {
        lastPlayerName = boldMatch[1].trim();
        break;
      }

      // "| Name | Mohammad Babar Azam |" from profile table
      const tableNameMatch = answer.match(/\|\s*Name\s*\|\s*([A-Za-z .'-]{3,50}?)\s*\|/);
      if (tableNameMatch) {
        lastPlayerName = tableNameMatch[1].trim();
        break;
      }

      // "Babar Azam (Pakistan) — Career Statistics"
      const headerMatch = answer.match(/([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){1,3})\s*(?:\([^)]+\))?\s*—/);
      if (headerMatch) {
        lastPlayerName = headerMatch[1].trim();
        break;
      }
    }

    // Also check memory summary
    if (!lastPlayerName && state.memorySummary) {
      const m = state.memorySummary.match(/([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){1,3})/);
      if (m) lastPlayerName = m[1].trim();
    }

    if (!lastPlayerName) return;

    console.log(`=== PRONOUN RESOLUTION: "${q}" → replacing pronoun with "${lastPlayerName}" ===`);

    // Replace pronouns with the resolved entity name
    const resolved = q
      .replace(/\b(his|her|their)\b/gi, `${lastPlayerName}'s`)
      .replace(/\b(he|she|they|him|them)\b/gi, lastPlayerName)
      .replace(/\b(the player|same player|that player|this player)\b/gi, lastPlayerName)
      .replace(/\b(the team|same team|that team)\b/gi, lastPlayerName);

    if (resolved !== q) {
      console.log(`=== PRONOUN RESOLVED: "${resolved}" ===`);
      state.question = resolved;
      // Rebuild enriched question with the resolved question
      state.enrichedQuestion = this.buildEnrichedQuestion(state);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // NODE 6: MEMORY SAVER
  // ─────────────────────────────────────────────────────────────────────────────

  private async saveMemory(state: WorkflowState): Promise<void> {
    if (!state.formattedAnswer) return;

    try {
      const db = this.databaseService.getDb();

      // Save this conversation turn
      const entry: ConversationEntry = {
        userId: state.userId,
        question: state.question,
        answer: state.formattedAnswer,
        timestamp: new Date(),
      };
      await db.collection('conversations').insertOne(entry as any);

      // Count total entries for this user
      const totalEntries = await db
        .collection('conversations')
        .countDocuments({ userId: state.userId });

      // If history is too long, summarise and replace
      if (totalEntries >= MEMORY_SUMMARISE_THRESHOLD) {
        await this.summariseAndCompressMemory(state, totalEntries);
      }

      console.log(`=== MEMORY SAVED for user ${state.userId} (total: ${totalEntries + 1}) ===`);
    } catch (err) {
      console.warn('Memory save failed (non-fatal):', err.message);
    }
  }

  /**
   * Summarises the full conversation history into a compact memory chunk,
   * then deletes old entries keeping only the last 3 turns.
   */
  private async summariseAndCompressMemory(
    state: WorkflowState,
    totalEntries: number,
  ): Promise<void> {
    try {
      const db = this.databaseService.getDb();

      // Fetch all entries for summarisation
      const allEntries = await db
        .collection('conversations')
        .find({ userId: state.userId })
        .sort({ timestamp: 1 })
        .toArray() as unknown as ConversationEntry[];

      const historyText = allEntries
        .map(e => `Q: ${e.question}\nA: ${this.stripTableToSummary(e.answer)}`)
        .join('\n---\n');

      const summaryPrompt = `You are summarising a cricket chatbot conversation for memory compression.
Summarise the key facts discussed in this conversation into 3-5 bullet points.
Focus on: players mentioned, formats discussed (ODI/Test/T20), statistics queried, and any context that would help answer follow-up questions.
Keep it under 200 words.

Conversation:
${historyText}

Summary (bullet points):`;

      let summary: string;
      try {
        summary = await this.callAI(summaryPrompt, 'llama-3.1-8b-instant');
        summary = summary.trim();
      } catch {
        // Fallback: simple concatenation of last few questions
        summary = allEntries
          .slice(-5)
          .map(e => `Asked about: ${e.question.slice(0, 80)}`)
          .join('; ');
      }

      // Upsert summary
      await db.collection('summaries').updateOne(
        { userId: state.userId },
        {
          $set: {
            userId: state.userId,
            summary,
            updatedAt: new Date(),
            entryCount: totalEntries,
          },
        },
        { upsert: true },
      );

      // Keep only the last 3 conversation entries (delete older ones)
      const keepIds = allEntries
        .slice(-3)
        .map((e: any) => e._id);

      await db.collection('conversations').deleteMany({
        userId: state.userId,
        _id: { $nin: keepIds },
      });

      console.log(`=== MEMORY COMPRESSED: ${totalEntries} entries → summary + 3 recent ===`);
    } catch (err) {
      console.warn('Memory compression failed (non-fatal):', err.message);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // HELPER: BUILD NO-RESULTS MESSAGE
  // ─────────────────────────────────────────────────────────────────────────────

  private buildNoResultsMessage(state: WorkflowState): string {
    const col = state.generatedQuery?.collection ?? '';

    // Try to extract a player name from the question
    const playerNameMatch =
      state.question.match(
        /(?:details?|info(?:rmation)?|profile|stats?|runs?|wickets?|average|centuries|batting|bowling)\s+(?:of|about|on|for|by)?\s+(?:player\s+)?([A-Za-z .'-]{3,40})/i,
      ) ??
      state.question.match(
        /(?:who\s+is|tell\s+me\s+about)\s+([A-Za-z .'-]{3,40})/i,
      );

    const rawName = playerNameMatch?.[1]?.trim().replace(/[?!.]+$/, '') ?? '';

    // Only use the extracted name if it looks like a real player name
    if (
      isValidPlayerName(rawName) &&
      (col === 'players' || col === 'players_yearly' || col === 'players_matches')
    ) {
      return `No player named "${rawName}" was found in the dataset. The dataset covers international cricketers tracked by ESPN Cricinfo. Please check the spelling or try a different name.`;
    }

    if (col === 'team_matches') {
      const filter = state.generatedQuery?.filter ?? {};
      const pipeline = state.generatedQuery?.pipeline;

      const format = filter.format ?? (pipeline ? this.extractFromPipeline(pipeline, 'format') : null);
      const year = filter.year ?? (pipeline ? this.extractFromPipeline(pipeline, 'year') : null);
      const venue = filter.venue?.$regex ?? (pipeline ? this.extractFromPipeline(pipeline, 'venue') : null);

      if (format && year) {
        return `No ${format} matches found for the year ${year} in the dataset.`;
      }
      if (format && venue) {
        return `No ${format} matches found at ${venue} in the dataset.`;
      }
      if (venue) {
        return `No matches found at "${venue}" in the dataset. The venue name may differ — try a shorter version (e.g. "Lords" instead of "Lord's Cricket Ground").`;
      }
      if (format) {
        return `No ${format} matches found matching your criteria in the dataset.`;
      }
      return `No matches found for your query. The dataset covers international cricket matches. Please check team names or filters.`;
    }

    return `No data found for your query. This information may not be available in the dataset, which covers international cricket statistics from ESPN Cricinfo.`;
  }

  private extractFromPipeline(pipeline: any[], field: string): any {
    for (const stage of pipeline) {
      const match = stage.$match;
      if (match && match[field] !== undefined) return match[field];
    }
    return null;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // HELPER: DETECT FOLLOW-UP / CONTEXT-DEPENDENT QUESTIONS
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Returns true when the question is a follow-up that needs conversation context
   * to be answered correctly. In that case we skip the rule-based path and let
   * the AI resolve the full enriched question.
   *
   * A question is a follow-up when ALL of these are true:
   *  1. There is conversation history for this user
   *  2. The question contains a pronoun OR is short/vague (no explicit entity)
   */
  private isFollowUpQuestion(state: WorkflowState): boolean {
    // No history → can't be a follow-up
    if (!state.conversationHistory?.length && !state.memorySummary) return false;

    const q = state.question.toLowerCase().trim();
    const original = state.question.trim();

    // ── 1. Explicit pronouns — always a follow-up ─────────────────────────────
    if (/\b(he|his|him|she|her|they|their|them|the player|same player|that player|this player|the team|same team|that team)\b/i.test(q)) {
      return true;
    }

    // ── 2. Explicit follow-up openers ─────────────────────────────────────────
    if (/^(what about|how about|and (in|for|about)|same for|also (show|tell|give)|now (show|tell|what)|what (were|was|is|are) (his|her|their|the)|show me (his|her|their|the)|tell me (more|his|her)|give me (his|her)|and (what|how))\b/i.test(q)) {
      return true;
    }

    // ── 3. Short vague questions with no explicit named entity ────────────────
    const wordCount = q.split(/\s+/).length;
    if (wordCount <= 6) {
      // Has an explicit named entity (two+ capitalized words not being format/keyword)?
      const hasExplicitName = /\b[A-Z][a-zA-Z'-]{2,}(?:\s+[A-Z][a-zA-Z'-]{2,})+\b/.test(original) &&
        !/^(ODI|T20I?|Test|ICC|BCCI|ECB)\b/.test(original);
      // Is it a self-contained ranking/list question?
      const isSelfContained =
        /\b(top|most|highest|best|list|show|which|who)\b/i.test(q) &&
        /\b(odi|t20i?|test)\b/i.test(q) &&
        /\b(runs?|wickets?|centuries|wins?|matches?|scorers?|takers?|batsmen?|bowlers?)\b/i.test(q);
      if (!hasExplicitName && !isSelfContained) return true;
    }

    return false;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // NODE: RULE-BASED QUERY (no AI, zero tokens)
  // ─────────────────────────────────────────────────────────────────────────────

  private tryRuleBasedQuery(state: WorkflowState): void {
    const q = state.question.toLowerCase().trim();

    // ── Player profile ────────────────────────────────────────────────────────
    // Attribute keywords that should NOT be part of the player name
    const PLAYER_ATTR_SUFFIX =
      /\s+(?:batting\s+style|bowling\s+style|batting|bowling|age|dob|date\s+of\s+birth|birthday|nationality|country|profile|details?|info(?:rmation)?|career|stats?|record|bio(?:graphy)?|shirt\s+number|jersey)[?!.]*$/i;

    /**
     * Returns true only if the string looks like a real player/person name:
     * - 2–4 words
     * - Each word starts with a capital letter (or is a known connector like "de", "van", "al")
     * - Does NOT contain question/stats words
     */
    const looksLikePlayerName = (s: string): boolean => {
      if (!isValidPlayerName(s)) return false;
      // Reject if it contains stats/match/question/ranking words
      if (/\b(how|many|odi|t20|test|played|play|in|at|were|was|are|is|did|has|have|which|who|what|when|where|why|match|matches|runs?|wickets?|score|century|centuries|average|stats?|record|team|venue|ground|stadium|sharjah|dubai|lords?|melbourne|sydney|wankhede|eden|top|most|best|highest|leading|list|show|find|get|display|all|total|number|count)\b/i.test(s)) return false;
      // Reject if contains digits (e.g. "top 5", "last 10")
      if (/\d/.test(s)) return false;
      // Reject known team/country names
      if (/^(india|pakistan|australia|england|new zealand|south africa|sri lanka|bangladesh|west indies|zimbabwe|afghanistan|ireland|scotland|netherlands|kenya|canada|usa|united states|namibia|oman|uae|united arab emirates|nepal|hong kong|singapore|malaysia|png|papua new guinea)$/i.test(s)) return false;
      // Reject if more than 5 words (sentences, not names)
      const words = s.trim().split(/\s+/);
      if (words.length > 5) return false;
      return true;
    };

    const playerDetailPatterns = [
      /(?:details?|info(?:rmation)?|profile)\s+(?:of|about|on|for)\s+(?:player\s+)?(.+)/i,
      /(?:who\s+is|tell\s+me\s+about(?:\s+player)?)\s+(.+)/i,
      /(?:player\s+)?(.+?)\s+(?:details?|info(?:rmation)?|profile)/i,
      // "what is [player]'s batting style / age / dob / country"
      /(?:what\s+is|what\s+are|what\s+was)\s+(.+?)'?s?\s+(?:batting\s+style|bowling\s+style|age|dob|date\s+of\s+birth|birthday|nationality|country|shirt\s+number|jersey)[?!.]*$/i,
      // "Babar Azam batting style" — name followed directly by an attribute
      /^(.+?)\s+(?:batting\s+style|bowling\s+style|age|dob|date\s+of\s+birth|birthday|nationality|country|shirt\s+number|jersey)[?!.]*$/i,
    ];

    for (const pattern of playerDetailPatterns) {
      const match = state.question.match(pattern);
      if (match) {
        // Strip trailing attribute words and format words before validating the name
        const playerName = match[1]
          .trim()
          .replace(/[?!.]+$/, '')
          .replace(PLAYER_ATTR_SUFFIX, '')
          .replace(/\s+\b(odi|t20i?|test)\b.*$/i, '')
          .trim();
        if (!looksLikePlayerName(playerName)) continue;
        console.log(`=== RULE-BASED: player profile lookup for "${playerName}" ===`);
        state.generatedQuery = {
          collection: 'players',
          filter: {
            $or: [
              { short_name: { $regex: playerName, $options: 'i' } },
              { full_name: { $regex: playerName, $options: 'i' } },
            ],
          },
          limit: 5,
        };
        return;
      }
    }

    // ── Player career stats (runs/wickets/average) by name ───────────────────
    const FORMAT_SUFFIX = /\s+\b(odi|t20i?|test)\b.*$/i;

    const playerStatsPatterns = [
      /(?:how\s+many\s+(?:runs?|wickets?|centuries|fifties|matches?))\s+(?:did|has|have)\s+(.+?)\s+(?:score|take|play|make|get)/i,
      /(?:what\s+(?:is|are|was|were))\s+(.+?)'?s?\s+(?:batting|bowling|career|overall)?\s*(?:stats?|average|record|figures?)/i,
      /(.+?)\s+(?:odi|t20i?|test)\s+(?:career\s+)?(?:stats?|record|figures?|average|runs?|wickets?)/i,
      /(?:career\s+)?(?:stats?|record|figures?)\s+(?:of|for)\s+(.+?)(?:\s+in\s+(odi|t20i?|test))?/i,
      // "Rohit Sharma ODI" or "Rohit Sharma T20I stats" — name must start with capital
      /^([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){1,3})\s+(?:odi|t20i?|test)(?:\s+(?:stats?|record|figures?|average|runs?|wickets?))?[?!.]*$/i,
    ];

    for (const pattern of playerStatsPatterns) {
      const match = state.question.match(pattern);
      if (match) {
        // Strip trailing format words (ODI/T20I/Test) from the captured name
        const playerName = match[1].trim().replace(/[?!.]+$/, '').replace(FORMAT_SUFFIX, '').trim();
        if (!looksLikePlayerName(playerName)) continue;

        let format: string | null = null;
        const fmtMatch = state.question.match(/\b(odi|t20i?|test)\b/i);
        if (fmtMatch) {
          const f = fmtMatch[1].toUpperCase();
          format = f === 'T20' ? 'T20I' : f === 'TEST' ? 'Test' : f;
        }

        console.log(`=== RULE-BASED: player career stats for "${playerName}" format=${format} ===`);
        state.generatedQuery = {
          collection: 'players_yearly',
          _playerNameLookup: playerName,
          _format: format,
          pipeline: [
            { $match: { player_id: -1 } },
          ],
        };
        return;
      }
    }

    // ── Top run scorers / wicket takers ───────────────────────────────────────
    const topRunsPattern = /(?:top|most|highest|best|leading)\s+(?:\d+\s+)?(?:run\s+scorers?|batsmen?|batters?|runs?\s+(?:in|scored))/i;
    const topWicketsPattern = /(?:top|most|highest|best|leading)\s+(?:\d+\s+)?(?:wicket\s+takers?|bowlers?|wickets?\s+(?:in|taken))/i;

    const limitMatch = state.question.match(/\btop\s+(\d+)\b/i);
    const topN = limitMatch ? parseInt(limitMatch[1], 10) : 10;
    const fmtMatch2 = state.question.match(/\b(odi|t20i?|test)\b/i);
    let topFormat: string | null = null;
    if (fmtMatch2) {
      const f = fmtMatch2[1].toUpperCase();
      topFormat = f === 'T20' ? 'T20I' : f === 'TEST' ? 'Test' : f;
    }

    if (topRunsPattern.test(state.question)) {
      console.log(`=== RULE-BASED: top run scorers format=${topFormat} limit=${topN} ===`);
      const matchStage: any = { runs: { $gt: 0 } };
      if (topFormat) matchStage.format = topFormat;
      state.generatedQuery = {
        collection: 'players_yearly',
        pipeline: [
          { $match: matchStage },
          { $group: { _id: '$player_id', total_runs: { $sum: '$runs' } } },
          { $sort: { total_runs: -1 } },
          { $limit: topN },
        ],
      };
      return;
    }

    if (topWicketsPattern.test(state.question)) {
      console.log(`=== RULE-BASED: top wicket takers format=${topFormat} limit=${topN} ===`);
      const matchStage: any = { wickets: { $gt: 0 } };
      if (topFormat) matchStage.format = topFormat;
      state.generatedQuery = {
        collection: 'players_yearly',
        pipeline: [
          { $match: matchStage },
          { $group: { _id: '$player_id', total_wickets: { $sum: '$wickets' } } },
          { $sort: { total_wickets: -1 } },
          { $limit: topN },
        ],
      };
      return;
    }

    // ── Most wins by team ─────────────────────────────────────────────────────
    // Guard: skip if question specifies a venue (handled by mostWinsAtVenuePattern below)
    const hasVenueContext = /\b(?:at|in)\s+[A-Za-z]/i.test(state.question) &&
      /\b(?:lords?|wankhede|eden|melbourne|sydney|oval|headingley|edgbaston|trent|sharjah|dubai|karachi|lahore|chennai|delhi|mumbai|kolkata|bangalore|bengaluru|ahmedabad|johannesburg|cape\s*town|centurion|durban|christchurch|wellington|hamilton|hobart|brisbane|perth)\b/i.test(state.question);
    const mostWinsPattern = /(?:most\s+wins?|which\s+team\s+(?:has|have|won)\s+(?:the\s+)?most|team\s+with\s+(?:the\s+)?most\s+wins?)/i;
    if (mostWinsPattern.test(state.question) && !hasVenueContext) {
      const fmtM = state.question.match(/\b(odi|t20i?|test)\b/i);
      const fmt = fmtM ? (fmtM[1].toUpperCase() === 'T20' ? 'T20I' : fmtM[1].toUpperCase()) : null;
      const matchStage: any = { result: 'won' };
      if (fmt) matchStage.format = fmt;
      console.log(`=== RULE-BASED: most wins by team format=${fmt} ===`);
      state.generatedQuery = {
        collection: 'team_matches',
        pipeline: [
          { $match: matchStage },
          { $group: { _id: '$team', wins: { $sum: 1 } } },
          { $sort: { wins: -1 } },
          { $limit: 10 },
        ],
      };
      return;
    }

    // ── Total matches played by a team ────────────────────────────────────────
    const teamMatchCountPattern = /(?:how\s+many\s+matches?|total\s+matches?|number\s+of\s+matches?)\s+(?:has|have|did)?\s*([A-Za-z ]{3,30}?)\s+(?:played|play)/i;
    const teamMatchCountMatch = state.question.match(teamMatchCountPattern);
    if (teamMatchCountMatch) {
      const teamName = teamMatchCountMatch[1].trim().replace(/[?!.]+$/, '');
      if (isValidPlayerName(teamName)) {
        const fmtM = state.question.match(/\b(odi|t20i?|test)\b/i);
        const fmt = fmtM ? (fmtM[1].toUpperCase() === 'T20' ? 'T20I' : fmtM[1].toUpperCase()) : null;
        const matchStage: any = { team: { $regex: teamName, $options: 'i' } };
        if (fmt) matchStage.format = fmt;
        console.log(`=== RULE-BASED: total matches for team "${teamName}" format=${fmt} ===`);
        state.generatedQuery = {
          collection: 'team_matches',
          pipeline: [
            { $match: matchStage },
            { $count: 'total_matches_played' },
          ],
        };
        return;
      }
    }

    // ── Win/loss record for a team ────────────────────────────────────────────
    const teamRecordPattern = /(?:win(?:s|ning)?[\s/-]loss|record|results?)\s+(?:of|for)\s+([A-Za-z ]{3,30}?)(?:\s+in\s+(odi|t20i?|test))?/i;
    const teamRecordMatch = state.question.match(teamRecordPattern);
    if (teamRecordMatch) {
      const teamName = teamRecordMatch[1].trim().replace(/[?!.]+$/, '');
      const fmtRaw = teamRecordMatch[2];
      const fmt = fmtRaw ? (fmtRaw.toUpperCase() === 'T20' ? 'T20I' : fmtRaw.toUpperCase()) : null;
      if (isValidPlayerName(teamName)) {
        const matchStage: any = { team: { $regex: teamName, $options: 'i' } };
        if (fmt) matchStage.format = fmt;
        console.log(`=== RULE-BASED: win-loss record for team "${teamName}" format=${fmt} ===`);
        state.generatedQuery = {
          collection: 'team_matches',
          pipeline: [
            { $match: matchStage },
            {
              $group: {
                _id: '$result',
                count: { $sum: 1 },
              },
            },
            { $sort: { count: -1 } },
          ],
        };
        return;
      }
    }

    // ── Match list by format / year / venue ───────────────────────────────────
    const matchListPattern =
      /(?:show|list|find|get|display)(?:\s+me)?(?:\s+all)?\s+(odi|t20i?|test)\s+matches?(?:\s+(?:played\s+)?in\s+(\d{4}))?(?:\s+(?:at|in|played\s+at)\s+(.+))?/i;
    const matchListMatch = state.question.match(matchListPattern);
    if (matchListMatch) {
      const rawFormat = matchListMatch[1].toUpperCase();
      const format = rawFormat === 'T20' ? 'T20I' : rawFormat;
      const year = matchListMatch[2] ? parseInt(matchListMatch[2], 10) : null;
      const venue = matchListMatch[3]?.trim().replace(/[?!.]+$/, '') ?? null;

      const filter: any = { format };
      if (year) filter.year = year;
      if (venue) filter.venue = { $regex: this.normalizeVenueName(venue), $options: 'i' };

      console.log(`=== RULE-BASED: match list — format=${format} year=${year} venue=${venue} ===`);
      state.generatedQuery = {
        collection: 'team_matches',
        filter,
        sort: { date: -1 },
        limit: 20,
      };
      return;
    }

    // ── Matches at a venue with margin condition ──────────────────────────────
    const venueMarginPattern =
      /matches?\s+(?:played\s+)?(?:at|in)\s+([A-Za-z ()]+?)\s+(?:where|with|when)\s+.*?margin\s+(?:was\s+)?(?:greater\s+than|more\s+than|over|above|>)\s+(\d+)\s+runs?/i;
    const venueMarginMatch = state.question.match(venueMarginPattern);
    if (venueMarginMatch) {
      const rawVenue = venueMarginMatch[1].trim().replace(/[?!.]+$/, '');
      const threshold = parseInt(venueMarginMatch[2], 10);
      const venue = this.normalizeVenueName(rawVenue);
      console.log(`=== RULE-BASED: matches at venue "${rawVenue}" margin > ${threshold} runs ===`);
      state.generatedQuery = {
        collection: 'team_matches',
        pipeline: [
          {
            $match: {
              venue: { $regex: venue, $options: 'i' },
              margin: { $regex: 'runs', $options: 'i' },
            },
          },
          {
            $addFields: {
              margin_runs: {
                $convert: {
                  input: { $arrayElemAt: [{ $split: ['$margin', ' '] }, 0] },
                  to: 'int',
                  onError: 0,
                  onNull: 0,
                },
              },
            },
          },
          { $match: { margin_runs: { $gt: threshold } } },
          { $sort: { margin_runs: -1 } },
          { $limit: 20 },
        ],
      };
      return;
    }

    // ── Most wins / most matches at a venue ──────────────────────────────────
    const mostWinsAtVenuePattern =
      /(?:which\s+team|who)\s+(?:has|have)?\s*(?:won\s+the\s+most|most\s+wins?|most\s+matches?\s+won)\s+(?:matches?\s+)?(?:at|in)\s+([A-Za-z ()]+?)(?:\s+in\s+(odi|t20i?|test))?[?!.]*$/i;
    const mostWinsAtVenueMatch = state.question.match(mostWinsAtVenuePattern);
    if (mostWinsAtVenueMatch) {
      const rawVenue = mostWinsAtVenueMatch[1].trim().replace(/[?!.]+$/, '');
      const venue = this.normalizeVenueName(rawVenue);
      const fmtRaw = mostWinsAtVenueMatch[2];
      const fmt = fmtRaw ? (fmtRaw.toUpperCase() === 'T20' ? 'T20I' : fmtRaw.toUpperCase() === 'TEST' ? 'TEST' : fmtRaw.toUpperCase()) : null;
      const matchStage: any = { venue: { $regex: venue, $options: 'i' }, result: 'won' };
      if (fmt) matchStage.format = fmt;
      console.log(`=== RULE-BASED: most wins at venue "${rawVenue}" format=${fmt} ===`);
      state.generatedQuery = {
        collection: 'team_matches',
        pipeline: [
          { $match: matchStage },
          { $group: { _id: '$team', wins: { $sum: 1 } } },
          { $sort: { wins: -1 } },
          { $limit: 10 },
        ],
      };
      return;
    }

    // ── Most matches played at a venue ────────────────────────────────────────
    const mostMatchesAtVenuePattern =
      /(?:which\s+team|who)\s+(?:has|have)?\s*(?:played\s+the\s+most|most\s+matches?\s+played)\s+(?:matches?\s+)?(?:at|in)\s+([A-Za-z ()]+?)(?:\s+in\s+(odi|t20i?|test))?[?!.]*$/i;
    const mostMatchesAtVenueMatch = state.question.match(mostMatchesAtVenuePattern);
    if (mostMatchesAtVenueMatch) {
      const rawVenue = mostMatchesAtVenueMatch[1].trim().replace(/[?!.]+$/, '');
      const venue = this.normalizeVenueName(rawVenue);
      const fmtRaw = mostMatchesAtVenueMatch[2];
      const fmt = fmtRaw ? (fmtRaw.toUpperCase() === 'T20' ? 'T20I' : fmtRaw.toUpperCase() === 'TEST' ? 'TEST' : fmtRaw.toUpperCase()) : null;
      const matchStage: any = { venue: { $regex: venue, $options: 'i' } };
      if (fmt) matchStage.format = fmt;
      console.log(`=== RULE-BASED: most matches at venue "${rawVenue}" format=${fmt} ===`);
      state.generatedQuery = {
        collection: 'team_matches',
        pipeline: [
          { $match: matchStage },
          { $group: { _id: '$team', matches: { $sum: 1 } } },
          { $sort: { matches: -1 } },
          { $limit: 10 },
        ],
      };
      return;
    }

    // ── Matches at a venue ────────────────────────────────────────────────────
    // Guard: skip if the question is asking for aggregation (most/which team/who won)
    const isAggregationQuestion = /\b(?:most|which\s+team|who\s+(?:has|have|won)|highest|top|best|most\s+wins?)\b/i.test(state.question);
    const venuePattern = /matches?\s+(?:played\s+)?(?:at|in)\s+([A-Za-z ()]+?)(?:\s+(?:where|with|when|and|in\s+\d{4})|[?!.]|$)/i;
    const venueMatch = state.question.match(venuePattern);
    if (venueMatch && !isAggregationQuestion) {
      const rawVenue = venueMatch[1].trim().replace(/[?!.]+$/, '');
      const venue = this.normalizeVenueName(rawVenue);
      console.log(`=== RULE-BASED: matches at venue "${rawVenue}" → normalized: "${venue}" ===`);
      state.generatedQuery = {
        collection: 'team_matches',
        filter: { venue: { $regex: venue, $options: 'i' } },
        sort: { date: -1 },
        limit: 20,
      };
      return;
    }

    // ── Win after bowling first ───────────────────────────────────────────────
    const bowlFirstWinPattern =
      /(?:how\s+many\s+times?|count|number\s+of\s+times?)\s+.*(?:win|won|winning)\s+.*(?:bowl(?:ing)?\s+first|chose?\s+to\s+bowl|elect(?:ed)?\s+to\s+bowl)/i;
    const bowlFirstWinPattern2 =
      /(?:win|won|winning)\s+after\s+(?:choosing|electing|deciding)?\s*to\s+bowl/i;
    if (bowlFirstWinPattern.test(state.question) || bowlFirstWinPattern2.test(state.question)) {
      console.log(`=== RULE-BASED: win after bowling first ===`);
      state.generatedQuery = {
        collection: 'team_matches',
        pipeline: [
          { $match: { batting: '2nd', result: 'won' } },
          { $count: 'times_won_after_bowling_first' },
        ],
      };
      return;
    }

    // ── Win after batting first ───────────────────────────────────────────────
    const batFirstWinPattern =
      /(?:win|won|winning)\s+after\s+(?:choosing|electing|deciding)?\s*to\s+bat/i;
    const batFirstWinPattern2 =
      /(?:how\s+many\s+times?|count)\s+.*(?:win|won)\s+.*(?:bat(?:ting)?\s+first|chose?\s+to\s+bat)/i;
    if (batFirstWinPattern.test(state.question) || batFirstWinPattern2.test(state.question)) {
      console.log(`=== RULE-BASED: win after batting first ===`);
      state.generatedQuery = {
        collection: 'team_matches',
        pipeline: [
          { $match: { batting: '1st', result: 'won' } },
          { $count: 'times_won_after_batting_first' },
        ],
      };
      return;
    }

    // ── "ODI/Test/T20I [team] played with/against [team] in [year]" ───────────
    const teamPlayedWithPattern =
      /^(odi|t20i?|test)s?\s+([A-Za-z ]{2,30}?)\s+(?:played\s+(?:with|against)|vs\.?|versus|against)\s+([A-Za-z ]{2,30}?)(?:\s+in\s+(\d{4}))?[?!.]*$/i;
    const tpwMatch = state.question.match(teamPlayedWithPattern);
    if (tpwMatch) {
      const fmtRaw = tpwMatch[1].toUpperCase();
      const fmt = fmtRaw === 'T20' ? 'T20I' : fmtRaw;
      const team1 = tpwMatch[2].trim();
      const team2 = tpwMatch[3].trim();
      const year = tpwMatch[4] ? parseInt(tpwMatch[4], 10) : null;
      console.log(`=== RULE-BASED: format+team played with team — "${team1}" vs "${team2}" format=${fmt} year=${year} ===`);
      const andConditions: any[] = [
        {
          $or: [
            { team: { $regex: team1, $options: 'i' }, opponent: { $regex: team2, $options: 'i' } },
            { team: { $regex: team2, $options: 'i' }, opponent: { $regex: team1, $options: 'i' } },
          ],
        },
        { format: fmt },
      ];
      if (year) {
        // date is stored as ISO string "YYYY-MM-DD", so filter by string prefix
        andConditions.push({ date: { $regex: `^${year}-`, $options: 'i' } });
      }
      state.generatedQuery = {
        collection: 'team_matches',
        pipeline: [
          { $match: { $and: andConditions } },
          { $sort: { date: -1 } },
          { $limit: 20 },
        ],
      };
      return;
    }

    // ── Team vs Team ──────────────────────────────────────────────────────────
    const vsPattern = /^(?:find|show|list|get|display)?\s*(?:all\s+)?(?:matches?\s+(?:where|between)\s+)?([A-Za-z ]{2,30}?)\s+(?:vs\.?|versus|against)\s+([A-Za-z ]{2,30}?)(?:\s*[?!.]*)$/i;
    const vsMatch = state.question.match(vsPattern);
    if (vsMatch) {
      const team1 = vsMatch[1].trim();
      const team2 = vsMatch[2].trim();
      const nonTeamWords = /\b(?:bowl|bat|win|won|toss|first|second|1st|2nd|how|many|times?|count)\b/i;
      if (!nonTeamWords.test(team1) && !nonTeamWords.test(team2)) {
        console.log(`=== RULE-BASED: team vs team — "${team1}" vs "${team2}" ===`);
        state.generatedQuery = {
          collection: 'team_matches',
          filter: {
            $or: [
              {
                team: { $regex: team1, $options: 'i' },
                opponent: { $regex: team2, $options: 'i' },
              },
              {
                team: { $regex: team2, $options: 'i' },
                opponent: { $regex: team1, $options: 'i' },
              },
            ],
          },
          sort: { date: -1 },
          limit: 20,
        };
        return;
      }
    }

    // ── Player match-by-match performance against a specific opponent ─────────
    const playerVsOpponentPattern =
      /(?:how\s+did\s+|performance\s+of\s+|stats?\s+(?:of\s+)?)?([A-Za-z .'-]{3,35}?)\s+(?:perform(?:ance)?|stats?|record|figures?)?\s*(?:against|vs\.?|versus)\s+([A-Za-z ]{3,30}?)(?:\s+in\s+(odi|t20i?|test))?[?!.]*$/i;
    const pvoMatch = state.question.match(playerVsOpponentPattern);
    if (pvoMatch) {
      const playerName = pvoMatch[1].trim().replace(/[?!.]+$/, '');
      const opponent = pvoMatch[2].trim().replace(/[?!.]+$/, '');
      const fmtRaw = pvoMatch[3];
      const fmt = fmtRaw
        ? fmtRaw.toUpperCase() === 'T20' ? 'T20I' : fmtRaw.charAt(0).toUpperCase() + fmtRaw.slice(1).toLowerCase()
        : null;
      const genericOpponents = /^(?:a|the|this|that|team|player|match|game|cricket|all|any|every|which|what|who|how|when|where|why|india|pakistan|australia|england|newzealand|srilanka|bangladesh|westindies|southafrica|zimbabwe|afghanistan|ireland)$/i;
      const startsWithFormat = /^(odi|t20i?|test)\b/i;
      if (isValidPlayerName(playerName) && !genericOpponents.test(playerName) && !startsWithFormat.test(playerName)) {
        console.log(`=== RULE-BASED: player "${playerName}" vs opponent "${opponent}" format=${fmt} ===`);
        state.generatedQuery = {
          collection: 'players_matches',
          _playerNameLookup: playerName,
          _opponent: opponent,
          _format: fmt,
          pipeline: [{ $match: { player_id: -1 } }],
        };
        return;
      }
    }

    // ── Toss win → match win correlation ─────────────────────────────────────
    const tossWinMatchWinPattern =
      /(?:how\s+many\s+times?|count|number\s+of\s+times?).*toss.*(?:win|won).*(?:match|game).*(?:win|won)|toss\s+winner.*(?:win|won)|(?:win|won).*toss.*(?:win|won)\s+(?:the\s+)?match/i;
    const tossWinByTeamPattern =
      /(?:which\s+team|who).*(?:won\s+(?:the\s+)?toss.*won\s+(?:the\s+)?match|toss.*(?:win|won).*most)/i;

    if (tossWinByTeamPattern.test(state.question)) {
      // "which team won the toss and won the match most times?" → group by team
      const fmtM = state.question.match(/\b(odi|t20i?|test)\b/i);
      const fmt = fmtM ? (fmtM[1].toUpperCase() === 'T20' ? 'T20I' : fmtM[1].toUpperCase() === 'TEST' ? 'TEST' : fmtM[1].toUpperCase()) : null;
      const matchStage: any = { toss: 'won', result: 'won' };
      if (fmt) matchStage.format = fmt;
      console.log(`=== RULE-BASED: toss win → match win by team format=${fmt} ===`);
      state.generatedQuery = {
        collection: 'team_matches',
        pipeline: [
          { $match: matchStage },
          { $group: { _id: '$team', times: { $sum: 1 } } },
          { $sort: { times: -1 } },
          { $limit: 10 },
        ],
      };
      return;
    }

    if (tossWinMatchWinPattern.test(state.question)) {
      // "how many times did toss winner win the match?" → total count
      console.log(`=== RULE-BASED: toss win → match win (total count) ===`);
      state.generatedQuery = {
        collection: 'team_matches',
        pipeline: [
          { $match: { toss: 'won', result: 'won' } },
          { $count: 'times_toss_winner_won_match' },
        ],
      };
      return;
    }

    // ── Who has the highest individual score (player) ─────────────────────────
    const playerHighestScorePattern =
      /(?:who\s+(?:has|holds?|scored?|made?|hit)\s+(?:the\s+)?(?:highest|most|maximum|top|best)\s+(?:individual\s+)?(?:score|runs?|innings?))|(?:highest\s+(?:individual\s+)?(?:score|innings?)\s+(?:by\s+a\s+(?:player|batsman|batter)?))/i;
    if (playerHighestScorePattern.test(state.question)) {
      const fmtM = state.question.match(/\b(odi|t20i?|test)\b/i);
      const fmt = fmtM
        ? fmtM[1].toUpperCase() === 'T20' ? 'T20I'
          : fmtM[1].toUpperCase() === 'TEST' ? 'Test'
          : fmtM[1].toUpperCase()
        : null;
      const matchStage: any = { runs: { $gt: 0 } };
      if (fmt) matchStage.format = fmt;
      console.log(`=== RULE-BASED: player highest individual score format=${fmt} ===`);
      state.generatedQuery = {
        collection: 'players_yearly',
        pipeline: [
          { $match: matchStage },
          { $sort: { highest_score: -1 } },
          { $limit: 10 },
        ],
      };
      return;
    }

    // ── Highest team score ────────────────────────────────────────────────────
    const highestScorePattern =
      /(?:highest|biggest|maximum|largest)\s+(?:team\s+)?(?:score|total|innings)(?:\s+(?:in|ever|recorded))?(?:\s+in\s+(odi|t20i?|test))?/i;
    const hsMatch = state.question.match(highestScorePattern);
    if (hsMatch) {
      const fmtRaw = hsMatch[1];
      const fmt = fmtRaw ? (fmtRaw.toUpperCase() === 'T20' ? 'T20I' : fmtRaw.toUpperCase()) : null;
      const matchStage: any = { score: { $gt: 0 } };
      if (fmt) matchStage.format = fmt;
      console.log(`=== RULE-BASED: highest team score format=${fmt} ===`);
      state.generatedQuery = {
        collection: 'team_matches',
        pipeline: [
          { $match: matchStage },
          { $sort: { score: -1 } },
          { $limit: 10 },
        ],
      };
      return;
    }

    // ── Matches won by a specific team ────────────────────────────────────────
    const teamWinsPattern =
      /(?:how\s+many\s+(?:odi|t20i?|test)s?\s+(?:has|have|did)\s+([A-Za-z ]{3,25}?)\s+won?|([A-Za-z ]{3,25}?)\s+(?:odi|t20i?|test)\s+wins?)/i;
    const twMatch = state.question.match(teamWinsPattern);
    if (twMatch) {
      const teamName = (twMatch[1] ?? twMatch[2])?.trim().replace(/[?!.]+$/, '');
      const fmtM = state.question.match(/\b(odi|t20i?|test)\b/i);
      const fmt = fmtM ? (fmtM[1].toUpperCase() === 'T20' ? 'T20I' : fmtM[1].toUpperCase()) : null;
      if (teamName && isValidPlayerName(teamName)) {
        const matchStage: any = { team: { $regex: teamName, $options: 'i' }, result: 'won' };
        if (fmt) matchStage.format = fmt;
        console.log(`=== RULE-BASED: wins for team "${teamName}" format=${fmt} ===`);
        state.generatedQuery = {
          collection: 'team_matches',
          pipeline: [
            { $match: matchStage },
            { $count: 'total_wins' },
          ],
        };
        return;
      }
    }

    // ── Total / how many players (in a year / format) ────────────────────────
    const totalPlayersPattern =
      /(?:total|how\s+many|number\s+of|count\s+of?)\s+(?:unique\s+)?players?(?:\s+(?:in|during|for|played\s+in)\s+(\d{4}))?(?:\s+in\s+(odi|t20i?|test))?/i;
    const totalPlayersMatch = state.question.match(totalPlayersPattern);
    if (totalPlayersMatch) {
      const year = totalPlayersMatch[1] ? parseInt(totalPlayersMatch[1], 10) : null;
      const fmtRaw = totalPlayersMatch[2] ?? state.question.match(/\b(odi|t20i?|test)\b/i)?.[1];
      const fmt = fmtRaw
        ? fmtRaw.toUpperCase() === 'T20' ? 'T20I' : fmtRaw.charAt(0).toUpperCase() + fmtRaw.slice(1).toLowerCase()
        : null;

      const matchStage: any = {};
      if (year) matchStage.year = year;
      if (fmt) matchStage.format = fmt;

      console.log(`=== RULE-BASED: total players year=${year} format=${fmt} ===`);
      state.generatedQuery = {
        collection: 'players_yearly',
        pipeline: [
          ...(Object.keys(matchStage).length > 0 ? [{ $match: matchStage }] : []),
          { $group: { _id: '$player_id' } },
          { $count: 'total_players' },
        ],
      };
      return;
    }

    // ── Most centuries / fifties by a player ─────────────────────────────────
    const mostCenturiesPattern = /(?:most|highest|top)\s+(?:\d+\s+)?(?:centur(?:ies|y)|hundreds?)\s+(?:in\s+)?(odi|t20i?|test)?/i;
    const mostFiftiesPattern = /(?:most|highest|top)\s+(?:\d+\s+)?(?:fifties|half.?centur(?:ies|y))\s+(?:in\s+)?(odi|t20i?|test)?/i;

    if (mostCenturiesPattern.test(state.question)) {
      const fmtM = state.question.match(/\b(odi|t20i?|test)\b/i);
      const fmt = fmtM ? (fmtM[1].toUpperCase() === 'T20' ? 'T20I' : fmtM[1].toUpperCase() === 'TEST' ? 'Test' : fmtM[1].toUpperCase()) : null;
      const limitM = state.question.match(/\btop\s+(\d+)\b/i);
      const lim = limitM ? parseInt(limitM[1], 10) : 10;
      const matchStage: any = { hundreds: { $gt: 0 } };
      if (fmt) matchStage.format = fmt;
      console.log(`=== RULE-BASED: most centuries format=${fmt} ===`);
      state.generatedQuery = {
        collection: 'players_yearly',
        pipeline: [
          { $match: matchStage },
          { $group: { _id: '$player_id', total_hundreds: { $sum: '$hundreds' } } },
          { $sort: { total_hundreds: -1 } },
          { $limit: lim },
        ],
      };
      return;
    }

    if (mostFiftiesPattern.test(state.question)) {
      const fmtM = state.question.match(/\b(odi|t20i?|test)\b/i);
      const fmt = fmtM ? (fmtM[1].toUpperCase() === 'T20' ? 'T20I' : fmtM[1].charAt(0).toUpperCase() + fmtM[1].slice(1).toLowerCase()) : null;
      const limitM = state.question.match(/\btop\s+(\d+)\b/i);
      const lim = limitM ? parseInt(limitM[1], 10) : 10;
      const matchStage: any = { fifties: 1 };
      if (fmt) matchStage.format = fmt;
      console.log(`=== RULE-BASED: most fifties format=${fmt} ===`);
      state.generatedQuery = {
        collection: 'players_matches',
        pipeline: [
          { $match: matchStage },
          { $group: { _id: '$player_id', total_fifties: { $sum: '$fifties' } } },
          { $sort: { total_fifties: -1 } },
          { $limit: lim },
        ],
      };
      return;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // NODE: AI QUERY GENERATION
  // ─────────────────────────────────────────────────────────────────────────────

  private async generateQuery(state: WorkflowState) {
    const systemPrompt = `You are a MongoDB query generator for a cricket statistics database. You output ONLY raw JSON — no markdown, no code fences, no explanation, no text before or after. Your entire response must be a single valid JSON object.`;

    const userPrompt = `Generate a MongoDB query JSON for this cricket stats question.

IMPORTANT — FOLLOW-UP QUESTION HANDLING:
The question may be a follow-up to a previous conversation. The [Recent conversation] context shows what was discussed before.
- If the question uses pronouns ("he", "his", "she", "her", "they", "their") → replace with the player/team name from context
- If the question is short and vague ("how many centuries in ODI?", "what about T20?", "show me bowling stats") → use the player/team from the most recent conversation turn
- If the question asks about a specific attribute ("shirt number", "batting style", "age", "country") → query the "players" collection for the player from context
- Always extract the actual entity (player name, team name, format) from context before generating the query
- NEVER generate a query with a placeholder like "player_name" — always use the real name from context

COLLECTIONS:
1. "players": player_id, short_name, full_name, active, date_of_birth, format, country, shirt_number, batting_style, bowling_style, picture
   → Use ONLY for player profile/details/info/biography questions (not stats)
2. "players_yearly": player_id, year, format, matches, runs, highest_score, average, hundreds, wickets, best_bowling, bowl_avg, five_wicket_hauls, catches, stumpings, ave_diff
   → Use for player career stats, runs, wickets, averages aggregated by year
   → WARNING: wickets/runs/average may be empty string "" — always filter: {wickets:{$gt:0}} or {runs:{$gt:0}} when sorting/aggregating
3. "players_matches": player_id, date, format, opponent, venue, result, innings, not_out, runs_str, runs, balls, fours, sixes, strike_rate, ducks, overs, maidens, runs_conceded, wickets_bowling, economy, bowling_average, match_ref, year, team, fifties, centuries
   → Use for individual match performances, specific match stats
4. "team_matches": team, opponent, date, format, venue, result, margin, toss, batting, score, wickets, overs, run_rate
   → Use for team-level results, wins/losses, toss stats, match scores

CRITICAL FIELD VALUES (use EXACTLY these — wrong case = no results):
- team_matches.format: "ODI", "T20I", "TEST"
- team_matches.result: "won", "lost", "draw", "tied" (all lowercase)
- team_matches.toss: "won", "lost" (all lowercase)
- team_matches.batting: "1st", "2nd"
- players_matches.result: "Won", "Lost", "Draw", "Tied", "N/R" (capital first letter)
- players_matches.format: "ODI", "T20I", "Test"
- players_yearly.format: "ODI", "T20I", "Test"

RULES:
- player profile/bio/info → "players" collection, $regex on short_name or full_name
- player career stats (runs, wickets, average, centuries) → "players_yearly" collection
- player match-by-match performance → "players_matches" collection
- team match stats (wins, results, toss, scores) → "team_matches" collection
- always include limit (max 20 for match lists, 10 for stats)
- year filter: use integer field "year" (e.g. year: 2023)
- venue filter: use SHORT names only — "Lords" not "Lord's Cricket Ground", "Melbourne" not "Melbourne Cricket Ground", "Birmingham" not "Edgbaston", "Manchester" not "Old Trafford", "Leeds" not "Headingley", "Nottingham" not "Trent Bridge", "Chennai" not "Chepauk", "Delhi" not "Feroz Shah Kotla"
- margin field is a STRING like "150 runs" or "6 wickets" — NEVER use $gt/$lt directly. Use pipeline: $match margin contains "runs", $addFields to extract numeric part, then $match on numeric field
- when sorting players_yearly by wickets/runs/average, ALWAYS add $match to exclude empty strings: {wickets:{$gt:0}} or {runs:{$gt:0}}
- for player stats by name: use players_yearly with player_id lookup — but since cross-collection joins aren't supported in simple queries, use players_yearly with a $match on player_id if you know it, otherwise use players collection

AGGREGATION RULES:
- "how many times" / "count" / "number of times" → pipeline with $count or $group
- "win after bowling first" → batting:"2nd", result:"won" → $count
- "win after batting first" → batting:"1st", result:"won" → $count
- "toss won and won match" → toss:"won", result:"won" → $count
- "most wins" by team → $group by team, $sum where result=="won", $sort, $limit
- "top wicket takers" → players_yearly, $match {wickets:{$gt:0}}, $group sum wickets, $sort desc
- "top run scorers" → players_yearly, $match {runs:{$gt:0}}, $group sum runs, $sort desc
- "how many matches did [team] play" → team_matches, $match team, $count
- "win/loss record of [team]" → team_matches, $match team, $group by result, $sum 1

EXAMPLES:
{"collection":"team_matches","filter":{"format":"ODI","year":2023},"sort":{"date":-1},"limit":20}
{"collection":"team_matches","filter":{"format":"TEST"},"sort":{"date":-1},"limit":20}
{"collection":"team_matches","filter":{"$or":[{"team":{"$regex":"Pakistan","$options":"i"},"opponent":{"$regex":"Australia","$options":"i"}},{"team":{"$regex":"Australia","$options":"i"},"opponent":{"$regex":"Pakistan","$options":"i"}}]},"sort":{"date":-1},"limit":20}
{"collection":"players","filter":{"$or":[{"short_name":{"$regex":"Babar","$options":"i"}},{"full_name":{"$regex":"Babar","$options":"i"}}]},"limit":5}
{"collection":"team_matches","pipeline":[{"$match":{"batting":"2nd","result":"won"}},{"$count":"times_won_after_bowling_first"}]}
{"collection":"team_matches","pipeline":[{"$match":{"batting":"1st","result":"won"}},{"$count":"times_won_after_batting_first"}]}
{"collection":"team_matches","pipeline":[{"$group":{"_id":"$team","wins":{"$sum":{"$cond":[{"$eq":["$result","won"]},1,0]}}}},{"$sort":{"wins":-1}},{"$limit":10}]}
{"collection":"players_yearly","pipeline":[{"$match":{"format":"ODI","wickets":{"$gt":0}}},{"$group":{"_id":"$player_id","total_wickets":{"$sum":"$wickets"}}},{"$sort":{"total_wickets":-1}},{"$limit":10}]}
{"collection":"players_yearly","pipeline":[{"$match":{"format":"T20I","runs":{"$gt":0}}},{"$group":{"_id":"$player_id","total_runs":{"$sum":"$runs"}}},{"$sort":{"total_runs":-1}},{"$limit":10}]}
{"collection":"team_matches","pipeline":[{"$match":{"team":{"$regex":"India","$options":"i"}}},{"$count":"total_matches_played"}]}
{"collection":"team_matches","pipeline":[{"$match":{"team":{"$regex":"India","$options":"i"}}},{"$group":{"_id":"$result","count":{"$sum":1}}},{"$sort":{"count":-1}}]}
{"collection":"team_matches","pipeline":[{"$match":{"venue":{"$regex":"Sharjah","$options":"i"},"margin":{"$regex":"runs","$options":"i"}}},{"$addFields":{"margin_runs":{"$convert":{"input":{"$arrayElemAt":[{"$split":["$margin"," "]},0]},"to":"int","onError":0,"onNull":0}}}},{"$match":{"margin_runs":{"$gt":100}}},{"$sort":{"margin_runs":-1}},{"$limit":20}]}

PLAYER STATS BY NAME — CRITICAL:
players_yearly and players_matches do NOT have short_name/full_name — only player_id (a number).
When asked for a specific player's stats by name, use short_name $regex filter on players_yearly.
The system will automatically look up the player_id and re-query. Always use the player's name from context.
{"collection":"players_yearly","filter":{"short_name":{"$regex":"Babar Azam","$options":"i"},"format":"ODI"},"sort":{"year":-1},"limit":20}
{"collection":"players_yearly","filter":{"short_name":{"$regex":"Virat Kohli","$options":"i"}},"sort":{"year":-1},"limit":20}
{"collection":"players_matches","filter":{"short_name":{"$regex":"Rohit Sharma","$options":"i"},"format":"Test"},"sort":{"date":-1},"limit":20}

Question: "${state.enrichedQuestion ?? state.question}"`;

    try {
      const response = await this.callAI(userPrompt, GROQ_MODEL_CHAIN[0], systemPrompt);
      console.log('=== RAW QUERY RESPONSE ===');
      console.log(response);

      const stripped = response
        .replace(/```(?:json)?\s*/gi, '')
        .replace(/```/g, '')
        .trim();

      const jsonStr = this.extractFirstJsonObject(stripped);

      if (!jsonStr) {
        console.error('No valid JSON object found in response:', stripped);
        state.error = 'No JSON found in AI response';
        return;
      }

      console.log('=== PARSED JSON STRING ===');
      console.log(jsonStr);

      state.generatedQuery = JSON.parse(jsonStr);
      console.log('=== GENERATED QUERY ===');
      console.log(JSON.stringify(state.generatedQuery, null, 2));
    } catch (error) {
      console.error('=== GENERATE QUERY ERROR ===');
      console.error('Message:', error.message);
      state.error = error.message;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // NODE: EXECUTE QUERY
  // ─────────────────────────────────────────────────────────────────────────────

  private async executeQuery(state: WorkflowState) {
    try {
      const db = this.databaseService.getDb();

      if (state.generatedQuery._playerNameLookup) {
        const playerName = state.generatedQuery._playerNameLookup;
        const format = state.generatedQuery._format;
        const opponent = state.generatedQuery._opponent;

        // Safety check — if the name is generic/invalid, bail out early with a helpful message
        const INVALID_PLAYER_PHRASES = /^(total|how many|number of|count|all|every|any|list|show|find|get|display)\b/i;
        if (!isValidPlayerName(playerName) || INVALID_PLAYER_PHRASES.test(playerName)) {
          state.formattedAnswer = `I wasn't able to identify a specific player name in your question. Please mention a player by name, for example: "What are Virat Kohli's ODI stats?"`;
          state.answerType = 'text';
          state.queryResults = [];
          return;
        }

        const playerDoc = await db.collection('players').findOne({
          $or: [
            { short_name: { $regex: playerName, $options: 'i' } },
            { full_name: { $regex: playerName, $options: 'i' } },
          ],
        });

        if (!playerDoc) {
          state.formattedAnswer = `No player named "${playerName}" was found in the dataset. The dataset covers international cricketers tracked by ESPN Cricinfo. Please check the spelling or try a different name.`;
          state.answerType = 'text';
          state.queryResults = [];
          return;
        }

        const playerId = playerDoc.player_id;

        if (opponent) {
          const matchStage: any = {
            player_id: playerId,
            opponent: { $regex: opponent, $options: 'i' },
          };
          if (format) matchStage.format = format;

          state.queryResults = await db
            .collection('players_matches')
            .find(matchStage)
            .sort({ date: -1 })
            .limit(20)
            .toArray();

          for (const row of state.queryResults) {
            row.player_name = playerDoc.full_name || playerDoc.short_name;
            row.player_country = playerDoc.country;
          }

          if (state.queryResults.length === 0) {
            state.formattedAnswer = `Found player "${playerDoc.full_name || playerDoc.short_name}" but no match records against "${opponent}"${format ? ` in ${format}` : ''} are available in the dataset.`;
            state.answerType = 'text';
          }
          return;
        }

        const matchStage: any = { player_id: playerId };
        if (format) matchStage.format = format;

        state.queryResults = await db
          .collection('players_yearly')
          .find(matchStage)
          .sort({ year: -1 })
          .toArray();

        for (const row of state.queryResults) {
          row.player_name = playerDoc.full_name || playerDoc.short_name;
          row.player_country = playerDoc.country;
        }

        if (state.queryResults.length === 0) {
          state.formattedAnswer = `Found player "${playerDoc.full_name || playerDoc.short_name}" but no career statistics are available${format ? ` for ${format}` : ''} in the dataset.`;
          state.answerType = 'text';
        }
        return;
      }

      this.normalizeQuery(state.generatedQuery);

      // ── Intercept AI-generated name-based queries on players_yearly/players_matches ──
      // The AI sometimes generates filters with short_name/full_name on these collections
      // which don't have those fields. Detect and redirect to the _playerNameLookup path.
      const col = state.generatedQuery.collection;
      if (col === 'players_yearly' || col === 'players_matches') {
        const nameFromFilter = this.extractNameFromQuery(state.generatedQuery);
        if (nameFromFilter) {
          console.log(`=== INTERCEPTED: AI used name filter on ${col}, redirecting to player lookup for "${nameFromFilter}" ===`);
          state.generatedQuery._playerNameLookup = nameFromFilter;
          // Extract format if present
          const fmt = this.extractFormatFromQuery(state.generatedQuery);
          if (fmt) state.generatedQuery._format = fmt;
          // Extract opponent if present
          const opp = this.extractOpponentFromQuery(state.generatedQuery);
          if (opp) state.generatedQuery._opponent = opp;
          // Re-run through the _playerNameLookup path by recursing into executeQuery
          await this.executeQuery(state);
          return;
        }
      }

      const {
        collection: collectionName,
        pipeline,
        filter = {},
        sort = {},
        limit = 0,
        projection = {},
      } = state.generatedQuery;

      const collection = db.collection(collectionName);
      const totalDocs = await collection.countDocuments({});
      console.log('Collection:', collectionName, '| Total docs:', totalDocs);
      console.log('Generated query:', JSON.stringify(state.generatedQuery, null, 2));

      if (totalDocs === 0) {
        console.warn(`⚠️  Collection "${collectionName}" is empty — data may not be imported yet.`);
        state.formattedAnswer = `The "${collectionName}" collection has no data. Please run the data import script first.`;
        state.answerType = 'text';
        state.queryResults = [];
        return;
      }

      if (pipeline && Array.isArray(pipeline)) {
        console.log('Using aggregation pipeline');
        state.queryResults = await collection.aggregate(pipeline).toArray();
      } else {
        let cursor = collection.find(filter);
        if (Object.keys(projection).length > 0) cursor = cursor.project(projection);
        if (Object.keys(sort).length > 0) cursor = cursor.sort(sort);
        if (limit > 0) cursor = cursor.limit(limit);
        state.queryResults = await cursor.toArray();
      }

      console.log('Query returned', state.queryResults.length, 'results');

      if (collectionName !== 'players') {
        await this.enrichWithPlayerNames(state);
      }
    } catch (error) {
      console.error('executeQuery error:', error.message);
      state.error = error.message;
      state.queryResults = [];
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // HELPER: NORMALIZE VENUE NAME
  // ─────────────────────────────────────────────────────────────────────────────

  private normalizeVenueName(venue: string): string {
    const ALIAS_MAP: Record<string, string> = {
      "lord's":           'Lords',
      "lords cricket ground": 'Lords',
      "lord's cricket ground": 'Lords',
      'wankhede stadium': 'Wankhede',
      'eden gardens':     'Eden Gardens',
      'melbourne cricket ground': 'Melbourne',
      'mcg':              'Melbourne',
      'sydney cricket ground': 'Sydney',
      'scg':              'Sydney',
      'the oval':         'The Oval',
      'oval':             'The Oval',
      'headingley':       'Leeds',
      'old trafford':     'Manchester',
      'edgbaston':        'Birmingham',
      'trent bridge':     'Nottingham',
      'sharjah cricket stadium': 'Sharjah',
      'sharjah cricket association stadium': 'Sharjah',
      'dubai international cricket stadium': 'Dubai (DICS)',
      'national stadium karachi': 'Karachi',
      'gaddafi stadium':  'Lahore',
      'iqbal stadium':    'Faisalabad',
      'rawalpindi cricket stadium': 'Rawalpindi',
      'ma chidambaram stadium': 'Chennai',
      'chepauk':          'Chennai',
      'chinnaswamy':      'Bengaluru',
      'm chinnaswamy stadium': 'Bengaluru',
      'feroz shah kotla': 'Delhi',
      'arun jaitley stadium': 'Delhi',
      'narendra modi stadium': 'Ahmedabad',
      'motera':           'Ahmedabad',
      'wanderers':        'Johannesburg',
      'newlands':         'Cape Town',
      'supersport park':  'Centurion',
      'kingsmead':        'Durban',
      'hagley oval':      'Christchurch',
      'basin reserve':    'Wellington',
      'seddon park':      'Hamilton',
      'bellerive oval':   'Hobart',
      'gabba':            'Brisbane',
      'waca':             'W.A.C.A',
      'optus stadium':    'Perth',
    };

    const lower = venue.toLowerCase().trim();
    if (ALIAS_MAP[lower]) return ALIAS_MAP[lower];

    const stripped = venue
      .replace(/\s+(cricket\s+)?(ground|stadium|oval|park|arena|field|centre|center)$/i, '')
      .replace(/\s+(international|national|association)$/i, '')
      .trim();

    return stripped || venue;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // HELPER: NORMALIZE QUERY
  // ─────────────────────────────────────────────────────────────────────────────
  // HELPERS: EXTRACT FIELDS FROM AI-GENERATED QUERY
  // ─────────────────────────────────────────────────────────────────────────────

  /** Extracts a player name from short_name/$regex or full_name/$regex filters */
  private extractNameFromQuery(query: any): string | null {
    const searchIn = (obj: any): string | null => {
      if (!obj || typeof obj !== 'object') return null;
      // Direct regex on name fields
      for (const nameField of ['short_name', 'full_name', 'player_name', 'name']) {
        if (obj[nameField]?.$regex) return obj[nameField].$regex;
        if (typeof obj[nameField] === 'string') return obj[nameField];
      }
      // $or array
      if (Array.isArray(obj.$or)) {
        for (const clause of obj.$or) {
          const found = searchIn(clause);
          if (found) return found;
        }
      }
      return null;
    };

    // Check filter
    if (query.filter) {
      const found = searchIn(query.filter);
      if (found) return found;
    }
    // Check pipeline $match stages
    if (Array.isArray(query.pipeline)) {
      for (const stage of query.pipeline) {
        if (stage.$match) {
          const found = searchIn(stage.$match);
          if (found) return found;
        }
      }
    }
    return null;
  }

  /** Extracts format value from query filter or pipeline */
  private extractFormatFromQuery(query: any): string | null {
    if (query.filter?.format) return query.filter.format;
    if (Array.isArray(query.pipeline)) {
      for (const stage of query.pipeline) {
        if (stage.$match?.format) return stage.$match.format;
      }
    }
    return null;
  }

  /** Extracts opponent value from query filter or pipeline */
  private extractOpponentFromQuery(query: any): string | null {
    const searchIn = (obj: any): string | null => {
      if (!obj || typeof obj !== 'object') return null;
      if (obj.opponent?.$regex) return obj.opponent.$regex;
      if (typeof obj.opponent === 'string') return obj.opponent;
      return null;
    };
    if (query.filter) {
      const found = searchIn(query.filter);
      if (found) return found;
    }
    if (Array.isArray(query.pipeline)) {
      for (const stage of query.pipeline) {
        if (stage.$match) {
          const found = searchIn(stage.$match);
          if (found) return found;
        }
      }
    }
    return null;
  }

  // ─────────────────────────────────────────────────────────────────────────────

  private normalizeQuery(query: any): void {
    if (!query) return;
    const col = query.collection;

    const fixFormat = (obj: any) => {
      if (!obj || typeof obj !== 'object') return;
      if (obj.format !== undefined) {
        const f = String(obj.format);
        if (col === 'team_matches') {
          if (f.toLowerCase() === 'test') obj.format = 'TEST';
          else if (f.toLowerCase() === 't20i' || f.toLowerCase() === 't20') obj.format = 'T20I';
          else if (f.toLowerCase() === 'odi') obj.format = 'ODI';
        } else {
          if (f.toUpperCase() === 'TEST') obj.format = 'Test';
          else if (f.toLowerCase() === 't20i' || f.toLowerCase() === 't20') obj.format = 'T20I';
          else if (f.toLowerCase() === 'odi') obj.format = 'ODI';
        }
      }
      for (const key of Object.keys(obj)) {
        if (key === 'format') continue;
        if (Array.isArray(obj[key])) obj[key].forEach((item: any) => fixFormat(item));
        else if (typeof obj[key] === 'object') fixFormat(obj[key]);
      }
    };

    const fixResult = (obj: any) => {
      if (!obj || typeof obj !== 'object') return;
      if (obj.result !== undefined && col === 'team_matches') {
        const r = String(obj.result);
        obj.result = r.toLowerCase();
      }
      for (const key of Object.keys(obj)) {
        if (key === 'result') continue;
        if (Array.isArray(obj[key])) obj[key].forEach((item: any) => fixResult(item));
        else if (typeof obj[key] === 'object') fixResult(obj[key]);
      }
    };

    const fixVenue = (obj: any) => {
      if (!obj || typeof obj !== 'object') return;
      if (obj.venue !== undefined && typeof obj.venue === 'string') {
        obj.venue = { $regex: this.normalizeVenueName(obj.venue), $options: 'i' };
      } else if (obj.venue?.$regex) {
        obj.venue.$regex = this.normalizeVenueName(obj.venue.$regex);
      }
      for (const key of Object.keys(obj)) {
        if (key === 'venue') continue;
        if (Array.isArray(obj[key])) obj[key].forEach((item: any) => fixVenue(item));
        else if (typeof obj[key] === 'object') fixVenue(obj[key]);
      }
    };

    if (query.filter) {
      fixFormat(query.filter);
      fixResult(query.filter);
      fixVenue(query.filter);
    }
    if (query.pipeline && Array.isArray(query.pipeline)) {
      query.pipeline.forEach((stage: any) => {
        fixFormat(stage);
        fixResult(stage);
        fixVenue(stage);
        if (stage.$match) {
          fixFormat(stage.$match);
          fixResult(stage.$match);
          fixVenue(stage.$match);
        }
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // HELPER: ENRICH RESULTS WITH PLAYER NAMES
  // ─────────────────────────────────────────────────────────────────────────────

  private async enrichWithPlayerNames(state: WorkflowState) {
    if (!state.queryResults || state.queryResults.length === 0) return;

    const playerIds = new Set<number>();
    for (const row of state.queryResults) {
      const id = row.player_id ?? (typeof row._id === 'number' ? row._id : undefined);
      if (id !== undefined && id !== null && !isNaN(Number(id))) {
        playerIds.add(Number(id));
      }
    }
    if (playerIds.size === 0) return;

    const db = this.databaseService.getDb();
    const playerDocs = await db
      .collection('players')
      .find({ player_id: { $in: Array.from(playerIds) } })
      .project({ player_id: 1, full_name: 1, short_name: 1, country: 1 })
      .toArray();

    const nameMap = new Map<number, { full_name: string; short_name: string; country: string }>();
    for (const p of playerDocs) {
      nameMap.set(Number(p.player_id), {
        full_name: p.full_name || p.short_name || String(p.player_id),
        short_name: p.short_name || p.full_name || String(p.player_id),
        country: p.country || '',
      });
    }

    for (const row of state.queryResults) {
      const id = Number(row.player_id ?? (typeof row._id === 'number' ? row._id : undefined));
      const info = nameMap.get(id);
      if (info) {
        row.player_name = info.full_name;
        row.player_country = info.country;
      }
    }

    console.log(`Enriched ${nameMap.size} player names`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // NODE: FORMAT ANSWER
  // ─────────────────────────────────────────────────────────────────────────────

  private async formatAnswer(state: WorkflowState) {
    if (!state.queryResults || state.queryResults.length === 0) {
      state.formattedAnswer = this.buildNoResultsMessage(state);
      state.answerType = 'text';
      return;
    }

    if (state.generatedQuery?.collection === 'players') {
      // Check if the question asks for a specific field — return a direct answer
      const specificAnswer = this.extractSpecificPlayerField(state.queryResults[0], state.question);
      if (specificAnswer) {
        state.formattedAnswer = specificAnswer;
        state.answerType = 'text';
        return;
      }
      state.formattedAnswer = this.buildPlayerProfileTable(state.queryResults);
      state.answerType = 'table';
      return;
    }

    if (state.generatedQuery?._playerNameLookup !== undefined && state.queryResults.length > 0) {
      if (state.generatedQuery?._opponent) {
        state.formattedAnswer = this.buildPlayerMatchTable(state.queryResults, state.question);
      } else {
        state.formattedAnswer = this.buildPlayerStatsTable(state.queryResults, state.question);
      }
      state.answerType = 'table';
      return;
    }

    if (
      state.queryResults.length === 1 &&
      state.generatedQuery?.pipeline
    ) {
      const doc = state.queryResults[0];
      const keys = Object.keys(doc).filter(k => k !== '_id');
      if (keys.length === 1 && typeof doc[keys[0]] === 'number') {
        const count = doc[keys[0]];
        const label = keys[0].replace(/_/g, ' ');
        state.formattedAnswer = `**${count}** — ${label}.`;
        state.answerType = 'text';
        return;
      }
    }

    if (
      state.generatedQuery?.pipeline &&
      state.queryResults.length > 0 &&
      state.queryResults[0]?._id !== undefined &&
      state.queryResults[0]?.count !== undefined
    ) {
      const lines = state.queryResults
        .map((r: any) => `**${r._id}**: ${r.count}`)
        .join(' | ');
      state.formattedAnswer = lines;
      state.answerType = 'text';
      return;
    }

    const isRanking = this.isRankingQuestion(state.question);

    if (isRanking || state.queryResults.length > 1) {
      state.formattedAnswer = this.buildMarkdownTable(state.queryResults, state.question);
      state.answerType = 'table';
    } else {
      const resultsJson = JSON.stringify(state.queryResults, null, 2);
      const prompt = `Write a single concise sentence answering this cricket question using the data provided.

Question: "${state.question}"
Data: ${resultsJson}

Rules:
- Use "player_name" field for the player's name if available, otherwise use player_id
- Use "player_country" if available
- Be factual and concise — one sentence only
- Do NOT use markdown

Answer:`;

      try {
        const response = await this.callAI(prompt, 'llama-3.1-8b-instant');
        state.formattedAnswer = response.trim();
        state.answerType = 'text';
      } catch {
        state.formattedAnswer = this.buildMarkdownTable(state.queryResults, state.question);
        state.answerType = 'table';
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // HELPER: EXTRACT SPECIFIC PLAYER FIELD FOR DIRECT ANSWERS
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * When the user asks about a specific attribute (shirt number, batting style,
   * age, country, etc.), return a direct one-line answer instead of the full table.
   * Returns null if the question is a general profile/info request.
   */
  private extractSpecificPlayerField(player: any, question: string): string | null {
    if (!player) return null;

    const q = question.toLowerCase();
    const name = player.full_name || player.short_name || 'The player';

    // Map of question keywords → player document fields
    const fieldMap: Array<{ keywords: string[]; field: string; label: string }> = [
      { keywords: ['shirt number', 'jersey number', 'jersey', 'shirt no', 'shirt #'], field: 'shirt_number', label: 'shirt number' },
      { keywords: ['batting style', 'how does he bat', 'how does she bat', 'bat style'], field: 'batting_style', label: 'batting style' },
      { keywords: ['bowling style', 'how does he bowl', 'how does she bowl', 'bowl style'], field: 'bowling_style', label: 'bowling style' },
      { keywords: ['date of birth', 'dob', 'birthday', 'born', 'birth date'], field: 'date_of_birth', label: 'date of birth' },
      { keywords: ['age', 'how old'], field: 'date_of_birth', label: 'age' },
      { keywords: ['country', 'nationality', 'nation', 'from which country', 'which country'], field: 'country', label: 'country' },
      { keywords: ['active', 'still playing', 'retired', 'is he playing'], field: 'active', label: 'active status' },
      { keywords: ['full name', 'real name', 'complete name'], field: 'full_name', label: 'full name' },
    ];

    for (const { keywords, field, label } of fieldMap) {
      if (keywords.some(kw => q.includes(kw))) {
        const value = player[field];
        if (value === undefined || value === null || value === '') {
          return `${name}'s ${label} is not available in the dataset.`;
        }

        // Special handling for age calculation
        if (label === 'age' && field === 'date_of_birth') {
          try {
            const dob = new Date(value);
            const today = new Date();
            const age = today.getFullYear() - dob.getFullYear() -
              (today < new Date(today.getFullYear(), dob.getMonth(), dob.getDate()) ? 1 : 0);
            return `**${name}** is **${age} years old** (born ${value}).`;
          } catch {
            return `**${name}**'s date of birth is **${value}**.`;
          }
        }

        return `**${name}**'s ${label} is **${value}**.`;
      }
    }

    // If the question is a general "tell me about" / "profile" / "info" → return null (show full table)
    const isGeneralProfile = /\b(profile|details?|info(?:rmation)?|tell me about|who is|biography|bio)\b/i.test(q);
    if (isGeneralProfile) return null;

    // If the question only mentions the player name with no specific field → full table
    return null;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // HELPER: BUILD PLAYER PROFILE TABLE
  // ─────────────────────────────────────────────────────────────────────────────

  private buildPlayerProfileTable(results: any[]): string {
    const lines: string[] = [];
    for (const p of results) {
      lines.push(`| Field | Value |`);
      lines.push(`| --- | --- |`);
      if (p.full_name || p.short_name) lines.push(`| Name | ${p.full_name ?? p.short_name} |`);
      if (p.country) lines.push(`| Country | ${p.country} |`);
      if (p.date_of_birth) lines.push(`| Date of Birth | ${p.date_of_birth} |`);
      if (p.format && p.format !== 'Unknown') lines.push(`| Role/Format | ${p.format} |`);
      if (p.batting_style) lines.push(`| Batting Style | ${p.batting_style} |`);
      if (p.bowling_style) lines.push(`| Bowling Style | ${p.bowling_style} |`);
      if (p.shirt_number) lines.push(`| Shirt Number | ${p.shirt_number} |`);
      if (p.player_id) lines.push(`| Player ID | ${p.player_id} |`);
      if (results.length > 1) lines.push(`| | |`);
    }
    return lines.join('\n');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // HELPER: BUILD PLAYER CAREER STATS TABLE
  // ─────────────────────────────────────────────────────────────────────────────

  private buildPlayerStatsTable(results: any[], question: string): string {
    if (results.length === 0) return 'No statistics found.';

    const playerName = results[0]?.player_name ?? 'Player';
    const country = results[0]?.player_country ? ` (${results[0].player_country})` : '';

    // Helper: check if a field has any real value across all rows
    const hasData = (field: string): boolean =>
      results.some(r => r[field] !== undefined && r[field] !== null && r[field] !== '' && r[field] !== 0 && r[field] !== '0');

    // Always-present columns
    type Col = { header: string; getValue: (r: any) => string };
    const cols: Col[] = [
      { header: 'Year',   getValue: r => String(r.year ?? '-') },
      { header: 'Format', getValue: r => String(r.format ?? '-') },
      { header: 'M',      getValue: r => r.matches !== undefined && r.matches !== '' ? String(r.matches) : '-' },
    ];

    // Batting columns — only if any row has data
    if (hasData('runs'))          cols.push({ header: 'Runs',    getValue: r => r.runs !== '' && r.runs !== undefined ? String(r.runs) : '-' });
    if (hasData('highest_score')) cols.push({ header: 'HS',      getValue: r => r.highest_score || '-' });
    if (hasData('average'))       cols.push({ header: 'Avg',     getValue: r => r.average !== '' && r.average !== undefined ? String(r.average) : '-' });
    if (hasData('hundreds'))      cols.push({ header: '100s',    getValue: r => r.hundreds !== '' && r.hundreds !== undefined ? String(r.hundreds) : '-' });

    // Bowling columns — only if any row has data
    if (hasData('wickets'))           cols.push({ header: 'Wkts',    getValue: r => r.wickets !== '' && r.wickets !== undefined ? String(r.wickets) : '-' });
    if (hasData('best_bowling'))      cols.push({ header: 'Best',    getValue: r => r.best_bowling || '-' });
    if (hasData('bowl_avg'))          cols.push({ header: 'BowlAvg', getValue: r => r.bowl_avg !== '' && r.bowl_avg !== undefined ? String(r.bowl_avg) : '-' });
    if (hasData('five_wicket_hauls')) cols.push({ header: '5W',      getValue: r => r.five_wicket_hauls !== '' && r.five_wicket_hauls !== undefined ? String(r.five_wicket_hauls) : '-' });

    // Fielding columns — only if any row has data
    if (hasData('catches'))   cols.push({ header: 'Ct', getValue: r => r.catches !== '' && r.catches !== undefined ? String(r.catches) : '-' });
    if (hasData('stumpings')) cols.push({ header: 'St', getValue: r => r.stumpings !== '' && r.stumpings !== undefined ? String(r.stumpings) : '-' });

    const lines: string[] = [];
    lines.push(`**${playerName}${country} — Career Statistics**\n`);
    lines.push(`| ${cols.map(c => c.header).join(' | ')} |`);
    lines.push(`| ${cols.map(() => '---').join(' | ')} |`);

    let totalRuns = 0, totalWkts = 0, totalMatches = 0, totalHundreds = 0;

    for (const r of results) {
      lines.push(`| ${cols.map(c => c.getValue(r)).join(' | ')} |`);
      if (typeof r.matches === 'number') totalMatches += r.matches;
      if (typeof r.runs === 'number') totalRuns += r.runs;
      if (typeof r.hundreds === 'number') totalHundreds += r.hundreds;
      if (typeof r.wickets === 'number') totalWkts += r.wickets;
    }

    const summaryParts: string[] = [`Total matches: **${totalMatches}**`];
    if (totalRuns > 0)   summaryParts.push(`runs: **${totalRuns}**`, `centuries: **${totalHundreds}**`);
    if (totalWkts > 0)   summaryParts.push(`wickets: **${totalWkts}**`);
    lines.push(`\n${summaryParts.join(' | ')}`);

    return lines.join('\n');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // HELPER: BUILD PLAYER MATCH-BY-MATCH TABLE
  // ─────────────────────────────────────────────────────────────────────────────

  private buildPlayerMatchTable(results: any[], question: string): string {
    if (results.length === 0) return 'No match records found.';

    const playerName = results[0]?.player_name ?? 'Player';
    const country = results[0]?.player_country ? ` (${results[0].player_country})` : '';

    // Helper: check if a field has any real value across all rows
    const hasData = (field: string): boolean =>
      results.some(r => r[field] !== undefined && r[field] !== null && r[field] !== '' && r[field] !== 0 && r[field] !== '0');

    type Col = { header: string; getValue: (r: any) => string };
    const cols: Col[] = [
      { header: 'Date',     getValue: r => r.date ? String(r.date).slice(0, 10) : '-' },
      { header: 'Format',   getValue: r => r.format ?? '-' },
      { header: 'Opponent', getValue: r => r.opponent ?? '-' },
      { header: 'Venue',    getValue: r => r.venue ?? '-' },
      { header: 'Result',   getValue: r => r.result ?? '-' },
    ];

    // Batting columns — only if any row has data
    if (hasData('runs'))        cols.push({ header: 'Runs',  getValue: r => r.runs !== undefined && r.runs !== '' ? String(r.runs) : '-' });
    if (hasData('balls'))       cols.push({ header: 'Balls', getValue: r => r.balls !== undefined && r.balls !== '' ? String(r.balls) : '-' });
    if (hasData('fours'))       cols.push({ header: '4s',    getValue: r => r.fours !== undefined && r.fours !== '' ? String(r.fours) : '-' });
    if (hasData('sixes'))       cols.push({ header: '6s',    getValue: r => r.sixes !== undefined && r.sixes !== '' ? String(r.sixes) : '-' });
    if (hasData('strike_rate')) cols.push({ header: 'SR',    getValue: r => r.strike_rate !== undefined && r.strike_rate !== '' ? String(r.strike_rate) : '-' });

    // Bowling columns — only if any row has data
    if (hasData('wickets_bowling')) cols.push({ header: 'Wkts',          getValue: r => r.wickets_bowling !== undefined && r.wickets_bowling !== '' ? String(r.wickets_bowling) : '-' });
    if (hasData('overs'))           cols.push({ header: 'Overs',         getValue: r => r.overs !== undefined && r.overs !== '' ? String(r.overs) : '-' });
    if (hasData('runs_conceded'))   cols.push({ header: 'Runs Conceded', getValue: r => r.runs_conceded !== undefined && r.runs_conceded !== '' ? String(r.runs_conceded) : '-' });
    if (hasData('economy'))         cols.push({ header: 'Econ',          getValue: r => r.economy !== undefined && r.economy !== '' ? String(r.economy) : '-' });

    const lines: string[] = [];
    lines.push(`**${playerName}${country} — Match Records**\n`);
    lines.push(`| ${cols.map(c => c.header).join(' | ')} |`);
    lines.push(`| ${cols.map(() => '---').join(' | ')} |`);

    for (const r of results) {
      lines.push(`| ${cols.map(c => c.getValue(r)).join(' | ')} |`);
    }

    return lines.join('\n');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // HELPER: RANKING QUESTION DETECTION
  // ─────────────────────────────────────────────────────────────────────────────

  private isRankingQuestion(question: string): boolean {
    const q = question.toLowerCase();
    return [
      'most', 'highest', 'top', 'best', 'most runs', 'most wickets',
      'leaderboard', 'ranking', 'list', 'who scored', 'who took',
    ].some(kw => q.includes(kw));
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // HELPER: BUILD MARKDOWN TABLE
  // ─────────────────────────────────────────────────────────────────────────────

  private buildMarkdownTable(results: any[], question: string): string {
    const q = question.toLowerCase();
    const isBowling = q.includes('wicket') || q.includes('bowl');
    const isVenue =
      q.includes('venue') || q.includes('ground') || q.includes('stadium') ||
      ['sharjah', 'dubai', 'lahore', 'karachi', 'mumbai', 'delhi'].some(v => q.includes(v));
    const isTeamMatch = results[0]?.score !== undefined || results[0]?.margin !== undefined;

    // Detect $group aggregation results: { _id: <value>, someMetric: <number> }
    // Remap _id to a meaningful label so it shows in the table
    const first = results[0];
    const isGroupResult =
      first !== undefined &&
      first._id !== undefined &&
      typeof first._id === 'string' &&
      Object.keys(first).filter(k => k !== '_id').every(k => typeof first[k] === 'number');

    if (isGroupResult) {
      // Determine the label for _id based on question context
      let idLabel = 'Team';
      if (q.includes('player') || q.includes('batsman') || q.includes('bowler')) idLabel = 'Player';
      else if (q.includes('format')) idLabel = 'Format';
      else if (q.includes('venue') || q.includes('ground') || q.includes('stadium')) idLabel = 'Venue';
      else if (q.includes('year')) idLabel = 'Year';
      else if (q.includes('result')) idLabel = 'Result';

      // Build metric labels from the other keys
      const metricKeys = Object.keys(first).filter(k => k !== '_id');

      const headers = ['#', idLabel, ...metricKeys.map(k =>
        k.replace(/^total_/, '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      )];
      const separator = headers.map(() => '---');

      const rows = results.map((row, i) => [
        String(i + 1),
        row._id ?? '-',
        ...metricKeys.map(k => (row[k] !== undefined && row[k] !== null ? String(row[k]) : '-')),
      ]);

      return [
        `| ${headers.join(' | ')} |`,
        `| ${separator.join(' | ')} |`,
        ...rows.map(r => `| ${r.join(' | ')} |`),
      ].join('\n');
    }

    type ColDef = { key: string; label: string; transform?: (v: any, row: any, i: number) => string };
    const cols: ColDef[] = [];

    cols.push({ key: '__rank', label: '#', transform: (_, _row, i) => String(i + 1) });

    if (isTeamMatch) {
      if (first?.team !== undefined) cols.push({ key: 'team', label: 'Team' });
      if (first?.opponent !== undefined) cols.push({ key: 'opponent', label: 'Opponent' });
      if (first?.date !== undefined) cols.push({ key: 'date', label: 'Date' });
      if (first?.format !== undefined) cols.push({ key: 'format', label: 'Format' });
      if (first?.venue !== undefined) cols.push({ key: 'venue', label: 'Venue' });
      if (first?.result !== undefined) cols.push({ key: 'result', label: 'Result' });
      if (first?.score !== undefined) cols.push({ key: 'score', label: 'Score' });
      if (first?.wickets !== undefined) cols.push({ key: 'wickets', label: 'Wkts' });
      if (first?.overs !== undefined) cols.push({ key: 'overs', label: 'Overs' });
      if (first?.margin !== undefined) cols.push({ key: 'margin', label: 'Margin' });
      if (first?.toss !== undefined) cols.push({ key: 'toss', label: 'Toss' });
      if (first?.batting !== undefined) cols.push({ key: 'batting', label: 'Bat' });
    } else {
      if (first?.player_name !== undefined) {
        cols.push({ key: 'player_name', label: 'Player' });
      } else if (first?.player_id !== undefined) {
        cols.push({ key: 'player_id', label: 'Player ID' });
      }

      if (first?.player_country !== undefined) {
        cols.push({ key: 'player_country', label: 'Country' });
      } else if (first?.team !== undefined) {
        cols.push({ key: 'team', label: 'Team' });
      }

      if (first?.total_runs !== undefined) cols.push({ key: 'total_runs', label: 'Runs' });
      if (first?.total_wickets !== undefined) cols.push({ key: 'total_wickets', label: 'Wickets' });
      if (first?.total_hundreds !== undefined) cols.push({ key: 'total_hundreds', label: 'Centuries' });
      if (first?.total_fifties !== undefined) cols.push({ key: 'total_fifties', label: 'Fifties' });
      if (first?.wins !== undefined) cols.push({ key: 'wins', label: 'Wins' });
      if (first?.total_wins !== undefined) cols.push({ key: 'total_wins', label: 'Wins' });
      if (first?.runs !== undefined && first?.total_runs === undefined) cols.push({ key: 'runs', label: 'Runs' });
      if (first?.wickets_bowling !== undefined && isBowling) cols.push({ key: 'wickets_bowling', label: 'Wickets' });
      if (first?.matches !== undefined) cols.push({ key: 'matches', label: 'Matches' });
      if (first?.average !== undefined) cols.push({ key: 'average', label: 'Average' });
      if (first?.highest_score !== undefined) cols.push({ key: 'highest_score', label: 'HS' });
      if (first?.hundreds !== undefined) cols.push({ key: 'hundreds', label: '100s' });
      if (first?.wickets !== undefined && first?.total_wickets === undefined && isBowling) {
        cols.push({ key: 'wickets', label: 'Wickets' });
      }
      if (first?.best_bowling !== undefined) cols.push({ key: 'best_bowling', label: 'Best' });
      if (first?.five_wicket_hauls !== undefined) cols.push({ key: 'five_wicket_hauls', label: '5W' });
      if (first?.venue !== undefined && isVenue) cols.push({ key: 'venue', label: 'Venue' });
      if (first?.date !== undefined && results.length <= 5) cols.push({ key: 'date', label: 'Date' });
      if (first?.opponent !== undefined && results.length <= 5) cols.push({ key: 'opponent', label: 'Opponent' });
      if (first?.result !== undefined && results.length <= 5) cols.push({ key: 'result', label: 'Result' });
    }

    const existingKeys = new Set(cols.map(c => c.key));
    if (cols.length <= 2) {
      const SKIP_KEYS = new Set(['_id', 'player_id', 'player_name', 'player_country', 'team', '__rank']);
      for (const key of Object.keys(first)) {
        if (SKIP_KEYS.has(key) || existingKeys.has(key)) continue;
        if (typeof first[key] === 'number' || typeof first[key] === 'string') {
          cols.push({
            key,
            label: key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
          });
        }
      }
    }

    const headers = cols.map(c => c.label);
    const separator = cols.map(() => '---');

    const rows = results.map((row, i) =>
      cols.map(col => {
        if (col.key === '__rank') return String(i + 1);
        const val = row[col.key];
        if (col.transform) return col.transform(val, row, i);
        if (val === undefined || val === null || val === '') return '-';
        return String(val);
      }),
    );

    return [
      `| ${headers.join(' | ')} |`,
      `| ${separator.join(' | ')} |`,
      ...rows.map(r => `| ${r.join(' | ')} |`),
    ].join('\n');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // HELPER: EXTRACT FIRST BALANCED JSON OBJECT FROM STRING
  // ─────────────────────────────────────────────────────────────────────────────

  private extractFirstJsonObject(text: string): string | null {
    const start = text.indexOf('{');
    if (start === -1) return null;

    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\' && inString) { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }

    return null;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // CORE: CALL GROQ AI WITH MODEL FALLBACK CHAIN
  // ─────────────────────────────────────────────────────────────────────────────

  private async callAI(
    prompt: string,
    preferredModel = GROQ_MODEL_CHAIN[0],
    systemPrompt?: string,
  ): Promise<string> {
    const apiKey = this.configService.get<string>('GROQ_API_KEY');

    if (!apiKey) {
      throw new Error('GROQ_API_KEY is missing from .env file');
    }

    const modelChain = [
      preferredModel,
      ...GROQ_MODEL_CHAIN.filter(m => m !== preferredModel),
    ];

    const messages: { role: string; content: string }[] = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: prompt });

    const maxRetriesPerModel = 2;
    let lastError: any;

    for (const model of modelChain) {
      console.log(`=== CALLING GROQ API (model: ${model}) ===`);
      console.log('API Key exists:', !!apiKey);
      console.log('API Key starts with:', apiKey?.substring(0, 8));

      for (let attempt = 1; attempt <= maxRetriesPerModel; attempt++) {
        try {
          const response = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',
            {
              model,
              messages,
              temperature: 0.1,
              max_tokens: 1000,
            },
            {
              headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
              },
            },
          );

          console.log(`✓ Groq responded (model: ${model}, status: ${response.status})`);
          return response.data.choices[0].message.content;

        } catch (error) {
          lastError = error;
          const status = error.response?.status;
          const isRateLimit = status === 429;
          const isUnavailable = status === 503;

          console.warn(
            `=== GROQ FAILED (model: ${model}, attempt: ${attempt}/${maxRetriesPerModel}, status: ${status}) ===`,
          );
          console.warn('Error:', JSON.stringify(error.response?.data ?? error.message));

          if (isRateLimit || isUnavailable) {
            if (attempt < maxRetriesPerModel) {
              const retryAfter = error.response?.headers?.['retry-after'];
              const waitMs = retryAfter
                ? Math.min(Number(retryAfter) * 1000, 15_000)
                : Math.min(1000 * 2 ** attempt, 10_000);
              console.log(`  → waiting ${waitMs}ms before retry…`);
              await new Promise(r => setTimeout(r, waitMs));
              continue;
            }
            console.warn(`  → model "${model}" exhausted, trying next model in chain…`);
            break;
          }

          throw error;
        }
      }
    }

    console.error('=== ALL GROQ MODELS EXHAUSTED ===');
    throw lastError;
  }
}