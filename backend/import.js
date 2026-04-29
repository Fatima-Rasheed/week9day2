require('dotenv').config();
const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'cricket data');

// Column name mappings: CSV column name → MongoDB field name
const PLAYER_INFO_COLUMN_MAP = {
  'Player_id': 'player_id',
  'Short_name': 'short_name',
  'Full_name': 'full_name',
  'Active': 'active',
  'DateofBirth': 'date_of_birth',
  'Format': 'format',
  'Country': 'country',
  'Shirt_Number': 'shirt_number',
  'Batting_style': 'batting_style',
  'Bowling_Style': 'bowling_style',
  'Picture': 'picture',
};

const PLAYERS_YEAR_COLUMN_MAP = {
  'player_id': 'player_id',
  'year': 'year',
  'matches_played': 'matches',
  'runs': 'runs',
  'highest_score': 'highest_score',
  'bat_avg': 'average',
  'centuries': 'hundreds',
  'wickets': 'wickets',
  'best_bowling_innings': 'best_bowling',
  'bowl_avg': 'bowl_avg',
  'five_wicket_hauls': 'five_wicket_hauls',
  'catches': 'catches',
  'stumps': 'stumpings',
  'ave_diff': 'ave_diff',
  'match_format': 'format',
  'id': 'id',
};

const PLAYERS_MATCH_COLUMN_MAP = {
  'player_id': 'player_id',
  'startdate': 'date',
  'match_format': 'format',
  'opposition': 'opponent',
  'ground': 'venue',
  'match_result': 'result',
  'innings': 'innings',
  'not_out': 'not_out',
  'bat_1': 'runs_str',
  'bat_2': 'bat_2',
  'runs': 'runs',
  'ball_faced': 'balls',
  'fours': 'fours',
  'sixes': 'sixes',
  'strike_rate': 'strike_rate',
  'ducks': 'ducks',
  'overs': 'overs',
  'maiden': 'maidens',
  'runs_conceded': 'runs_conceded',
  'wickets': 'wickets_bowling',
  'economy': 'economy',
  'bowling_average': 'bowling_average',
  'bowling_strike_rate': 'bowling_strike_rate',
  'match_number': 'match_ref',
  'year': 'year',
  'dismissals': 'dismissals',
  'catches': 'catches',
  'stumps': 'stumpings',
  'catches_as_wicketkeeper': 'catches_as_wicketkeeper',
  'catches_in_field': 'catches_in_field',
  'team': 'team',
  'fifties': 'fifties',
  'centuries': 'centuries',
};

const TEAM_MATCH_COLUMN_MAP = {
  'team_name': 'team',
  'opponent': 'opponent',
  'startdate': 'date',
  'match_format': 'format',
  'ground': 'venue',
  'match_result': 'result',
  'margin': 'margin',
  'toss': 'toss',
  'batting': 'batting',
  'runs': 'score',
  'wickets': 'wickets',
  'overs_played': 'overs',
  'runs_avg_per_over': 'run_rate',
};

function parseCSVLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      values.push(current.trim().replace(/\r/g, ''));
      current = '';
    } else {
      current += ch;
    }
  }
  values.push(current.trim().replace(/\r/g, ''));
  return values;
}

function parseCSV(filePath, columnMap) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n');
  
  // First line is the header row
  const csvHeaders = parseCSVLine(lines[0]);
  
  return lines.slice(1).map(line => {
    const values = parseCSVLine(line);
    const doc = {};
    csvHeaders.forEach((csvCol, i) => {
      const fieldName = columnMap[csvCol] ?? csvCol; // fall back to original name if not mapped
      const val = values[i] ?? '';
      doc[fieldName] = (!isNaN(val) && val !== '') ? Number(val) : val;
    });
    return doc;
  });
}

async function insertInBatches(collection, docs, batchSize = 1000) {
  for (let i = 0; i < docs.length; i += batchSize) {
    await collection.insertMany(docs.slice(i, i + batchSize));
    process.stdout.write(`\r  ${Math.min(i + batchSize, docs.length)}/${docs.length} inserted...`);
  }
  console.log('');
}

async function importAll() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('❌ MONGODB_URI not found in .env');
    process.exit(1);
  }

  const client = new MongoClient(uri);
  await client.connect();
  console.log('✅ MongoDB Connected');

  const db = client.db('week9day2');

  // 0. Player info (names lookup)
  console.log('📥 Importing player info...');
  const playerInfoDocs = parseCSV(
    path.join(DATA_DIR, 'player_info.csv'),
    PLAYER_INFO_COLUMN_MAP
  );
  await db.collection('players').deleteMany({});
  await insertInBatches(db.collection('players'), playerInfoDocs);
  // Create index on player_id for fast lookups
  await db.collection('players').createIndex({ player_id: 1 }, { unique: true });
  console.log(`✅ players: ${playerInfoDocs.length} docs`);

  // 1. Players year-by-year
  console.log('📥 Importing players year-by-year...');
  const playerYearDocs = parseCSV(
    path.join(DATA_DIR, 'year_by_year_data.csv'),
    PLAYERS_YEAR_COLUMN_MAP
  );
  await db.collection('players_yearly').deleteMany({});
  await insertInBatches(db.collection('players_yearly'), playerYearDocs);
  console.log(`✅ players_yearly: ${playerYearDocs.length} docs`);

  // 2. Players match-by-match
  console.log('📥 Importing players match-by-match...');
  const playerMatchDocs = parseCSV(
    path.join(DATA_DIR, 'match_by_match_data.csv'),
    PLAYERS_MATCH_COLUMN_MAP
  );
  await db.collection('players_matches').deleteMany({});
  await insertInBatches(db.collection('players_matches'), playerMatchDocs);
  console.log(`✅ players_matches: ${playerMatchDocs.length} docs`);

  // 3. Team match-by-match
  console.log('📥 Importing team match-by-match...');
  const teamMatchDocs = parseCSV(
    path.join(DATA_DIR, 'team_match_by_match_data.csv'),
    TEAM_MATCH_COLUMN_MAP
  );
  await db.collection('team_matches').deleteMany({});
  await insertInBatches(db.collection('team_matches'), teamMatchDocs);
  console.log(`✅ team_matches: ${teamMatchDocs.length} docs`);

  await client.close();
  console.log('🎉 All data imported successfully!');
}

importAll().catch(err => {
  console.error('❌ Import failed:', err.message);
  process.exit(1);
});
