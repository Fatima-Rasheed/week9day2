import { MongoClient } from 'mongodb';
import { parse } from 'csv-parse/sync';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/cricket_stats';

async function importData() {
  const client = new MongoClient(MONGODB_URI);
  
  try {
    await client.connect();
    console.log('Connected to MongoDB');
    
    const db = client.db();
    
    // Import player match-by-match data
    console.log('\nImporting player match-by-match data...');
    const matchByMatchPath = join(__dirname, '..', 'cricket data', 'cricket data', 'cric_players_match_by_match.csv');
    const matchByMatchContent = readFileSync(matchByMatchPath, 'utf-8');
    const matchByMatchRecords = parse(matchByMatchContent, {
      columns: true,
      skip_empty_lines: true,
      cast: true,
      cast_date: false
    });
    
    const matchCollection = db.collection('player_matches');
    await matchCollection.deleteMany({});
    await matchCollection.insertMany(matchByMatchRecords);
    console.log(`✓ Imported ${matchByMatchRecords.length} player match records`);
    
    // Import player year-by-year career summary
    console.log('\nImporting player career summary data...');
    const careerSummaryPath = join(__dirname, '..', 'cricket data', 'cricket data', 'cric_players_year_by_year_career_summary.csv');
    const careerSummaryContent = readFileSync(careerSummaryPath, 'utf-8');
    const careerSummaryRecords = parse(careerSummaryContent, {
      columns: true,
      skip_empty_lines: true,
      cast: true,
      cast_date: false
    });
    
    const careerCollection = db.collection('player_career_summary');
    await careerCollection.deleteMany({});
    await careerCollection.insertMany(careerSummaryRecords);
    console.log(`✓ Imported ${careerSummaryRecords.length} player career summary records`);
    
    // Import team match-by-match data
    console.log('\nImporting team match data...');
    const teamMatchPath = join(__dirname, '..', 'cricket data', 'cricket data', 'team_match_by_match.csv');
    const teamMatchContent = readFileSync(teamMatchPath, 'utf-8');
    const teamMatchRecords = parse(teamMatchContent, {
      columns: true,
      skip_empty_lines: true,
      cast: true,
      cast_date: false
    });
    
    const teamCollection = db.collection('team_matches');
    await teamCollection.deleteMany({});
    await teamCollection.insertMany(teamMatchRecords);
    console.log(`✓ Imported ${teamMatchRecords.length} team match records`);
    
    console.log('\n✅ All cricket data imported successfully!');
    console.log('\nCollections created:');
    console.log('  - player_matches (match-by-match player stats)');
    console.log('  - player_career_summary (year-by-year career stats)');
    console.log('  - team_matches (team match results)');
    
  } catch (error) {
    console.error('❌ Error importing data:', error);
    process.exit(1);
  } finally {
    await client.close();
  }
}

importData();
