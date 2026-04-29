import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../database/database.service';
import axios from 'axios';
import { readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';

interface WorkflowState {
  question: string;
  isRelevant?: boolean;
  relevancyReason?: string;
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

@Injectable()
export class LangGraphService {
  private schemaDescription: any;

  constructor(
    private configService: ConfigService,
    private databaseService: DatabaseService,
  ) {
const schemaPath = join(__dirname, '..', '..', 'cricket data', 'schema-description.json');

    console.log('Looking for schema at:', schemaPath);

    if (!existsSync(schemaPath)) {
      console.error('Schema file not found at:', schemaPath);
      console.error('Current working directory:', process.cwd());
      console.error('PROJECT_ROOT env:', process.env.PROJECT_ROOT);
      throw new Error(
        `Schema file not found. Please set PROJECT_ROOT environment variable or place schema at: ${schemaPath}`,
      );
    }

    this.schemaDescription = JSON.parse(readFileSync(schemaPath, 'utf-8'));
    console.log('✓ Schema loaded successfully');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PUBLIC ENTRY POINT
  // ─────────────────────────────────────────────────────────────────────────────

  async runWorkflow(question: string): Promise<{ answer: string; type: 'text' | 'table' }> {
    const state: WorkflowState = { question };

    // Skip relevancy check — saves tokens on a cricket-only app
    state.isRelevant = true;

    // Try rule-based query first (no AI tokens needed for common patterns)
    this.tryRuleBasedQuery(state);

    // Fall back to AI query generation if no rule matched
    if (!state.generatedQuery) {
      await this.generateQuery(state);
    }

    if (state.error || !state.generatedQuery) {
      return {
        answer: `Sorry, I could not generate a query for that question. Error: ${state.error ?? 'unknown'}. Please try rephrasing.`,
        type: 'text',
      };
    }

    await this.executeQuery(state);

    if (state.error) {
      return { answer: `Sorry, there was an error running the query: ${state.error}`, type: 'text' };
    }

    // executeQuery may have set formattedAnswer directly (e.g. empty collection warning)
    if (state.formattedAnswer) {
      return { answer: state.formattedAnswer, type: state.answerType ?? 'text' };
    }

    await this.formatAnswer(state);

    return {
      answer: state.formattedAnswer ?? 'No results found.',
      type: state.answerType ?? 'text',
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // HELPER: DETECT WHAT DATA IS AVAILABLE FOR A QUESTION
  // Returns a human-readable message when no results are found, distinguishing
  // "data not in our dataset" from "no matches for your filter".
  // ─────────────────────────────────────────────────────────────────────────────

  private buildNoResultsMessage(state: WorkflowState): string {
    const q = state.question.toLowerCase();
    const col = state.generatedQuery?.collection ?? '';

    // If the query targeted a specific player by name, say we don't have that player
    const playerNameMatch = state.question.match(
      /(?:details?|info(?:rmation)?|profile|stats?|runs?|wickets?|average|centuries|batting|bowling)\s+(?:of|about|on|for|by)?\s+(?:player\s+)?([A-Za-z .'-]{3,40})/i,
    ) ?? state.question.match(
      /(?:who\s+is|tell\s+me\s+about)\s+([A-Za-z .'-]{3,40})/i,
    );

    if (playerNameMatch && (col === 'players' || col === 'players_yearly' || col === 'players_matches')) {
      const name = playerNameMatch[1].trim().replace(/[?!.]+$/, '');
      return `No player named "${name}" was found in the dataset. The dataset covers international cricketers tracked by ESPN Cricinfo. Please check the spelling or try a different name.`;
    }

    // Team-level queries
    if (col === 'team_matches') {
      const filter = state.generatedQuery?.filter ?? {};
      const pipeline = state.generatedQuery?.pipeline;

      // Format filter
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

    // Generic fallback
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
  // NODE: RULE-BASED QUERY (no AI, zero tokens)
  // ─────────────────────────────────────────────────────────────────────────────

  private tryRuleBasedQuery(state: WorkflowState): void {
    const q = state.question.toLowerCase().trim();

    // ── Player profile ────────────────────────────────────────────────────────
    const playerDetailPatterns = [
      /(?:details?|info(?:rmation)?|profile)\s+(?:of|about|on|for)\s+(?:player\s+)?(.+)/i,
      /(?:who\s+is|tell\s+me\s+about(?:\s+player)?)\s+(.+)/i,
      /(?:player\s+)?(.+?)\s+(?:details?|info(?:rmation)?|profile)/i,
    ];

    for (const pattern of playerDetailPatterns) {
      const match = state.question.match(pattern);
      if (match) {
        const playerName = match[1].trim().replace(/[?!.]+$/, '');
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
    // e.g. "How many runs did Babar Azam score in ODIs?"
    //      "What is Virat Kohli's batting average in Tests?"
    //      "Rohit Sharma ODI stats"
    const playerStatsPatterns = [
      /(?:how\s+many\s+(?:runs?|wickets?|centuries|fifties|matches?))\s+(?:did|has|have)\s+(.+?)\s+(?:score|take|play|make|get)/i,
      /(?:what\s+(?:is|are|was|were))\s+(.+?)'?s?\s+(?:batting|bowling|career|overall)?\s*(?:stats?|average|record|figures?)/i,
      /(.+?)\s+(?:odi|t20i?|test)\s+(?:career\s+)?(?:stats?|record|figures?|average|runs?|wickets?)/i,
      /(?:career\s+)?(?:stats?|record|figures?)\s+(?:of|for)\s+(.+?)(?:\s+in\s+(odi|t20i?|test))?/i,
    ];

    for (const pattern of playerStatsPatterns) {
      const match = state.question.match(pattern);
      if (match) {
        const playerName = match[1].trim().replace(/[?!.]+$/, '');
        // Avoid matching generic words as player names
        const genericWords = /^(?:a|the|this|that|team|player|match|game|cricket|all|any|every|which|what|who|how|when|where|why)$/i;
        if (genericWords.test(playerName) || playerName.length < 3) continue;

        // Detect format from question
        let format: string | null = null;
        const fmtMatch = state.question.match(/\b(odi|t20i?|test)\b/i);
        if (fmtMatch) {
          const f = fmtMatch[1].toUpperCase();
          format = f === 'T20' ? 'T20I' : f === 'TEST' ? 'Test' : f;
        }

        console.log(`=== RULE-BASED: player career stats for "${playerName}" format=${format} ===`);

        // First look up the player_id, then query players_yearly
        // We do this as a two-step pipeline via $lookup equivalent:
        // Use players_yearly with a sub-lookup — but MongoDB doesn't support cross-collection
        // in a simple find. Instead, we'll query players collection and let executeQuery
        // enrich. Actually we need player_id first. Use a special marker so executeQuery
        // can do the two-step lookup.
        state.generatedQuery = {
          collection: 'players_yearly',
          _playerNameLookup: playerName,
          _format: format,
          pipeline: [
            // Placeholder — will be replaced in executeQuery after player_id lookup
            { $match: { player_id: -1 } },
          ],
        };
        return;
      }
    }

    // ── Top run scorers / wicket takers ───────────────────────────────────────
    // e.g. "Who scored the most runs in ODIs?", "Top 10 wicket takers in T20Is"
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
    const mostWinsPattern = /(?:most\s+wins?|which\s+team\s+(?:has|have|won)\s+(?:the\s+)?most|team\s+with\s+(?:the\s+)?most\s+wins?)/i;
    if (mostWinsPattern.test(state.question)) {
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
      const genericWords2 = /^(?:a|the|this|that|team|player|match|game|cricket|all|any|every|which|what|who|how|when|where|why)$/i;
      if (!genericWords2.test(teamName) && teamName.length >= 3) {
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
      const genericWords3 = /^(?:a|the|this|that|team|player|match|game|cricket|all|any|every)$/i;
      if (!genericWords3.test(teamName) && teamName.length >= 3) {
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
    // e.g. "Show all ODI matches in 2023", "List T20I matches at Lord's"
    const matchListPattern =
      /(?:show|list|find|get|display)(?:\s+me)?(?:\s+all)?\s+(odi|t20i?|test)\s+matches?(?:\s+(?:played\s+)?in\s+(\d{4}))?(?:\s+(?:at|in|played\s+at)\s+(.+))?/i;
    const matchListMatch = state.question.match(matchListPattern);
    if (matchListMatch) {
      const rawFormat = matchListMatch[1].toUpperCase();
      // team_matches stores Test as "TEST", T20 as "T20I"
      const format = rawFormat === 'T20' ? 'T20I' : rawFormat; // TEST stays TEST, ODI stays ODI
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
    // e.g. "matches at Sharjah where the margin was greater than 100 runs"
    //      "matches in Dubai with margin > 50 runs"
    // NOTE: margin is stored as a string like "150 runs" or "6 wickets"
    //       so we use an aggregation pipeline to extract the numeric part.
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

    // ── Matches at a venue ────────────────────────────────────────────────────
    // Stop capture at "where", "with", "when", "and" to avoid swallowing conditions
    const venuePattern = /matches?\s+(?:played\s+)?(?:at|in)\s+([A-Za-z ()]+?)(?:\s+(?:where|with|when|and|in\s+\d{4})|[?!.]|$)/i;
    const venueMatch = state.question.match(venuePattern);
    if (venueMatch) {
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

    // ── Win after bowling first (toss won + batted 2nd + won) ────────────────
    // e.g. "How many times did a team win after choosing to bowl first?"
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

    // ── Team vs Team ──────────────────────────────────────────────────────────
    // Only match if both sides look like team names (no generic words like "bowl", "bat", "win")
    const vsPattern = /^(?:find|show|list|get|display)?\s*(?:all\s+)?(?:matches?\s+(?:where|between)\s+)?([A-Za-z ]{2,30}?)\s+(?:vs\.?|versus|against)\s+([A-Za-z ]{2,30}?)(?:\s*[?!.]*)$/i;
    const vsMatch = state.question.match(vsPattern);
    if (vsMatch) {
      const team1 = vsMatch[1].trim();
      const team2 = vsMatch[2].trim();
      // Skip if either side contains non-team words
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
    // e.g. "How did Babar Azam perform against India?"
    //      "Virat Kohli stats vs Australia in T20Is"
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
      const genericWords4 = /^(?:a|the|this|that|team|player|match|game|cricket|all|any|every|which|what|who|how|when|where|why|india|pakistan|australia|england|newzealand|srilanka|bangladesh|westindies|southafrica|zimbabwe|afghanistan|ireland)$/i;
      if (!genericWords4.test(playerName) && playerName.length >= 3) {
        console.log(`=== RULE-BASED: player "${playerName}" vs opponent "${opponent}" format=${fmt} ===`);
        state.generatedQuery = {
          collection: 'players_matches',
          _playerNameLookup: playerName,
          _opponent: opponent,
          _format: fmt,
          pipeline: [{ $match: { player_id: -1 } }], // placeholder
        };
        return;
      }
    }

    // ── Toss win → match win correlation ─────────────────────────────────────
    // e.g. "How many times did the toss winner also win the match?"
    const tossWinMatchWinPattern =
      /(?:how\s+many\s+times?|count|number\s+of\s+times?).*toss.*(?:win|won).*(?:match|game).*(?:win|won)|toss\s+winner.*(?:win|won)|(?:win|won).*toss.*(?:win|won)\s+(?:the\s+)?match/i;
    if (tossWinMatchWinPattern.test(state.question)) {
      console.log(`=== RULE-BASED: toss win → match win ===`);
      state.generatedQuery = {
        collection: 'team_matches',
        pipeline: [
          { $match: { toss: 'won', result: 'won' } },
          { $count: 'times_toss_winner_won_match' },
        ],
      };
      return;
    }

    // ── Highest team score ────────────────────────────────────────────────────
    // e.g. "What is the highest team score in ODIs?", "Highest score ever in T20Is"
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
    // e.g. "How many ODIs has India won?", "Pakistan wins in T20Is"
    const teamWinsPattern =
      /(?:how\s+many\s+(?:odi|t20i?|test)s?\s+(?:has|have|did)\s+([A-Za-z ]{3,25}?)\s+won?|([A-Za-z ]{3,25}?)\s+(?:odi|t20i?|test)\s+wins?)/i;
    const twMatch = state.question.match(teamWinsPattern);
    if (twMatch) {
      const teamName = (twMatch[1] ?? twMatch[2])?.trim().replace(/[?!.]+$/, '');
      const fmtM = state.question.match(/\b(odi|t20i?|test)\b/i);
      const fmt = fmtM ? (fmtM[1].toUpperCase() === 'T20' ? 'T20I' : fmtM[1].toUpperCase()) : null;
      const genericWords5 = /^(?:a|the|this|that|team|player|match|game|cricket|all|any|every)$/i;
      if (teamName && !genericWords5.test(teamName) && teamName.length >= 3) {
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

    // ── Most centuries / fifties by a player ─────────────────────────────────
    // e.g. "Who has scored the most centuries in ODIs?"
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
      // fifties are in players_matches, not players_yearly
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

Question: "${state.question}"`;

    try {
      // Use the best available model — falls back automatically on 429
      const response = await this.callAI(userPrompt, GROQ_MODEL_CHAIN[0], systemPrompt);
      console.log('=== RAW QUERY RESPONSE ===');
      console.log(response);

      // Strip markdown code fences if present
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

      // ── Two-step player name → stats lookup ──────────────────────────────
      // When tryRuleBasedQuery sets _playerNameLookup, we first resolve the
      // player_id from the players collection, then query the target collection.
      if (state.generatedQuery._playerNameLookup) {
        const playerName = state.generatedQuery._playerNameLookup;
        const format = state.generatedQuery._format;
        const opponent = state.generatedQuery._opponent;

        const playerDoc = await db.collection('players').findOne({
          $or: [
            { short_name: { $regex: playerName, $options: 'i' } },
            { full_name: { $regex: playerName, $options: 'i' } },
          ],
        });

        if (!playerDoc) {
          state.formattedAnswer = `No player named "${playerName}" was found in the dataset. Please check the spelling or try a different name.`;
          state.answerType = 'text';
          state.queryResults = [];
          return;
        }

        const playerId = playerDoc.player_id;

        // ── Player vs opponent (players_matches) ──────────────────────────
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

        // ── Player career stats (players_yearly) ──────────────────────────
        const matchStage: any = { player_id: playerId };
        if (format) matchStage.format = format;

        state.queryResults = await db
          .collection('players_yearly')
          .find(matchStage)
          .sort({ year: -1 })
          .toArray();

        // Attach player name to each row
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

      // Normalize the query before execution to fix common AI mistakes
      this.normalizeQuery(state.generatedQuery);

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
        state.formattedAnswer = `The "${collectionName}" collection has no data. Please run the data import script first: \`node backend/import.js\``;
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

      // Skip name enrichment when querying players directly — names already present
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
  // Venues in DB are short names: "Lords", "The Oval", "Melbourne", "Sharjah"
  // The AI often generates full formal names — strip them down to the key word.
  // ─────────────────────────────────────────────────────────────────────────────

  private normalizeVenueName(venue: string): string {
    // Known alias map: formal/common name → DB value (or key search term)
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

    // Strip common suffixes to get the core name
    const stripped = venue
      .replace(/\s+(cricket\s+)?(ground|stadium|oval|park|arena|field|centre|center)$/i, '')
      .replace(/\s+(international|national|association)$/i, '')
      .trim();

    return stripped || venue;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // HELPER: NORMALIZE QUERY — fix common AI field-value mistakes
  // ─────────────────────────────────────────────────────────────────────────────

  private normalizeQuery(query: any): void {
    if (!query) return;
    const col = query.collection;

    // Fix format casing: team_matches uses "TEST", players_* use "Test"
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

    // Fix result casing for team_matches (must be lowercase)
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

    // Fix venue names — AI often generates full formal names, DB has short names
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
      // player_id field, or _id when it's a $group result grouped by player_id
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

    // Player profile → key-value table
    if (state.generatedQuery?.collection === 'players') {
      state.formattedAnswer = this.buildPlayerProfileTable(state.queryResults);
      state.answerType = 'table';
      return;
    }

    // Player yearly stats from two-step lookup → career stats table
    if (state.generatedQuery?._playerNameLookup !== undefined && state.queryResults.length > 0) {
      // If it's a vs-opponent query, show match-by-match table
      if (state.generatedQuery?._opponent) {
        state.formattedAnswer = this.buildPlayerMatchTable(state.queryResults, state.question);
      } else {
        state.formattedAnswer = this.buildPlayerStatsTable(state.queryResults, state.question);
      }
      state.answerType = 'table';
      return;
    }

    // $count pipeline result — single doc with one numeric key
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

    // Win/loss record pipeline result (grouped by result field)
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
      // Single result — use the smallest model to write one sentence (saves tokens)
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
        // Use smallest model for single-sentence answers — cheapest on tokens
        const response = await this.callAI(prompt, 'llama-3.1-8b-instant');
        state.formattedAnswer = response.trim();
        state.answerType = 'text';
      } catch {
        // Fallback: show as table anyway
        state.formattedAnswer = this.buildMarkdownTable(state.queryResults, state.question);
        state.answerType = 'table';
      }
    }
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
  // Shows year-by-year stats for a player from players_yearly collection
  // ─────────────────────────────────────────────────────────────────────────────

  private buildPlayerStatsTable(results: any[], question: string): string {
    if (results.length === 0) return 'No statistics found.';

    const q = question.toLowerCase();
    const isBowlingQ = q.includes('wicket') || q.includes('bowl');
    const isBattingQ = q.includes('run') || q.includes('bat') || q.includes('average') || q.includes('century') || q.includes('centur') || q.includes('hundred');

    const playerName = results[0]?.player_name ?? 'Player';
    const country = results[0]?.player_country ? ` (${results[0].player_country})` : '';

    const lines: string[] = [];
    lines.push(`**${playerName}${country} — Career Statistics**\n`);

    // Determine which columns to show
    const showBatting = !isBowlingQ || isBattingQ || (!isBowlingQ && !isBattingQ);
    const showBowling = isBowlingQ || (!isBowlingQ && !isBattingQ);

    const headers: string[] = ['Year', 'Format', 'M'];
    if (showBatting) headers.push('Runs', 'HS', 'Avg', '100s', '50s');
    if (showBowling) headers.push('Wkts', 'Best', 'BowlAvg', '5W');
    headers.push('Ct', 'St');

    lines.push(`| ${headers.join(' | ')} |`);
    lines.push(`| ${headers.map(() => '---').join(' | ')} |`);

    // Aggregate totals
    let totalRuns = 0, totalWkts = 0, totalMatches = 0, totalHundreds = 0;

    for (const r of results) {
      const row: string[] = [
        String(r.year ?? '-'),
        String(r.format ?? '-'),
        String(r.matches ?? '-'),
      ];
      if (showBatting) {
        row.push(
          r.runs !== '' && r.runs !== undefined ? String(r.runs) : '-',
          r.highest_score || '-',
          r.average !== '' && r.average !== undefined ? String(r.average) : '-',
          r.hundreds !== '' && r.hundreds !== undefined ? String(r.hundreds) : '-',
          '-', // fifties not in players_yearly
        );
        if (typeof r.runs === 'number') totalRuns += r.runs;
        if (typeof r.hundreds === 'number') totalHundreds += r.hundreds;
      }
      if (showBowling) {
        row.push(
          r.wickets !== '' && r.wickets !== undefined ? String(r.wickets) : '-',
          r.best_bowling || '-',
          r.bowl_avg !== '' && r.bowl_avg !== undefined ? String(r.bowl_avg) : '-',
          r.five_wicket_hauls !== '' && r.five_wicket_hauls !== undefined ? String(r.five_wicket_hauls) : '-',
        );
        if (typeof r.wickets === 'number') totalWkts += r.wickets;
      }
      row.push(
        r.catches !== '' && r.catches !== undefined ? String(r.catches) : '-',
        r.stumpings !== '' && r.stumpings !== undefined ? String(r.stumpings) : '-',
      );
      if (typeof r.matches === 'number') totalMatches += r.matches;
      lines.push(`| ${row.join(' | ')} |`);
    }

    // Summary line
    const summaryParts: string[] = [`Total matches: **${totalMatches}**`];
    if (showBatting && totalRuns > 0) summaryParts.push(`runs: **${totalRuns}**`, `centuries: **${totalHundreds}**`);
    if (showBowling && totalWkts > 0) summaryParts.push(`wickets: **${totalWkts}**`);
    lines.push(`\n${summaryParts.join(' | ')}`);

    return lines.join('\n');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // HELPER: BUILD PLAYER MATCH-BY-MATCH TABLE (vs opponent)
  // ─────────────────────────────────────────────────────────────────────────────

  private buildPlayerMatchTable(results: any[], question: string): string {
    if (results.length === 0) return 'No match records found.';

    const q = question.toLowerCase();
    const isBowling = q.includes('wicket') || q.includes('bowl');
    const playerName = results[0]?.player_name ?? 'Player';
    const country = results[0]?.player_country ? ` (${results[0].player_country})` : '';

    const lines: string[] = [];
    lines.push(`**${playerName}${country} — Match Records**\n`);

    const headers = ['Date', 'Format', 'Opponent', 'Venue', 'Result'];
    if (!isBowling) headers.push('Runs', 'Balls', '4s', '6s', 'SR');
    headers.push('Wkts', 'Overs', 'Runs Conceded', 'Econ');

    lines.push(`| ${headers.join(' | ')} |`);
    lines.push(`| ${headers.map(() => '---').join(' | ')} |`);

    for (const r of results) {
      const row = [
        r.date ? String(r.date).slice(0, 10) : '-',
        r.format ?? '-',
        r.opponent ?? '-',
        r.venue ?? '-',
        r.result ?? '-',
      ];
      if (!isBowling) {
        row.push(
          r.runs !== undefined && r.runs !== '' ? String(r.runs) : '-',
          r.balls !== undefined && r.balls !== '' ? String(r.balls) : '-',
          r.fours !== undefined && r.fours !== '' ? String(r.fours) : '-',
          r.sixes !== undefined && r.sixes !== '' ? String(r.sixes) : '-',
          r.strike_rate !== undefined && r.strike_rate !== '' ? String(r.strike_rate) : '-',
        );
      }
      row.push(
        r.wickets_bowling !== undefined && r.wickets_bowling !== '' ? String(r.wickets_bowling) : '-',
        r.overs !== undefined && r.overs !== '' ? String(r.overs) : '-',
        r.runs_conceded !== undefined && r.runs_conceded !== '' ? String(r.runs_conceded) : '-',
        r.economy !== undefined && r.economy !== '' ? String(r.economy) : '-',
      );
      lines.push(`| ${row.join(' | ')} |`);
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

    type ColDef = { key: string; label: string; transform?: (v: any, row: any, i: number) => string };
    const cols: ColDef[] = [];

    // Rank — use map index (i) for O(1) performance
    cols.push({ key: '__rank', label: '#', transform: (_, _row, i) => String(i + 1) });

    const first = results[0];

    // ── Team match result columns ─────────────────────────────────────────────
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
      // ── Player / aggregation columns ────────────────────────────────────────

      // Player name / ID
      if (first?.player_name !== undefined) {
        cols.push({ key: 'player_name', label: 'Player' });
      } else if (first?.player_id !== undefined) {
        cols.push({ key: 'player_id', label: 'Player ID' });
      }

      // Country / team
      if (first?.player_country !== undefined) {
        cols.push({ key: 'player_country', label: 'Country' });
      } else if (first?.team !== undefined) {
        cols.push({ key: 'team', label: 'Team' });
      }

      // Aggregation stat columns
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

    // Fallback: show all scalar fields if almost no stat columns were added
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
  //
  // Strategy:
  //   1. Try the requested model first.
  //   2. On 429 (rate limit) or 503 (unavailable), try the next model in the chain.
  //   3. Each model gets up to `maxRetriesPerModel` attempts with exponential back-off.
  //   4. Throw only after all models are exhausted.
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

    // Build the model chain: preferred model first, then the rest (no duplicates)
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
              // Respect Retry-After header if present, else exponential back-off
              const retryAfter = error.response?.headers?.['retry-after'];
              const waitMs = retryAfter
                ? Math.min(Number(retryAfter) * 1000, 15_000)
                : Math.min(1000 * 2 ** attempt, 10_000);
              console.log(`  → waiting ${waitMs}ms before retry…`);
              await new Promise(r => setTimeout(r, waitMs));
              continue; // retry same model
            }
            // Out of retries for this model — try next model in chain
            console.warn(`  → model "${model}" exhausted, trying next model in chain…`);
            break;
          }

          // Non-retryable error (4xx other than 429) — fail immediately
          throw error;
        }
      }
    }

    // All models in the chain failed
    console.error('=== ALL GROQ MODELS EXHAUSTED ===');
    throw lastError;
  }
}