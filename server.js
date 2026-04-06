/**
 * InjuryWire Server v2 — Full persistence + NBA schedule
 *
 * Required env vars:
 *   TWEETAPI_KEY    — TweetAPI.com key
 *   DATABASE_URL    — Neon postgres connection string
 *
 * Optional env vars:
 *   BALLDONTLIE_KEY — balldontlie.io API key (for matchup/game time)
 *   API_KEY         — key clients must send as X-Api-Key header
 *   PORT            — defaults to 3000
 */

require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const cors    = require('cors');
const { Pool } = require('pg');
const { startScraper, getOfficialCache, getOfficialStatusForPlayer } = require('./nba-scraper');

const app  = express();
app.use(cors());
const PORT = process.env.PORT || 3000;

// ─── DATABASE ─────────────────────────────────────────────────────────────────
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

async function initDB() {
  if (!pool) { console.log('[DB] No DATABASE_URL — running without persistence'); return; }
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS injury_reports (
        id                    SERIAL PRIMARY KEY,
        tweet_id              TEXT UNIQUE,
        player                TEXT,
        position              TEXT,
        team                  TEXT,
        status                TEXT,
        injury_type           TEXT,
        body_part             TEXT,
        matchup               TEXT,
        game_date             DATE,
        game_time             TEXT,
        reporter              TEXT,
        outlet                TEXT,
        tier                  INTEGER,
        confidence            INTEGER,
        time_of_report        TIMESTAMPTZ,
        prev_status           TEXT,
        days_since_last_report INTEGER,
        tweet_text            TEXT,
        corroborators         TEXT[],
        corrob_tweets         JSONB DEFAULT '[]',
        created_at            TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_player   ON injury_reports(player);
      CREATE INDEX IF NOT EXISTS idx_team     ON injury_reports(team);
      CREATE INDEX IF NOT EXISTS idx_time     ON injury_reports(time_of_report DESC);
      CREATE INDEX IF NOT EXISTS idx_tweet_id ON injury_reports(tweet_id);
    `);
    await pool.query(`
      ALTER TABLE injury_reports
      ADD COLUMN IF NOT EXISTS corrob_tweets JSONB DEFAULT '[]'
    `);
    console.log('[DB] Schema ready ✓');
  } catch (err) {
    console.error('[DB] Init error:', err.message);
  }
}

// ─── ROSTER CACHE (from balldontlie /v1/players/active) ──────────────────────
// Maps canonical full name → { team, position }
// Refreshed every 24 hours. Falls back to ROSTER_FALLBACK if API unavailable.
let rosterCache = {};       // { "LeBron James": { team: "Los Angeles Lakers", position: "F" } }
let rosterFetchedAt = null;

// Static fallback for stars — covers the highest-injury players if API is down
// Updated March 2026
const ROSTER_FALLBACK = {
  // Atlanta Hawks
  'Jalen Johnson':{'team':'Atlanta Hawks','position':'SF'},
  'Dyson Daniels':{'team':'Atlanta Hawks','position':'SG'},
  'Onyeka Okongwu':{'team':'Atlanta Hawks','position':'C'},
  'CJ McCollum':{'team':'Atlanta Hawks','position':'PG'},
  'Nickeil Alexander-Walker':{'team':'Atlanta Hawks','position':'SG'},
  // Boston Celtics
  'Jaylen Brown':{'team':'Boston Celtics','position':'SF'},
  'Jayson Tatum':{'team':'Boston Celtics','position':'PF'},
  'Payton Pritchard':{'team':'Boston Celtics','position':'PG'},
  'Derrick White':{'team':'Boston Celtics','position':'SG'},
  // Charlotte Hornets
  'LaMelo Ball':{'team':'Charlotte Hornets','position':'PG'},
  'Brandon Miller':{'team':'Charlotte Hornets','position':'SF'},
  'Miles Bridges':{'team':'Charlotte Hornets','position':'PF'},
  'Kon Knueppel':{'team':'Charlotte Hornets','position':'SF'},
  // Chicago Bulls
  'Matas Buzelis':{'team':'Chicago Bulls','position':'PF'},
  'Josh Giddey':{'team':'Chicago Bulls','position':'PG'},
  'Anfernee Simons':{'team':'Chicago Bulls','position':'SG'},
  // Charlotte Hornets
  'Coby White':{'team':'Charlotte Hornets','position':'SG'},
  // Cleveland Cavaliers
  'Donovan Mitchell':{'team':'Cleveland Cavaliers','position':'SG'},
  'Evan Mobley':{'team':'Cleveland Cavaliers','position':'PF'},
  'Jarrett Allen':{'team':'Cleveland Cavaliers','position':'C'},
  'James Harden':{'team':'Cleveland Cavaliers','position':'PG'},
  // Dallas Mavericks
  'Kyrie Irving':{'team':'Dallas Mavericks','position':'SG'},
  'Klay Thompson':{'team':'Dallas Mavericks','position':'SF'},
  'Cooper Flagg':{'team':'Dallas Mavericks','position':'SF'},
  // Denver Nuggets
  'Nikola Jokić':{'team':'Denver Nuggets','position':'C'},
  'Jamal Murray':{'team':'Denver Nuggets','position':'PG'},
  'Aaron Gordon':{'team':'Denver Nuggets','position':'PF'},
  'Peyton Watson':{'team':'Denver Nuggets','position':'SF'},
  // Detroit Pistons
  'Cade Cunningham':{'team':'Detroit Pistons','position':'PG'},
  'Jalen Duren':{'team':'Detroit Pistons','position':'C'},
  'Ausar Thompson':{'team':'Detroit Pistons','position':'SF'},
  'Ron Holland':{'team':'Detroit Pistons','position':'SF'},
  // Golden State Warriors
  'Stephen Curry':{'team':'Golden State Warriors','position':'PG'},
  'Draymond Green':{'team':'Golden State Warriors','position':'PF'},
  'Brandin Podziemski':{'team':'Golden State Warriors','position':'SG'},
  'Moses Moody':{'team':'Golden State Warriors','position':'SG'},
  'Jimmy Butler':{'team':'Golden State Warriors','position':'SF'},
  // Houston Rockets
  'Alperen Şengün':{'team':'Houston Rockets','position':'C'},
  'Amen Thompson':{'team':'Houston Rockets','position':'PG'},
  'Kevin Durant':{'team':'Houston Rockets','position':'SF'},
  'Jabari Smith Jr.':{'team':'Houston Rockets','position':'PF'},
  'Reed Sheppard':{'team':'Houston Rockets','position':'SG'},
  // Indiana Pacers
  'Pascal Siakam':{'team':'Indiana Pacers','position':'PF'},
  'Andrew Nembhard':{'team':'Indiana Pacers','position':'PG'},
  'Ben Sheppard':{'team':'Indiana Pacers','position':'SG'},
  'Ivica Zubac':{'team':'Indiana Pacers','position':'C'},
  // LA Clippers
  'Kawhi Leonard':{'team':'LA Clippers','position':'SF'},
  'Darius Garland':{'team':'LA Clippers','position':'PG'},
  // Los Angeles Lakers
  'LeBron James':{'team':'Los Angeles Lakers','position':'SF'},
  'Austin Reaves':{'team':'Los Angeles Lakers','position':'SG'},
  'Deandre Ayton':{'team':'Los Angeles Lakers','position':'C'},
  // Memphis Grizzlies
  'Ja Morant':{'team':'Memphis Grizzlies','position':'PG'},
  // Orlando Magic
  'Desmond Bane':{'team':'Orlando Magic','position':'SG'},
  // Memphis Grizzlies
  'Zach Edey':{'team':'Memphis Grizzlies','position':'C'},
  // Miami Heat
  'Bam Adebayo':{'team':'Miami Heat','position':'C'},
  'Tyler Herro':{'team':'Miami Heat','position':'SG'},
  'Andrew Wiggins':{'team':'Miami Heat','position':'SF'},
  'Norman Powell':{'team':'Miami Heat','position':'SG'},
  // Milwaukee Bucks
  'Giannis Antetokounmpo':{'team':'Milwaukee Bucks','position':'PF'},
  'Myles Turner':{'team':'Milwaukee Bucks','position':'C'},
  'Bobby Portis':{'team':'Milwaukee Bucks','position':'PF'},
  'Gary Trent Jr.':{'team':'Milwaukee Bucks','position':'SG'},
  'Kyle Kuzma':{'team':'Milwaukee Bucks','position':'PF'},
  // Minnesota Timberwolves
  'Anthony Edwards':{'team':'Minnesota Timberwolves','position':'SG'},
  'Rudy Gobert':{'team':'Minnesota Timberwolves','position':'C'},
  'Julius Randle':{'team':'Minnesota Timberwolves','position':'PF'},
  'Jaden McDaniels':{'team':'Minnesota Timberwolves','position':'PF'},
  // New Orleans Pelicans
  'Zion Williamson':{'team':'New Orleans Pelicans','position':'PF'},
  'Trey Murphy III':{'team':'New Orleans Pelicans','position':'SF'},
  'Jordan Poole':{'team':'New Orleans Pelicans','position':'PG'},
  // New York Knicks
  'Jalen Brunson':{'team':'New York Knicks','position':'PG'},
  'Karl-Anthony Towns':{'team':'New York Knicks','position':'C'},
  'Mikal Bridges':{'team':'New York Knicks','position':'SF'},
  'OG Anunoby':{'team':'New York Knicks','position':'PF'},
  'Josh Hart':{'team':'New York Knicks','position':'SF'},
  'Jeremy Sochan':{'team':'New York Knicks','position':'PF'},
  // Oklahoma City Thunder
  'Shai Gilgeous-Alexander':{'team':'Oklahoma City Thunder','position':'PG'},
  'Jalen Williams':{'team':'Oklahoma City Thunder','position':'SG'},
  'Chet Holmgren':{'team':'Oklahoma City Thunder','position':'PF'},
  'Isaiah Hartenstein':{'team':'Oklahoma City Thunder','position':'C'},
  'Alex Caruso':{'team':'Oklahoma City Thunder','position':'SG'},
  // Orlando Magic
  'Paolo Banchero':{'team':'Orlando Magic','position':'PF'},
  'Franz Wagner':{'team':'Orlando Magic','position':'SF'},
  'Jalen Suggs':{'team':'Orlando Magic','position':'PG'},
  'Wendell Carter Jr.':{'team':'Orlando Magic','position':'C'},
  // Philadelphia 76ers
  'Joel Embiid':{'team':'Philadelphia 76ers','position':'C'},
  'Tyrese Maxey':{'team':'Philadelphia 76ers','position':'PG'},
  'Paul George':{'team':'Philadelphia 76ers','position':'PF'},
  // Phoenix Suns
  'Devin Booker':{'team':'Phoenix Suns','position':'SG'},
  'Grayson Allen':{'team':'Phoenix Suns','position':'SG'},
  // Portland Trail Blazers
  'Scoot Henderson':{'team':'Portland Trail Blazers','position':'PG'},
  'Deni Avdija':{'team':'Portland Trail Blazers','position':'SF'},
  'Jerami Grant':{'team':'Portland Trail Blazers','position':'PF'},
  // Sacramento Kings
  'Domantas Sabonis':{'team':'Sacramento Kings','position':'C'},
  // San Antonio Spurs
  'De\'Aaron Fox':{'team':'San Antonio Spurs','position':'PG'},
  // Sacramento Kings
  'Zach LaVine':{'team':'Sacramento Kings','position':'SG'},
  'De\'Andre Hunter':{'team':'Sacramento Kings','position':'SF'},
  // San Antonio Spurs
  'Victor Wembanyama':{'team':'San Antonio Spurs','position':'C'},
  'Devin Vassell':{'team':'San Antonio Spurs','position':'SG'},
  // Toronto Raptors
  'Scottie Barnes':{'team':'Toronto Raptors','position':'PF'},
  'RJ Barrett':{'team':'Toronto Raptors','position':'SF'},
  'Immanuel Quickley':{'team':'Toronto Raptors','position':'PG'},
  'Jakob Poeltl':{'team':'Toronto Raptors','position':'C'},
  'Brandon Ingram':{'team':'Toronto Raptors','position':'SF'},
  // Utah Jazz
  'Lauri Markkanen':{'team':'Utah Jazz','position':'PF'},
  'Keyonte George':{'team':'Utah Jazz','position':'PG'},
  'Walker Kessler':{'team':'Utah Jazz','position':'C'},
  'Jaren Jackson Jr.':{'team':'Utah Jazz','position':'C'},
  // Washington Wizards
  'Bilal Coulibaly':{'team':'Washington Wizards','position':'SG'},
  'Trae Young':{'team':'Washington Wizards','position':'PG'},
  'Anthony Davis':{'team':'Washington Wizards','position':'PF'},
};


async function fetchRoster() {
  const BDLKEY = process.env.BALLDONTLIE_KEY;
  if (!BDLKEY) return;
  if (rosterFetchedAt && (Date.now() - rosterFetchedAt) < 86400000) return; // 24h cache

  console.log('[Roster] Fetching active players from balldontlie...');
  const built = {};
  let cursor = null;
  let pages = 0;

  try {
    do {
      const params = { per_page: 100 };
      if (cursor) params.cursor = cursor;
      const res = await axios.get('https://api.balldontlie.io/v1/players/active', {
        headers: { Authorization: BDLKEY },
        params,
        timeout: 10000,
      });
      const players = res.data?.data || [];
      for (const p of players) {
        const name = `${p.first_name} ${p.last_name}`.trim();
        if (!name) continue;
        built[name] = {
          team:     p.team?.full_name || null,
          position: normalizePosition(p.position, `${p.first_name} ${p.last_name}`.trim()) || p.position || null,
        };
      }
      cursor = res.data?.meta?.next_cursor || null;
      pages++;
      if (pages > 10) break; // safety cap
      if (cursor) await new Promise(r => setTimeout(r, 200));
    } while (cursor);

    rosterCache = built;
    rosterFetchedAt = Date.now();
    console.log(`[Roster] Cached ${Object.keys(built).length} players across ${pages} page(s) ✓`);
  } catch (err) {
    console.warn('[Roster] Fetch failed, using fallback:', err.message);
    if (!Object.keys(rosterCache).length) rosterCache = { ...ROSTER_FALLBACK };
  }
}

function getRosterEntry(playerName) {
  if (!playerName) return null;
  // Exact match first
  if (rosterCache[playerName]) return rosterCache[playerName];
  // Case-insensitive fallback
  const lower = playerName.toLowerCase();
  for (const [k, v] of Object.entries(rosterCache)) {
    if (k.toLowerCase() === lower) return v;
  }
  return ROSTER_FALLBACK[playerName] || null;
}

function getPosition(playerName) {
  return getRosterEntry(playerName)?.position || null;
}

function normalizePosition(pos, playerName) {
  if (!pos) return null;
  const p = pos.toUpperCase().trim();
  if (['PG','SG','SF','PF','C'].includes(p)) return p;
  // Check ROSTER_FALLBACK for a specific position for this player
  if (playerName && ROSTER_FALLBACK[playerName]) {
    const fb = ROSTER_FALLBACK[playerName].position;
    if (['PG','SG','SF','PF','C'].includes(fb)) return fb;
  }
  // Broad balldontlie mappings
  if (p === 'G')   return 'SG';
  if (p === 'F')   return 'SF';
  if (p === 'G-F' || p === 'GF') return 'SF';
  if (p === 'F-G' || p === 'FG') return 'SF';
  if (p === 'F-C' || p === 'FC') return 'PF';
  if (p === 'C-F' || p === 'CF') return 'C';
  return null;
}


// Returns true if name is a known active NBA player
function isKnownPlayer(name) {
  return !!getRosterEntry(name);
}

// ─── NBA SCHEDULE CACHE ───────────────────────────────────────────────────────
// Maps team name → array of { matchup, game_date, game_time, game_datetime_utc }
// Sorted ascending by game_date. We keep all games for the next 5 days.
let scheduleCache = {};   // { "Los Angeles Lakers": [ {matchup, game_date, game_time, game_datetime_utc}, ... ] }
let scheduleFetchedAt = null;

async function fetchSchedule() {
  const BDLKEY = process.env.BALLDONTLIE_KEY;
  if (!BDLKEY) return;

  // Don't refetch more than once per hour
  if (scheduleFetchedAt && (Date.now() - scheduleFetchedAt) < 3600000) return;

  try {
    // Use ET dates — a game at 8 PM ET on Mar 24 should be stored as Mar 24, not Mar 25 UTC
    const pad = n => String(n).padStart(2, '0');
    const etDateStr = dt => {
      const e = new Date(dt.toLocaleString('en-US', { timeZone: 'America/New_York' }));
      return `${e.getFullYear()}-${pad(e.getMonth()+1)}-${pad(e.getDate())}`;
    };
    const dates = [0, 1, 2, 3].map(d => {
      const dt = new Date();
      dt.setDate(dt.getDate() + d);
      return etDateStr(dt);
    });

    const allGames = {}; // team → [games]

    for (const date of dates) {
      const res = await axios.get('https://api.balldontlie.io/v1/games', {
        headers: { 'Authorization': BDLKEY },
        params: { dates: [date], per_page: 15 },
        timeout: 8000,
      });
      const games = res.data?.data || [];

      for (const g of games) {
        const home = g.home_team?.full_name;
        const away = g.visitor_team?.full_name;
        if (!home || !away) continue;

        const matchup = `${away} @ ${home}`;

        // Parse game_time — balldontlie gives UTC ISO datetime in g.date or g.status
        let game_time = null;
        let game_datetime_utc = null;

        if (g.status && /\d:\d\d/.test(g.status)) {
          // Already formatted like "7:30 pm ET"
          game_time = g.status;
        } else if (g.date) {
          const d = new Date(g.date);
          game_datetime_utc = d.toISOString();
          game_time = d.toLocaleTimeString('en-US', {
            hour: 'numeric', minute: '2-digit', hour12: true,
            timeZone: 'America/New_York'
          }) + ' ET';
        }

        const entry = { matchup, game_date: date, game_time, game_datetime_utc };

        [home, away].forEach(team => {
          if (!allGames[team]) allGames[team] = [];
          // Avoid duplicate dates
          if (!allGames[team].find(e => e.game_date === date)) {
            allGames[team].push(entry);
          }
        });
      }
    }

    // Sort each team's games chronologically
    for (const team of Object.keys(allGames)) {
      allGames[team].sort((a, b) => a.game_date.localeCompare(b.game_date));
    }

    scheduleCache = allGames;
    scheduleFetchedAt = Date.now();

    const totalGames = Object.values(allGames).reduce((sum, arr) => sum + arr.length, 0) / 2;
    console.log(`[Schedule] Cached ${totalGames} games across ${dates.length} days`);
  } catch (err) {
    console.warn('[Schedule] Fetch failed:', err.message);
  }
}

/**
 * getGameInfo — returns the correct game entry for a team given tweet context.
 *
 * Logic:
 *  1. If tweet says "tonight" / "out tonight" / "tonight's game" → use today's game only
 *  2. If tweet says "tomorrow" → use tomorrow's game
 *  3. If no temporal hint: use the next upcoming game after tweet time
 *     (i.e. the earliest game that hasn't already ended)
 *  4. Never assign a game that was played >6 hours before the tweet
 */
const NBA_GAME_DURATION_MS = 150 * 60 * 1000; // 2h 30m

function getGameInfo(team, tweetText = '', tweetTime = null) {
  const games = scheduleCache[team];
  if (!games || games.length === 0) {
    return { matchup: null, game_date: null, game_time: null, in_game: false };
  }

  const tw  = (tweetText || '').toLowerCase();
  const now = tweetTime ? new Date(tweetTime) : new Date();

  const pad   = n => String(n).padStart(2, '0');
  const etNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const toET  = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const todayStr    = toET(etNow);
  const tomorrowET  = new Date(etNow); tomorrowET.setDate(etNow.getDate() + 1);
  const tomorrowStr = toET(tomorrowET);

  // ── Explicit temporal signals ─────────────────────────────────────────────────
  const mentionsTonight  = /\btonight\b|out tonight|tonight's game|\btoday\b/.test(tw);
  const mentionsTomorrow = /\btomorrow\b|tomorrow's game/.test(tw);

  if (mentionsTonight) {
    const g = games.find(g => g.game_date === todayStr);
    return g ? { ...g, in_game: false } : { matchup: null, game_date: null, game_time: null, in_game: false };
  }

  if (mentionsTomorrow) {
    const g = games.find(g => g.game_date === tomorrowStr);
    return g ? { ...g, in_game: false } : { matchup: null, game_date: null, game_time: null, in_game: false };
  }

  // ── No hint — check today's game state ───────────────────────────────────────
  const todayGame = games.find(g => g.game_date === todayStr);

  if (todayGame) {
    if (todayGame.bdl_status === 'Final') {
      // Game over — fall through to next game
    } else if (todayGame.game_datetime_utc) {
      const elapsed = now.getTime() - new Date(todayGame.game_datetime_utc).getTime();
      if (elapsed < 0) return { ...todayGame, in_game: false };           // pre-game
      if (elapsed < NBA_GAME_DURATION_MS) {
        console.log(`  [In-game] ${team} ~${Math.round(elapsed/60000)}min elapsed`);
        return { ...todayGame, in_game: true };                           // live game
      }
      // Game likely over — find next
    } else {
      return { ...todayGame, in_game: false }; // no UTC time, assume valid
    }
  }

  // ── Find next future game ─────────────────────────────────────────────────────
  for (const g of games) {
    if (g.game_date > todayStr) return { ...g, in_game: false };
  }

  return { matchup: null, game_date: null, game_time: null, in_game: false };
}



// ─── REPORTERS ────────────────────────────────────────────────────────────────
const REPORTERS = [
  {name:"Kevin Chouinard",handle:"KLChouinard",team:"Atlanta Hawks",outlet:"Hawks.com / Zone Coverage",tier:1,signal:"High",conf:"E"},
  {name:"Lauren L. Williams",handle:"williamslaurenl",team:"Atlanta Hawks",outlet:"Atlanta Journal-Constitution",tier:1,signal:"High",conf:"E"},
  {name:"Chris Kirschner",handle:"ChrisKirschner",team:"Atlanta Hawks",outlet:"The Athletic",tier:2,signal:"High",conf:"E"},
  {name:"Sarah K. Spencer",handle:"sarah_k_spencer",team:"Atlanta Hawks",outlet:"Atlanta Journal-Constitution",tier:2,signal:"Medium",conf:"E"},
  {name:"Joe Barberio",handle:"JoeBarberio",team:"Atlanta Hawks",outlet:"FanDuel Sports Network SE",tier:3,signal:"Medium",conf:"E"},
  {name:"Quenton Albertie",handle:"QuentonAlbertie",team:"Atlanta Hawks",outlet:"Last Word On Sports",tier:3,signal:"Medium",conf:"E"},
  {name:"Adam Himmelsbach",handle:"adamhimmelsbach",team:"Boston Celtics",outlet:"Boston Globe",tier:1,signal:"High",conf:"E"},
  {name:"Chris Forsberg",handle:"ChrisForsberg_",team:"Boston Celtics",outlet:"NBC Sports Boston",tier:1,signal:"High",conf:"E"},
  {name:"Gary Washburn",handle:"GaryWashburn",team:"Boston Celtics",outlet:"Boston Globe",tier:1,signal:"High",conf:"E"},
  {name:"Jay King",handle:"ByJayKing",team:"Boston Celtics",outlet:"The Athletic",tier:1,signal:"High",conf:"E"},
  {name:"A. Sherrod Blakely",handle:"SherrodBlakely",team:"Boston Celtics",outlet:"NBC Boston",tier:2,signal:"Medium",conf:"E"},
  {name:"Brian Robb",handle:"BrianTRobb",team:"Boston Celtics",outlet:"MassLive",tier:2,signal:"Medium",conf:"E"},
  {name:"John Karalis",handle:"john_karalis",team:"Boston Celtics",outlet:"WEEI / Red's Army",tier:2,signal:"Medium",conf:"E"},
  {name:"Tim Bontemps",handle:"TimBontemps",team:"Boston Celtics",outlet:"ESPN",tier:2,signal:"High",conf:"E"},
  {name:"Alex Schiffer",handle:"Alex__Schiffer",team:"Brooklyn Nets",outlet:"The Athletic",tier:1,signal:"High",conf:"E"},
  {name:"Brian Lewis",handle:"NYPost_Lewis",team:"Brooklyn Nets",outlet:"New York Post",tier:1,signal:"High",conf:"E"},
  {name:"Erik Slater",handle:"erikslater_",team:"Brooklyn Nets",outlet:"ClutchPoints",tier:1,signal:"High",conf:"E"},
  {name:"Ethan Sears",handle:"EthanJSears",team:"Brooklyn Nets",outlet:"New York Post",tier:2,signal:"Medium",conf:"E"},
  {name:"Kristian Winfield",handle:"Krisplashed",team:"Brooklyn Nets",outlet:"NY Daily News",tier:2,signal:"High",conf:"E"},
  {name:"Ryan Rudominer",handle:"RyanRudominer",team:"Brooklyn Nets",outlet:"NetsDaily / FanSided",tier:2,signal:"Medium",conf:"E"},
  {name:"Rick Bonnell",handle:"rick_bonnell",team:"Charlotte Hornets",outlet:"Charlotte Observer",tier:1,signal:"High",conf:"E"},
  {name:"Rod Boone",handle:"rodboone",team:"Charlotte Hornets",outlet:"The Athletic",tier:1,signal:"High",conf:"E"},
  {name:"James Plowright",handle:"british_buzz",team:"Charlotte Hornets",outlet:"Locked On Hornets",tier:2,signal:"Medium",conf:"E"},
  {name:"Mike Eisenberg",handle:"MikeEisenberg_",team:"Charlotte Hornets",outlet:"Hornets Beat",tier:2,signal:"Medium",conf:"E"},
  {name:"Steve Reed",handle:"SteveReedAP",team:"Charlotte Hornets",outlet:"Associated Press",tier:2,signal:"High",conf:"E"},
  {name:"Wynton McLaurin",handle:"WyntonMcLaurin",team:"Charlotte Hornets",outlet:"WCCB Charlotte",tier:2,signal:"Medium",conf:"E"},
  {name:"Julia Poe",handle:"byjuliapoe",team:"Chicago Bulls",outlet:"Chicago Tribune",tier:1,signal:"High",conf:"E"},
  {name:"KC Johnson",handle:"KCJHoop",team:"Chicago Bulls",outlet:"Chicago Sports Network",tier:1,signal:"High",conf:"E"},
  {name:"Ben Pope",handle:"BenPopeCST",team:"Chicago Bulls",outlet:"Chicago Sun-Times",tier:2,signal:"Medium",conf:"E"},
  {name:"Colleen Kane",handle:"colleenkaneCT",team:"Chicago Bulls",outlet:"Chicago Tribune",tier:2,signal:"Medium",conf:"E"},
  {name:"Darnell Mayberry",handle:"DarnellMayberry",team:"Chicago Bulls",outlet:"The Athletic",tier:2,signal:"High",conf:"E"},
  {name:"Rob Schaefer",handle:"rob_schaef",team:"Chicago Bulls",outlet:"NBC Sports Chicago",tier:2,signal:"High",conf:"E"},
  {name:"Sam Smith",handle:"SamSmithHoops",team:"Chicago Bulls",outlet:"Bulls.com",tier:2,signal:"Medium",conf:"E"},
  {name:"Chris Fedor",handle:"ChrisFedor",team:"Cleveland Cavaliers",outlet:"Cleveland Plain Dealer / cleveland.com",tier:1,signal:"High",conf:"E"},
  {name:"Joe Vardon",handle:"joevardon",team:"Cleveland Cavaliers",outlet:"The Athletic",tier:1,signal:"High",conf:"E"},
  {name:"Kelsey Russo",handle:"kelseyyrusso",team:"Cleveland Cavaliers",outlet:"The Athletic",tier:1,signal:"High",conf:"E"},
  {name:"Camryn Justice",handle:"camijustice",team:"Cleveland Cavaliers",outlet:"WEWS NewsChannel 5",tier:2,signal:"Medium",conf:"E"},
  {name:"Dan Labbe",handle:"dan_labbe",team:"Cleveland Cavaliers",outlet:"cleveland.com",tier:2,signal:"Medium",conf:"E"},
  {name:"Evan Dammarell",handle:"AmnoteEvan",team:"Cleveland Cavaliers",outlet:"Fear The Sword",tier:2,signal:"High",conf:"E"},
  {name:"Coty Davis",handle:"CotyDavis_24",team:"Detroit Pistons",outlet:"Detroit Free Press",tier:1,signal:"High",conf:"E"},
  {name:"James Edwards III",handle:"JLEdwardsIII",team:"Detroit Pistons",outlet:"The Athletic",tier:1,signal:"High",conf:"E"},
  {name:"Omari Sankofa II",handle:"omarisankofa",team:"Detroit Pistons",outlet:"Detroit Free Press",tier:1,signal:"High",conf:"E"},
  {name:"Dana Gauruder",handle:"DanaGauruder",team:"Detroit Pistons",outlet:"Detroit News",tier:2,signal:"Medium",conf:"E"},
  {name:"Rod Beard",handle:"detnewsRodBeard",team:"Detroit Pistons",outlet:"Detroit News",tier:2,signal:"Medium",conf:"E"},
  {name:"Vince Ellis",handle:"vinceeellis",team:"Detroit Pistons",outlet:"Detroit Free Press",tier:2,signal:"Medium",conf:"E"},
  {name:"Dustin Dopirak",handle:"DustinDopirak",team:"Indiana Pacers",outlet:"The Athletic",tier:1,signal:"High",conf:"E"},
  {name:"Scott Agness",handle:"ScottAgness",team:"Indiana Pacers",outlet:"FieldhouseFiles.com",tier:1,signal:"High",conf:"E"},
  {name:"James Boyd",handle:"RomeovilleKid",team:"Indiana Pacers",outlet:"Indianapolis Star",tier:2,signal:"High",conf:"E"},
  {name:"Mark Montieth",handle:"MontieMedia",team:"Indiana Pacers",outlet:"Pacers.com",tier:2,signal:"Medium",conf:"E"},
  {name:"Nate Taylor",handle:"ByNateTaylor",team:"Indiana Pacers",outlet:"The Athletic",tier:2,signal:"Medium",conf:"E"},
  {name:"Tony East",handle:"TEastNBA",team:"Indiana Pacers",outlet:"SI / Pacers Digest",tier:2,signal:"Medium",conf:"E"},
  {name:"Anthony Chiang",handle:"Anthony_Chiang",team:"Miami Heat",outlet:"Miami Herald",tier:1,signal:"High",conf:"E"},
  {name:"Ira Winderman",handle:"IraHeatBeat",team:"Miami Heat",outlet:"South Florida Sun Sentinel",tier:1,signal:"High",conf:"E"},
  {name:"Brady Hawk",handle:"BradyHawk305",team:"Miami Heat",outlet:"ClutchPoints",tier:2,signal:"Medium",conf:"E"},
  {name:"Jason Jackson",handle:"JacksonAndAudio",team:"Miami Heat",outlet:"Heat TV",tier:2,signal:"Medium",conf:"E"},
  {name:"Shandel Richardson",handle:"ShandelRich",team:"Miami Heat",outlet:"Sun Sentinel",tier:2,signal:"High",conf:"E"},
  {name:"Tim Reynolds",handle:"ByTimReynolds",team:"Miami Heat",outlet:"Associated Press",tier:2,signal:"High",conf:"E"},
  {name:"Eric Nehm",handle:"eric_nehm",team:"Milwaukee Bucks",outlet:"The Athletic",tier:1,signal:"High",conf:"E"},
  {name:"Matt Velazquez",handle:"Matt_Velazquez",team:"Milwaukee Bucks",outlet:"Milwaukee Journal Sentinel",tier:1,signal:"High",conf:"E"},
  {name:"James Bates",handle:"JamesBates_",team:"Milwaukee Bucks",outlet:"Brew Hoop",tier:2,signal:"Medium",conf:"E"},
  {name:"Jaymes Langrehr",handle:"jlangrehr",team:"Milwaukee Bucks",outlet:"WISN 12",tier:2,signal:"Medium",conf:"E"},
  {name:"Jim Owczarski",handle:"JimOwczarski",team:"Milwaukee Bucks",outlet:"Milwaukee Journal Sentinel",tier:2,signal:"High",conf:"E"},
  {name:"Phoebe Arscott",handle:"PArscott_",team:"Milwaukee Bucks",outlet:"Bally Sports Wisconsin",tier:2,signal:"Medium",conf:"E"},
  {name:"Ian Begley",handle:"IanBegley",team:"New York Knicks",outlet:"SNY",tier:1,signal:"High",conf:"E"},
  {name:"James Edwards III",handle:"JLEdwardsIII",team:"New York Knicks",outlet:"The Athletic",tier:1,signal:"High",conf:"E"},
  {name:"Kristian Winfield",handle:"Krisplashed",team:"New York Knicks",outlet:"NY Daily News",tier:1,signal:"High",conf:"E"},
  {name:"Steve Popper",handle:"StevePopper",team:"New York Knicks",outlet:"Newsday",tier:1,signal:"High",conf:"E"},
  {name:"Alan Hahn",handle:"alanhahn",team:"New York Knicks",outlet:"MSG Network",tier:2,signal:"Medium",conf:"E"},
  {name:"Fred Katz",handle:"FredKatz",team:"New York Knicks",outlet:"The Athletic",tier:2,signal:"High",conf:"E"},
  {name:"Marc Berman",handle:"NYPost_Berman",team:"New York Knicks",outlet:"New York Post",tier:2,signal:"High",conf:"E"},
  {name:"Stefan Bondy",handle:"SBondyNYDN",team:"New York Knicks",outlet:"NY Daily News",tier:2,signal:"Medium",conf:"E"},
  {name:"Jason Beede",handle:"therealBeede",team:"Orlando Magic",outlet:"Orlando Sentinel",tier:1,signal:"High",conf:"E"},
  {name:"Khobi Price",handle:"khobi_price",team:"Orlando Magic",outlet:"Orlando Sentinel",tier:1,signal:"High",conf:"E"},
  {name:"Bo Churney",handle:"BoChurney",team:"Orlando Magic",outlet:"Locked On Magic",tier:2,signal:"Medium",conf:"E"},
  {name:"Evan Dunlap",handle:"EvanDunlap13",team:"Orlando Magic",outlet:"ClutchPoints",tier:2,signal:"Medium",conf:"E"},
  {name:"Josh Robbins",handle:"JoshuaBRobbins",team:"Orlando Magic",outlet:"The Athletic",tier:2,signal:"High",conf:"E"},
  {name:"Scott Anez",handle:"ScottAnez",team:"Orlando Magic",outlet:"AP",tier:2,signal:"Medium",conf:"E"},
  {name:"Keith Pompey",handle:"PompeyOnSixers",team:"Philadelphia 76ers",outlet:"Philadelphia Inquirer",tier:1,signal:"High",conf:"E"},
  {name:"Kyle Neubeck",handle:"KyleNeubeck",team:"Philadelphia 76ers",outlet:"PhillyVoice",tier:1,signal:"High",conf:"E"},
  {name:"Rich Hofmann",handle:"rich_hofmann",team:"Philadelphia 76ers",outlet:"The Athletic",tier:1,signal:"High",conf:"E"},
  {name:"Derek Bodner",handle:"DerekBodner",team:"Philadelphia 76ers",outlet:"The Athletic / IndyPHL",tier:2,signal:"Medium",conf:"E"},
  {name:"Gina Mizell",handle:"GinaMizell",team:"Philadelphia 76ers",outlet:"Philadelphia Inquirer",tier:2,signal:"High",conf:"E"},
  {name:"Jonathan Wasserman",handle:"NBADraftWass",team:"Philadelphia 76ers",outlet:"Bleacher Report",tier:2,signal:"Medium",conf:"E"},
  {name:"Tony Jones",handle:"Tjonesonthenba",team:"Philadelphia 76ers",outlet:"The Athletic",tier:2,signal:"Medium",conf:"E"},
  {name:"Doug Smith",handle:"dougsmithstar",team:"Toronto Raptors",outlet:"Toronto Star",tier:1,signal:"High",conf:"E"},
  {name:"Josh Lewenberg",handle:"JLew1050",team:"Toronto Raptors",outlet:"TSN",tier:1,signal:"High",conf:"E"},
  {name:"Michael Grange",handle:"michaelgrange",team:"Toronto Raptors",outlet:"Sportsnet",tier:1,signal:"High",conf:"E"},
  {name:"Blake Murphy",handle:"BlakeMurphyODC",team:"Toronto Raptors",outlet:"The Athletic / Raptors Republic",tier:2,signal:"Medium",conf:"E"},
  {name:"Eric Koreen",handle:"ekoreen",team:"Toronto Raptors",outlet:"The Athletic",tier:2,signal:"High",conf:"E"},
  {name:"Vivek Jacob",handle:"vivekjacob_",team:"Toronto Raptors",outlet:"Sportsnet",tier:2,signal:"High",conf:"E"},
  {name:"Ava Wallace",handle:"avarwallace",team:"Washington Wizards",outlet:"Washington Post",tier:1,signal:"High",conf:"E"},
  {name:"Bijan Todd",handle:"bijan_todd",team:"Washington Wizards",outlet:"NBC Sports Washington",tier:1,signal:"High",conf:"E"},
  {name:"Josh Robbins",handle:"JoshuaBRobbins",team:"Washington Wizards",outlet:"The Athletic",tier:1,signal:"High",conf:"E"},
  {name:"Chase Hughes",handle:"ChaseHughesNBC",team:"Washington Wizards",outlet:"NBC Sports Washington",tier:2,signal:"Medium",conf:"E"},
  {name:"Kareem Copeland",handle:"kareemcopeland",team:"Washington Wizards",outlet:"Washington Post",tier:2,signal:"Medium",conf:"E"},
  {name:"Zach Selby",handle:"ZachSelby_DC",team:"Washington Wizards",outlet:"Wizards.com",tier:2,signal:"Medium",conf:"E"},
  {name:"Chris Haynes",handle:"ChrisBHaynes",team:"All Teams",outlet:"TNT / Bleacher Report",tier:1,signal:"High",conf:"NAT"},
  {name:"Jake Fischer",handle:"JakeLFischer",team:"All Teams",outlet:"Yahoo Sports",tier:1,signal:"High",conf:"NAT"},
  {name:"Marc Stein",handle:"TheSteinLine",team:"All Teams",outlet:"Substack / Independent",tier:1,signal:"High",conf:"NAT"},
  {name:"Sam Amick",handle:"sam_amick",team:"All Teams",outlet:"The Athletic",tier:1,signal:"High",conf:"NAT"},
  {name:"Shams Charania",handle:"ShamsCharania",team:"All Teams",outlet:"ESPN",tier:1,signal:"High",conf:"NAT"},
  {name:"Brian Windhorst",handle:"WindhorstESPN",team:"All Teams",outlet:"ESPN",tier:2,signal:"High",conf:"NAT"},
  {name:"Keith Smith",handle:"KeithSmithNBA",team:"All Teams",outlet:"Spotrac",tier:2,signal:"High",conf:"NAT"},
  {name:"Kevin O'Connor",handle:"KevinOConnorNBA",team:"All Teams",outlet:"The Ringer",tier:2,signal:"Medium",conf:"NAT"},
  {name:"Ramona Shelburne",handle:"ramonashelburne",team:"All Teams",outlet:"ESPN",tier:2,signal:"High",conf:"NAT"},
  {name:"Tim Bontemps",handle:"TimBontemps",team:"All Teams",outlet:"ESPN",tier:2,signal:"High",conf:"NAT"},
  {name:"Jonathan Givony",handle:"DraftExpress",team:"All Teams",outlet:"ESPN",tier:3,signal:"Medium",conf:"NAT"},
  {name:"Brad Townsend",handle:"townbrad",team:"Dallas Mavericks",outlet:"Dallas Morning News",tier:1,signal:"High",conf:"W"},
  {name:"Callie Caplan",handle:"CallieCaplan",team:"Dallas Mavericks",outlet:"Dallas Morning News",tier:1,signal:"High",conf:"W"},
  {name:"Tim MacMahon",handle:"espn_macmahon",team:"Dallas Mavericks",outlet:"ESPN",tier:1,signal:"High",conf:"W"},
  {name:"Eddie Sefko",handle:"ESefko",team:"Dallas Mavericks",outlet:"Dallas Morning News",tier:2,signal:"Medium",conf:"W"},
  {name:"Grant Afseth",handle:"GrantAfseth",team:"Dallas Mavericks",outlet:"ClutchPoints",tier:2,signal:"High",conf:"W"},
  {name:"Mike Curtis",handle:"MikeACurtis2",team:"Dallas Mavericks",outlet:"Dallas Morning News",tier:2,signal:"High",conf:"W"},
  {name:"Saad Yousuf",handle:"SaadYousuf126",team:"Dallas Mavericks",outlet:"The Athletic",tier:2,signal:"High",conf:"W"},
  {name:"Tim Cato",handle:"tim_cato",team:"Dallas Mavericks",outlet:"ALLCITY",tier:2,signal:"Medium",conf:"W"},
  {name:"Bennett Durando",handle:"BennettDurando",team:"Denver Nuggets",outlet:"Denver Post",tier:1,signal:"High",conf:"W"},
  {name:"Mike Singer",handle:"msinger",team:"Denver Nuggets",outlet:"Denver Post",tier:1,signal:"High",conf:"W"},
  {name:"Adam Mares",handle:"adam_mares",team:"Denver Nuggets",outlet:"104.3 The Fan",tier:2,signal:"High",conf:"W"},
  {name:"Chris Dempsey",handle:"chrisadempsey",team:"Denver Nuggets",outlet:"Altitude Sports",tier:2,signal:"Medium",conf:"W"},
  {name:"Gina De La Vega",handle:"GinaDelaVega_",team:"Denver Nuggets",outlet:"Altitude Sports TV",tier:2,signal:"Medium",conf:"W"},
  {name:"Harrison Wind",handle:"HarrisonWind",team:"Denver Nuggets",outlet:"DNVR Sports",tier:2,signal:"High",conf:"W"},
  {name:"Katy Winge",handle:"katywinge",team:"Denver Nuggets",outlet:"Altitude Sports TV",tier:2,signal:"Medium",conf:"W"},
  {name:"Ryan Blackburn",handle:"NBABlackburn",team:"Denver Nuggets",outlet:"Mile High Sports",tier:2,signal:"Medium",conf:"W"},
  {name:"Anthony Slater",handle:"anthonyVslater",team:"Golden State Warriors",outlet:"ESPN",tier:1,signal:"High",conf:"W"},
  {name:"Marcus Thompson",handle:"marcus_thompson",team:"Golden State Warriors",outlet:"The Athletic",tier:1,signal:"High",conf:"W"},
  {name:"Tim Kawkami",handle:"timkawakami",team:"Golden State Warriors",outlet:"SF Standard",tier:1,signal:"High",conf:"W"},
  {name:"Connor Letourneau",handle:"Con_Chron",team:"Golden State Warriors",outlet:"San Francisco Chronicle",tier:2,signal:"Medium",conf:"W"},
  {name:"Dalton Johnson",handle:"DaltonJ_",team:"Golden State Warriors",outlet:"NBC Sports Bay Area",tier:2,signal:"High",conf:"W"},
  {name:"Monte Poole",handle:"montePooleNBCS",team:"Golden State Warriors",outlet:"NBC Sports Bay Area",tier:2,signal:"Medium",conf:"W"},
  {name:"Nick Friedell",handle:"NickFriedell",team:"Golden State Warriors",outlet:"ESPN",tier:2,signal:"High",conf:"W"},
  {name:"Rusty Simmons",handle:"Rusty_SFChron",team:"Golden State Warriors",outlet:"San Francisco Chronicle",tier:2,signal:"Medium",conf:"W"},
  {name:"Sam Gordon",handle:"bysamgordon",team:"Golden State Warriors",outlet:"NBC Sports Bay Area",tier:2,signal:"High",conf:"W"},
  {name:"Jonathan Feigen",handle:"Jonathan_Feigen",team:"Houston Rockets",outlet:"Houston Chronicle",tier:1,signal:"High",conf:"W"},
  {name:"Kelly Iko",handle:"KellyIko",team:"Houston Rockets",outlet:"The Athletic",tier:1,signal:"High",conf:"W"},
  {name:"Adam Spolane",handle:"AdamSpolane",team:"Houston Rockets",outlet:"Sports Radio 610",tier:2,signal:"Medium",conf:"W"},
  {name:"Ben DuBose",handle:"BenDuBose",team:"Houston Rockets",outlet:"Space City Home Network",tier:2,signal:"High",conf:"W"},
  {name:"Jackson Gatlin",handle:"JacksonGatlin1",team:"Houston Rockets",outlet:"Clutch City Sports",tier:2,signal:"Medium",conf:"W"},
  {name:"Lachard Binkley",handle:"BinkleyHoops",team:"Houston Rockets",outlet:"Locked On Rockets",tier:2,signal:"Medium",conf:"W"},
  {name:"Varun Shankar",handle:"ByVarunShankar",team:"Houston Rockets",outlet:"Houston Chronicle",tier:3,signal:"Medium",conf:"W"},
  {name:"Joey Linn",handle:"joeylinn_",team:"LA Clippers",outlet:"The Athletic",tier:1,signal:"High",conf:"W"},
  {name:"Law Murray",handle:"LawMurrayTheNU",team:"LA Clippers",outlet:"The Athletic",tier:1,signal:"High",conf:"W"},
  {name:"Tomer Azarly",handle:"TomerAzarly",team:"LA Clippers",outlet:"ClutchPoints",tier:1,signal:"High",conf:"W"},
  {name:"Andrew Greif",handle:"AndrewGreif",team:"LA Clippers",outlet:"Los Angeles Times",tier:2,signal:"High",conf:"W"},
  {name:"Broderick Turner",handle:"BA_Turner",team:"LA Clippers",outlet:"Los Angeles Times",tier:2,signal:"Medium",conf:"W"},
  {name:"Mirjam Swanson",handle:"MirjamSwanson",team:"LA Clippers",outlet:"LA Daily News",tier:2,signal:"Medium",conf:"W"},
  {name:"Janis Carr",handle:"janiscarr",team:"LA Clippers",outlet:"Los Angelas Daily News",tier:3,signal:"Medium",conf:"W"},
  {name:"Dan Woike",handle:"DanWoike",team:"Los Angeles Lakers",outlet:"The Athletic",tier:1,signal:"High",conf:"W"},
  {name:"Dave McMenamin",handle:"mcten",team:"Los Angeles Lakers",outlet:"ESPN",tier:1,signal:"High",conf:"W"},
  {name:"Mike Trudell",handle:"LakersReporter",team:"Los Angeles Lakers",outlet:"Spectrum SportsNet",tier:1,signal:"High",conf:"W"},
  {name:"Bill Oram",handle:"billoram",team:"Los Angeles Lakers",outlet:"The Athletic",tier:2,signal:"Medium",conf:"W"},
  {name:"Jovan Buha",handle:"jovanbuha",team:"Los Angeles Lakers",outlet:"YouTube / Independent",tier:2,signal:"High",conf:"W"},
  {name:"Kyle Goon",handle:"kylegoon",team:"Los Angeles Lakers",outlet:"Southern California News Group",tier:2,signal:"High",conf:"W"},
  {name:"Ohm Youngmisuk",handle:"NotoriousOHM",team:"Los Angeles Lakers",outlet:"ESPN",tier:2,signal:"High",conf:"W"},
  {name:"Damichael Cole",handle:"DamichaelC",team:"Memphis Grizzlies",outlet:"Memphis Commercial Appeal",tier:1,signal:"High",conf:"W"},
  {name:"Drew Hill",handle:"DrewHill_DM",team:"Memphis Grizzlies",outlet:"Memphis Commercial Appeal",tier:1,signal:"High",conf:"W"},
  {name:"Chris Herrington",handle:"ChrisHerrington",team:"Memphis Grizzlies",outlet:"The Daily Memphian",tier:2,signal:"Medium",conf:"W"},
  {name:"Evan Barnes",handle:"evan_b",team:"Memphis Grizzlies",outlet:"Memphis Commercial Appeal",tier:2,signal:"Medium",conf:"W"},
  {name:"Jared Ramsey",handle:"JaredRamseyNBA",team:"Memphis Grizzlies",outlet:"Grind City Media",tier:2,signal:"Medium",conf:"W"},
  {name:"Joe Mullinax",handle:"sidelineSCOUT",team:"Memphis Grizzlies",outlet:"GrizznessNBA",tier:2,signal:"Medium",conf:"W"},
  {name:"Pete Pranica",handle:"PetePranica",team:"Memphis Grizzlies",outlet:"FanDuel Sports Network",tier:3,signal:"Medium",conf:"W"},
  {name:"Chris Hine",handle:"ChristopherHine",team:"Minnesota Timberwolves",outlet:"Minneapolis Star Tribune",tier:1,signal:"High",conf:"W"},
  {name:"Jon Krawczynski",handle:"JonKrawczynski",team:"Minnesota Timberwolves",outlet:"The Athletic",tier:1,signal:"High",conf:"W"},
  {name:"Dane Moore",handle:"DaneMooreNBA",team:"Minnesota Timberwolves",outlet:"Dane Moore NBA Podcast",tier:2,signal:"High",conf:"W"},
  {name:"Jace Frederick",handle:"JaceFrederick",team:"Minnesota Timberwolves",outlet:"Pioneer Press",tier:2,signal:"Medium",conf:"W"},
  {name:"Kelly Vogel",handle:"KellyVogelNBA",team:"Minnesota Timberwolves",outlet:"KSTP",tier:2,signal:"Medium",conf:"W"},
  {name:"Michael Rand",handle:"RandBall",team:"Minnesota Timberwolves",outlet:"Minneapolis Star Tribune",tier:2,signal:"Medium",conf:"W"},
  {name:"Tina Winder",handle:"TinaWinder",team:"Minnesota Timberwolves",outlet:"Bally Sports North",tier:2,signal:"Medium",conf:"W"},
  {name:"Jim Eichenhofer",handle:"Jim_Eichenhofer",team:"New Orleans Pelicans",outlet:"Pelicans.com",tier:1,signal:"High",conf:"W"},
  {name:"Will Guillory",handle:"WillGuillory",team:"New Orleans Pelicans",outlet:"The Athletic",tier:1,signal:"High",conf:"W"},
  {name:"Andrew Lopez",handle:"_Andrew_Lopez",team:"New Orleans Pelicans",outlet:"ESPN",tier:2,signal:"High",conf:"W"},
  {name:"Christian Clark",handle:"cclark_13",team:"New Orleans Pelicans",outlet:"New Orleans Times-Picayune",tier:2,signal:"High",conf:"W"},
  {name:"Oleh Kosel",handle:"OlehKosel",team:"New Orleans Pelicans",outlet:"The Bird Writes",tier:2,signal:"Medium",conf:"W"},
  {name:"Rod Walker",handle:"RodWalkerNBA",team:"New Orleans Pelicans",outlet:"New Orleans Advocate",tier:2,signal:"Medium",conf:"W"},
  {name:"Brandon Rahbar",handle:"BrandonRahbar",team:"Oklahoma City Thunder",outlet:"Daily Thunder",tier:1,signal:"High",conf:"W"},
  {name:"Joel Lorenzi",handle:"jxlorenzi",team:"Oklahoma City Thunder",outlet:"The Oklahoman",tier:1,signal:"High",conf:"W"},
  {name:"Rylan Stiles",handle:"Rylan_Stiles",team:"Oklahoma City Thunder",outlet:"Inside The Thunder / Locked On",tier:1,signal:"High",conf:"W"},
  {name:"Joe Mussatto",handle:"JoeMussattoSCR",team:"Oklahoma City Thunder",outlet:"The Oklahoman",tier:2,signal:"Medium",conf:"W"},
  {name:"Justin Martinez",handle:"JMartNBA",team:"Oklahoma City Thunder",outlet:"The Oklahoman",tier:2,signal:"High",conf:"W"},
  {name:"Michael Martin",handle:"MichaelOnSports",team:"Oklahoma City Thunder",outlet:"Self Employed",tier:3,signal:"Medium",conf:"W"},
  {name:"Duane Rankin",handle:"DuaneRankin",team:"Phoenix Suns",outlet:"Arizona Republic",tier:1,signal:"High",conf:"W"},
  {name:"Gerald Bourguet",handle:"GeraldBourguet",team:"Phoenix Suns",outlet:"PHNX Media",tier:1,signal:"High",conf:"W"},
  {name:"Bo Brack",handle:"BoBrack",team:"Phoenix Suns",outlet:"PHNX Sports",tier:2,signal:"Medium",conf:"W"},
  {name:"John Gambadoro",handle:"Gambo987",team:"Phoenix Suns",outlet:"Arizona Sports 98.7",tier:2,signal:"Medium",conf:"W"},
  {name:"Kellan Olson",handle:"kellanolson",team:"Phoenix Suns",outlet:"Arizona Republic",tier:2,signal:"High",conf:"W"},
  {name:"Ty Tasker",handle:"TyTasker",team:"Phoenix Suns",outlet:"PHNX Sports",tier:2,signal:"Medium",conf:"W"},
  {name:"Casey Holdahl",handle:"CHold",team:"Portland Trail Blazers",outlet:"TrailBlazers.com",tier:1,signal:"High",conf:"W"},
  {name:"Jason Quick",handle:"jwquick",team:"Portland Trail Blazers",outlet:"The Athletic",tier:1,signal:"High",conf:"W"},
  {name:"Aaron Fentress",handle:"AaronJFentress",team:"Portland Trail Blazers",outlet:"The Oregonian",tier:2,signal:"Medium",conf:"W"},
  {name:"Jamie Hudson",handle:"JamieHudson_",team:"Portland Trail Blazers",outlet:"NBC Sports Northwest",tier:2,signal:"Medium",conf:"W"},
  {name:"Joe Freeman",handle:"BlazerFreeman",team:"Portland Trail Blazers",outlet:"The Oregonian",tier:2,signal:"Medium",conf:"W"},
  {name:"Kerry Eggers",handle:"KerryEggers",team:"Portland Trail Blazers",outlet:"Portland Tribune",tier:2,signal:"Medium",conf:"W"},
  {name:"Sean Highkin",handle:"highkin",team:"Portland Trail Blazers",outlet:"Rose Garden Report",tier:2,signal:"High",conf:"W"},
  {name:"James Ham",handle:"James_HamNBA",team:"Sacramento Kings",outlet:"NBC Sports California",tier:1,signal:"High",conf:"W"},
  {name:"Jason Anderson",handle:"JandersonSacBee",team:"Sacramento Kings",outlet:"Sacramento Bee",tier:1,signal:"High",conf:"W"},
  {name:"Brenden Nunes",handle:"BrendenNunesNBA",team:"Sacramento Kings",outlet:"Sactown Sports 1140",tier:2,signal:"Medium",conf:"W"},
  {name:"Frankie Cartoscelli",handle:"FCartoscelli3",team:"Sacramento Kings",outlet:"Sactown Sports 1140",tier:2,signal:"Medium",conf:"W"},
  {name:"Matt George",handle:"MattGeorge975",team:"Sacramento Kings",outlet:"95.7 The Game / KHTK",tier:2,signal:"Medium",conf:"W"},
  {name:"Mike Richman",handle:"MikeRichman",team:"Sacramento Kings",outlet:"Kings.com",tier:2,signal:"High",conf:"W"},
  {name:"Mychael Urban",handle:"MychealUrban",team:"Sacramento Kings",outlet:"NBC Sports California",tier:2,signal:"Medium",conf:"W"},
  {name:"Sean Cunningham",handle:"seancunningham45",team:"Sacramento Kings",outlet:"ABC10 Sacramento",tier:2,signal:"High",conf:"W"},
  {name:"Jeff McDonald",handle:"JMcDonald_SAEN",team:"San Antonio Spurs",outlet:"San Antonio Express-News",tier:1,signal:"High",conf:"W"},
  {name:"Tom Orsborn",handle:"tom_orsborn",team:"San Antonio Spurs",outlet:"San Antonio Express-News",tier:1,signal:"High",conf:"W"},
  {name:"Damian Arseneault",handle:"DamianArseneault",team:"San Antonio Spurs",outlet:"The Athletic",tier:2,signal:"High",conf:"W"},
  {name:"Jabari Young",handle:"JabariJYoung",team:"San Antonio Spurs",outlet:"CNBC / Sports Business",tier:2,signal:"Medium",conf:"W"},
  {name:"Mike Finger",handle:"mikefinger",team:"San Antonio Spurs",outlet:"San Antonio Express-News",tier:2,signal:"Medium",conf:"W"},
  {name:"Paul Garcia",handle:"PaulGarciaNBA",team:"San Antonio Spurs",outlet:"Project Spurs / Locked On",tier:2,signal:"High",conf:"W"},
  {name:"Andy Larsen",handle:"andyblarsen",team:"Utah Jazz",outlet:"Salt Lake Tribune",tier:1,signal:"High",conf:"W"},
  {name:"Eric Walden",handle:"tribjazz",team:"Utah Jazz",outlet:"Salt Lake Tribune",tier:1,signal:"High",conf:"W"},
  {name:"David Locke",handle:"DLocke_Jazz",team:"Utah Jazz",outlet:"Jazz Radio / KSL",tier:2,signal:"Medium",conf:"W"},
  {name:"Jody Genessy",handle:"DJJazzyJody",team:"Utah Jazz",outlet:"Deseret News",tier:2,signal:"High",conf:"W"},
  {name:"Sarah Todd",handle:"NBASarah",team:"Utah Jazz",outlet:"KSL Sports",tier:2,signal:"High",conf:"W"},
  {name:"Kevin Reynolds",handle:"Kevinreynolds30",team:"Utah Jazz",outlet:"Salt Lake Tribune",tier:3,signal:"Medium",conf:"W"}
];

const REPORTER_MAP = {};
REPORTERS.forEach(r => { REPORTER_MAP[r.handle.toLowerCase()] = r; });

// ─── INJURY KEYWORDS ──────────────────────────────────────────────────────────
const INJURY_KEYWORDS = [
  'out tonight','ruled out','will not play',"won't play",'wont play','not playing',
  'did not practice','dnp','scratched','questionable','doubtful','probable','gtd',
  'game-time','listed as','on the injury report','load management','knee','ankle',
  'hamstring','achilles','back injury','shoulder','hip','groin','calf','foot injury',
  'wrist','elbow','quad','concussion','illness','sore','soreness','sprain','strain',
  'day-to-day','week-to-week','out indefinitely',
];
function isInjuryTweet(text) {
  const t = text.toLowerCase();
  return INJURY_KEYWORDS.some(k => t.includes(k));
}

function extractStatus(text) {
  const t = text.toLowerCase();
  if (/ruled out|will not play|won'?t play|\bis out\b|out tonight|not playing|scratched|\bdnp\b/.test(t)) return 'Out';
  if (/doubtful/.test(t)) return 'Doubtful';
  if (/game.time decision|\bgtd\b/.test(t)) return 'Game-Time Decision';
  if (/questionable|\bq\b.*tonight/.test(t)) return 'Questionable';
  if (/probable/.test(t)) return 'Probable';
  return 'Questionable';
}

function extractBodyPart(text) {
  const t = text.toLowerCase();
  const parenMatch = t.match(/\(([^)]{3,30})\)/);
  const parts = ['achilles','hamstring','quadricep','quad','meniscus','ligament','tendon',
    'ankle','knee','back','shoulder','hip','groin','calf','foot','wrist','elbow','hand',
    'concussion','illness','shin','toe','finger','neck','chest','rib','acl','mcl','pcl'];
  if (parenMatch) {
    const found = parts.find(p => parenMatch[1].includes(p));
    if (found) return found;
  }
  return parts.find(p => t.includes(p)) || 'undisclosed';
}

function extractInjuryType(text) {
  const t = text.toLowerCase();
  if (/acl|anterior cruciate/.test(t)) return 'ACL';
  if (/mcl/.test(t)) return 'MCL';
  if (/pcl/.test(t)) return 'PCL';
  if (/sprain/.test(t)) return 'Sprain';
  if (/strain/.test(t)) return 'Strain';
  if (/fracture|broken|break/.test(t)) return 'Fracture';
  if (/tendon|tendinitis|tendinopathy/.test(t)) return 'Tendon';
  if (/soreness|sore/.test(t)) return 'Soreness';
  if (/tightness|tight/.test(t)) return 'Tightness';
  if (/concussion/.test(t)) return 'Concussion';
  if (/illness|sick|flu|cold/.test(t)) return 'Illness';
  if (/contusion|bruise/.test(t)) return 'Contusion';
  if (/load management|rest/.test(t)) return 'Load Management';
  return 'Undisclosed';
}

/**
 * extractMultiplePlayers — parses a tweet that mentions multiple players
 * with potentially different statuses.
 *
 * Returns array of { player, status, body_part, injury_type, cleared }
 * "cleared" = true means the player was cleared/removed from injury report.
 *
 * Examples handled:
 *   "Kawhi is questionable. Mathurin is cleared to play."
 *   "Kawhi Leonard (knee) is OUT. Jordan Miller is questionable with back soreness."
 *   "Mathurin and Collins are no longer on the injury report."
 */
function extractMultiplePlayers(text) {
  const CLEARED_PATTERN = /no longer on the injury report|cleared to play|cleared to return|removed from the injury report|not on the injury report|available to play/i;

  // Split on sentence boundaries and "also" conjunctions
  const segments = text
    .split(/(?<=[.!?])\s+|(?:\band\b(?=\s+[A-Z]))/g)
    .map(s => s.trim())
    .filter(s => s.length > 5);

  const results = [];

  for (const seg of segments) {
    // Check if this segment clears multiple players: "Mathurin and Collins are no longer..."
    if (CLEARED_PATTERN.test(seg)) {
      // Find all player names in this segment
      const combined = { ...ROSTER_FALLBACK, ...rosterCache };
      for (const name of Object.keys(combined)) {
        if (name.length < 5) continue;
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`\\b${escaped}\\b`, 'i').test(seg)) {
          results.push({ player: name, status: 'Available', body_part: 'undisclosed', injury_type: 'Undisclosed', cleared: true });
        }
      }
      continue;
    }

    // Normal injury segment — extract one player + status
    const player = extractPlayer(seg);
    if (!player) continue;

    const status     = extractStatus(seg);
    const body_part  = extractBodyPart(seg);
    const injury_type = extractInjuryType(seg);

    results.push({ player, status, body_part, injury_type, cleared: false });
  }

  // Deduplicate by player name (last mention wins)
  const seen = new Map();
  for (const r of results) seen.set(r.player.toLowerCase(), r);
  return [...seen.values()];
}

function extractPlayer(text) {
  // Build a combined lookup: ROSTER_FALLBACK is always available immediately on startup.
  // rosterCache is populated once balldontlie loads. Use both.
  const combined = { ...ROSTER_FALLBACK, ...rosterCache };

  // ── Step 1: Direct roster scan — whole-word match against all known players ──
  // This is the most reliable method. If we find a match, use it immediately.
  for (const name of Object.keys(combined)) {
    if (name.length < 5) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(text)) return name;
  }

  // ── Step 2: Regex extraction — ONLY accepted if it matches a known player ────
  // We use regex to find candidate names, but REJECT any result not in the roster.
  // This prevents garbage like "No. Just", "He Will", "Out Tonight" from appearing.
  const skipStart = /^(The|This|He|She|They|We|His|Her|Their|Per|Via|From|With|For|Breaking|Sources|Report|Update|According|It|In|At|No\b|NBA|League|Official|Team|Head|UPDATE|BREAKING|Just|Out|Game|Tonight|Today|Now|Here|After|Before|During|Without|Against|Between|All|Both|Neither|Each|Every|Some|Any|More|Most|Less|Few|Several|Many|Such|Other|Same|Next|Last|Another|One|Two|Three|First|Second|Third)/i;

  const patterns = [
    /^([A-Z][a-záàâäéèêëíìîïóòôöõúùûüñç'.-]+(?:\s+[A-Z][a-záàâäéèêëíìîïóòôöõúùûüñç'.-]+){1,2})\s*\(/,
    /^([A-Z][a-záàâäéèêëíìîïóòôöõúùûüñç'.-]+(?:\s+[A-Z][a-záàâäéèêëíìîïóòôöõúùûüñç'.-]+){1,2})\s+(?:is|will|won'?t|has|was|did)\b/,
    /([A-Z][a-z'.-]+(?:\s+[A-Z][a-z'.-]+){1,2})\s+(?:ruled out|out tonight|is questionable|is doubtful|is probable|listed as|will not play|won'?t play|has been ruled)/i,
    /([A-Z][a-z'.-]+(?:\s+[A-Z][a-z'.-]+){1,2})\s+(?:–|—|-)\s+(?:ankle|knee|quad|hamstring|achilles|back|shoulder|hip|calf|wrist|hand|foot)/i,
  ];

  for (const p of patterns) {
    const m = text.match(p);
    if (!m?.[1]) continue;
    const name = m[1].trim();
    if (skipStart.test(name)) continue;
    const parts = name.split(' ');
    if (parts.length < 2) continue;

    // Strict: only accept if this name exists in our roster
    if (isKnownPlayer(name)) return name;

    // Also try normalizing accents and checking again
    const normalized = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (isKnownPlayer(normalized)) return normalized;
  }

  // If we reach here, we couldn't find a verified player — return null.
  // A skipped report is always better than a wrong player name.
  return null;
}

/**
 * calcConfidence — returns a score 0–99 (integer)
 *
 * Eight distinct factors, each independently weighted and reasoned:
 *
 *  1. Reporter tier        (0–30)  Primary source credibility
 *  2. Outlet credibility   (0–15)  Publication strength
 *  3. Status severity      (0–15)  How definitive is the designation
 *  4. Language precision   (0–12)  Specificity of tweet wording
 *  5. Injury specificity   (0–8)   Named body part vs undisclosed
 *  6. Injury type          (0–5)   Structural vs load management vs unknown
 *  7. Corroboration        (0–10)  Independent reporters confirming
 *  8. Recency context      (0–4)   Prior reports for this player (pattern)
 *
 * Max possible: 99. Hard-capped there.
 */
function calcConfidence(reporter, status, tweetText = '', corrobCount = 0, opts = {}) {
  const tw = (tweetText || '').toLowerCase();

  // ── 1. Reporter tier (0–30) ──────────────────────────────────────────────────
  // Tier 1 = primary beat writers with direct locker room access
  // Tier 2 = secondary beat, national contributors
  // Tier 3 = digital/aggregator, limited access
  const tierPts = reporter.tier === 1 ? 30 : reporter.tier === 2 ? 19 : 8;

  // ── 2. Outlet credibility (0–15) ─────────────────────────────────────────────
  // Weighted by editorial standards, not follower count
  const outlet = (reporter.outlet || '').toLowerCase();
  let outletPts = 8; // baseline
  if (/\bespn\b/.test(outlet))                             outletPts = 15;
  else if (/the athletic/.test(outlet))                    outletPts = 15;
  else if (/\bap\b|associated press/.test(outlet))         outletPts = 14;
  else if (/nba\.com|pelicans\.com|blazers\.com|team site/.test(outlet)) outletPts = 13;
  else if (/bleacher|yahoo sports|si\.com/.test(outlet))  outletPts = 11;
  else if (/herald|chronicle|times|globe|post|inquirer|tribune|sentinel|star|bee|plain dealer|morning news/.test(outlet)) outletPts = 12;
  else if (/sportsnet|tsn|nbc sports|bally|spectrum/.test(outlet)) outletPts = 11;
  else if (/clutchpoints|dnvr|the ringer|substack|independent/.test(outlet)) outletPts = 9;

  // ── 3. Status severity (0–15) ────────────────────────────────────────────────
  // "Out" is the most actionable and definitive — score it highest
  const statusPts = {
    'Out':                 15,
    'Doubtful':            12,
    'Game-Time Decision':  10,
    'Questionable':         8,
    'Probable':             5,
  }[status] ?? 7;

  // ── 4. Language precision (0–12) ─────────────────────────────────────────────
  // Specific authoritative language → higher score
  let langPts = 4; // baseline: vague tweet
  if (/ruled out|will not play|won'?t play|is out\b|out tonight|not playing|scratched|\bdnp\b/.test(tw)) langPts = 12;
  else if (/doubtful|highly unlikely/.test(tw))               langPts = 10;
  else if (/game.time decision|\bgtd\b/.test(tw))             langPts = 9;
  else if (/questionable/.test(tw))                           langPts = 8;
  else if (/probable|expected to play|trending/.test(tw))     langPts = 6;
  else if (/limited|did not practice|sat out|missed/.test(tw)) langPts = 7;
  // Official language boosts precision
  if (/official injury report|listed as|on the injury report/.test(tw)) langPts = Math.min(12, langPts + 2);
  // First-person sourcing ("I'm told", "sources say", confirmed) boosts
  if (/i'?m told|sources say|has confirmed|confirmed:|breaking:/.test(tw)) langPts = Math.min(12, langPts + 1);

  // ── 5. Injury specificity (0–8) ──────────────────────────────────────────────
  // Named + specific body part > general body area > undisclosed
  let injPts = 0;
  if (/\(ankle\)|\(knee\)|\(hamstring\)|\(achilles\)|\(back\)|\(shoulder\)|\(hip\)|\(quad\)|\(calf\)|\(wrist\)|\(hand\)|\(foot\)/.test(tw)) {
    injPts = 8; // parenthetical format = official injury report language
  } else if (/ankle|knee|hamstring|achilles|shoulder|hip|quad|calf|wrist|hand|foot|elbow|groin|shin|toe|finger|neck|concussion/.test(tw)) {
    injPts = 6; // named body part
  } else if (/back|illness|personal/.test(tw)) {
    injPts = 4; // broad category
  } else if (/undisclosed|injury/.test(tw)) {
    injPts = 2; // known injured, undisclosed reason
  }

  // ── 6. Injury type context (0–5) ─────────────────────────────────────────────
  // Structural injuries are more credible/serious when reported
  // Load management is deliberate and usually confirmed
  let injTypePts = 2; // baseline
  if (/acl|mcl|achilles|fracture|broken|torn/.test(tw))           injTypePts = 5; // serious structural
  else if (/load management|rest|planned/.test(tw))                injTypePts = 5; // deliberate — near-certain
  else if (/sprain|strain|tendon|concussion/.test(tw))            injTypePts = 4;
  else if (/soreness|sore|tightness|tight/.test(tw))              injTypePts = 3;
  else if (/illness|sick|personal/.test(tw))                      injTypePts = 3;

  // ── 7. Corroboration (0–10) ──────────────────────────────────────────────────
  // Each independent reporter adds weight, diminishing returns after 3
  const corrPts = corrobCount === 0 ? 0
    : corrobCount === 1 ? 5
    : corrobCount === 2 ? 8
    : 10;

  // ── 8. Recency/pattern context (0–4) ─────────────────────────────────────────
  // If this player has a recent injury history, the report is more credible
  // opts.daysSinceLastReport: null = no history, 0 = same day, 1-3 = recent, etc.
  let recencyPts = 0;
  const days = opts.daysSinceLastReport;
  if (days === 0)                    recencyPts = 4; // same-day repeat = very credible
  else if (days !== null && days <= 3) recencyPts = 3; // recent pattern
  else if (days !== null && days <= 7) recencyPts = 2; // known injury history
  else if (days !== null && days <= 14) recencyPts = 1; // older history

  const total = tierPts + outletPts + statusPts + langPts + injPts + injTypePts + corrPts + recencyPts;
  return Math.min(total, 99);
}

/**
 * Returns a breakdown object for frontend display
 */
function confBreakdownServer(reporter, status, tweetText = '', corrobCount = 0, opts = {}) {
  const tw = (tweetText || '').toLowerCase();
  const outlet = (reporter.outlet || '').toLowerCase();

  const tier    = reporter.tier === 1 ? 30 : reporter.tier === 2 ? 19 : 8;
  let outletPts = 8;
  if (/\bespn\b|the athletic/.test(outlet)) outletPts = 15;
  else if (/\bap\b|associated press/.test(outlet)) outletPts = 14;
  else if (/herald|chronicle|times|globe|post|inquirer|tribune|sentinel|star|bee|plain dealer/.test(outlet)) outletPts = 12;
  else if (/sportsnet|tsn|nbc sports|bally|spectrum/.test(outlet)) outletPts = 11;

  const statusPts = {Out:15,Doubtful:12,'Game-Time Decision':10,Questionable:8,Probable:5}[status] ?? 7;

  let langPts = 4;
  if (/ruled out|will not play|won'?t play|is out\b|out tonight/.test(tw)) langPts = 12;
  else if (/doubtful/.test(tw)) langPts = 10;
  else if (/game.time|\bgtd\b/.test(tw)) langPts = 9;
  else if (/questionable/.test(tw)) langPts = 8;
  else if (/limited|did not practice/.test(tw)) langPts = 7;
  else if (/probable/.test(tw)) langPts = 6;

  let injPts = 0;
  if (/\((ankle|knee|hamstring|achilles|back|shoulder|hip|quad|calf|wrist|hand|foot)\)/.test(tw)) injPts = 8;
  else if (/ankle|knee|hamstring|achilles|shoulder|hip|quad|calf|wrist|hand|foot|elbow|groin|concussion/.test(tw)) injPts = 6;
  else if (/back|illness|personal/.test(tw)) injPts = 4;
  else if (/undisclosed|injury/.test(tw)) injPts = 2;

  let injTypePts = 2;
  if (/acl|mcl|achilles|fracture|broken|torn/.test(tw)) injTypePts = 5;
  else if (/load management|rest|planned/.test(tw)) injTypePts = 5;
  else if (/sprain|strain|tendon|concussion/.test(tw)) injTypePts = 4;
  else if (/soreness|tightness/.test(tw)) injTypePts = 3;

  const corrPts = corrobCount === 0 ? 0 : corrobCount === 1 ? 5 : corrobCount === 2 ? 8 : 10;

  const days = opts.daysSinceLastReport;
  const recencyPts = days === 0 ? 4 : days !== null && days <= 3 ? 3 : days !== null && days <= 7 ? 2 : days !== null && days <= 14 ? 1 : 0;

  return { tier, outlet: outletPts, status: statusPts, lang: langPts, injury: injPts, injType: injTypePts, corr: corrPts, recency: recencyPts };
}

// ─── DB HELPERS ───────────────────────────────────────────────────────────────
async function getPrevStatus(player) {
  if (!pool) return null;
  try {
    const res = await pool.query(
      `SELECT status FROM injury_reports WHERE player = $1 ORDER BY time_of_report DESC LIMIT 1`,
      [player]
    );
    return res.rows[0]?.status || null;
  } catch { return null; }
}

async function getDaysSinceLastReport(player) {
  if (!pool) return null;
  try {
    const res = await pool.query(
      `SELECT time_of_report FROM injury_reports WHERE player = $1 ORDER BY time_of_report DESC LIMIT 1`,
      [player]
    );
    if (!res.rows[0]) return null;
    const diffMs = Date.now() - new Date(res.rows[0].time_of_report).getTime();
    return Math.floor(diffMs / 86400000);
  } catch { return null; }
}

async function saveReport(r) {
  if (!pool) return;
  try {
    await pool.query(`
      INSERT INTO injury_reports
        (tweet_id, player, position, team, status, injury_type, body_part,
         matchup, game_date, game_time, reporter, outlet, tier, confidence,
         time_of_report, prev_status, days_since_last_report, tweet_text, corroborators, corrob_tweets)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
      ON CONFLICT (tweet_id) DO NOTHING
    `, [
      r.tweet_id, r.player, r.position, r.team, r.status, r.injury_type, r.body_part,
      r.matchup, r.game_date, r.game_time, r.reporter, r.outlet, r.tier, r.confidence,
      r.time_of_report, r.prev_status, r.days_since_last_report, r.tweet_text,
      r.corroborators || [],
      JSON.stringify(r.corrobTweets || []),
    ]);
  } catch (err) {
    console.error('[DB] Save error:', err.message);
  }
}

async function loadRecentFromDB(hours = 24) {
  if (!pool) return [];
  try {
    const res = await pool.query(`
      SELECT * FROM injury_reports
      WHERE time_of_report > NOW() - INTERVAL '${hours} hours'
      ORDER BY time_of_report DESC
      LIMIT 500
    `);
    return res.rows;
  } catch (err) {
    console.error('[DB] Load error:', err.message);
    return [];
  }
}

// ─── IN-MEMORY CACHE ──────────────────────────────────────────────────────────
let injuryCache = [];
const seenTweetIds = new Set();

// ─── POLLING ──────────────────────────────────────────────────────────────────
const TWEETAPI_KEY = process.env.TWEETAPI_KEY;

async function poll() {
  if (!TWEETAPI_KEY) { console.log('[Poll] No TWEETAPI_KEY — skipping'); return; }

  // Refresh roster daily, schedule each poll (cached internally for 1hr/24hr)
  await fetchRoster();
  await fetchSchedule();

  const tier1 = REPORTERS.filter(r => r.tier === 1).map(r => `from:${r.handle}`).join(' OR ');
  const injuryQ = '(out tonight OR questionable OR "game-time" OR "ruled out" OR "will not play" OR doubtful OR GTD OR probable OR "load management" OR ankle OR knee OR hamstring OR quad OR achilles OR concussion OR illness OR soreness)';
  const query = `(${tier1}) ${injuryQ} -is:retweet lang:en`;

  let allTweets = [], cursor = null;
  for (let page = 0; page < 3; page++) {
    try {
      const params = { query, type: 'Latest' };
      if (cursor) params.cursor = cursor;
      const res = await axios.get('https://api.tweetapi.com/tw-v2/search', {
        headers: { 'X-API-Key': TWEETAPI_KEY },
        params, timeout: 15000,
      });
      const tweets = res.data?.data || [];
      allTweets = allTweets.concat(tweets);
      cursor = res.data?.next_cursor || res.data?.cursor || null;
      if (!cursor || !tweets.length) break;
      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      console.error('[Poll] TweetAPI error:', err.response?.data || err.message);
      break;
    }
  }

  let found = 0;
  for (const tweet of allTweets) {
    if (seenTweetIds.has(tweet.id)) continue;
    if (!isInjuryTweet(tweet.text)) continue;

    const authorHandle = (tweet.author?.username || '').toLowerCase();
    const reporter = REPORTER_MAP[authorHandle];
    if (!reporter) continue;

    seenTweetIds.add(tweet.id);

    // Extract all player/status pairs from this tweet
    const extractions = extractMultiplePlayers(tweet.text);
    if (extractions.length === 0) continue;

    const tweetTime = tweet.created_at ? new Date(tweet.created_at) : new Date();

    for (const extraction of extractions) {
      const { player, status, body_part, injury_type, cleared } = extraction;

      // If player is cleared, remove any matching active report from cache
      if (cleared) {
        const idx = injuryCache.findIndex(r =>
          r.player?.toLowerCase() === player.toLowerCase() &&
          r.team === (getRosterEntry(player)?.team || reporter.team)
        );
        if (idx !== -1) {
          console.log(`  [Cleared] ${player} removed from injury report`);
          injuryCache.splice(idx, 1);
        }
        continue;
      }

      // Use live roster for authoritative team/position
      const rosterEntry = getRosterEntry(player);
      const position  = normalizePosition(rosterEntry?.position, player) || null;
      const team      = rosterEntry?.team
        || (reporter.team === 'All Teams' ? 'Unknown' : reporter.team);

      // Look up history for this player — must happen before calcConfidence
      const [prev_status, days_since_last_report] = await Promise.all([
        getPrevStatus(player),
        getDaysSinceLastReport(player),
      ]);

      const confidence = calcConfidence(reporter, status, tweet.text, 0, { daysSinceLastReport: days_since_last_report });
      const gameInfo  = getGameInfo(team, tweet.text, tweetTime);

      // Use a composite tweet_id for multi-player tweets to avoid DB conflicts
      const tweet_id = extractions.length > 1 ? `${tweet.id}_${player.replace(/\s+/g, '_')}` : tweet.id;

      const report = {
        tweet_id,
        player,
        position,
        team,
        status,
        injury_type,
        body_part,
        matchup:     gameInfo.matchup,
        game_date:   gameInfo.game_date,
        game_time:   gameInfo.game_time,
        in_game:     gameInfo.in_game || false,
        reporter:    reporter.name,
        outlet:      reporter.outlet,
        tier:        reporter.tier,
        confidence,
        time_of_report: tweetTime.toISOString(),
        prev_status,
        days_since_last_report,
        tweet_text:  tweet.text,
        corroborators: [],
        corrobTweets: [],
        handle:      '@' + reporter.handle,
        injury:      `${injury_type !== 'Undisclosed' ? injury_type + ' — ' : ''}${body_part}`,
        body:        body_part,
        timestamp:   tweetTime.toISOString(),
        tweetId:     tweet.id, // always link to original tweet
      };

    // ── One card per player per game_date ────────────────────────────────────
    // Any tweet about the same player for the same game day merges into one card.
    // If the status is an upgrade (e.g. Q → Out), update the card's status.
    // All contributing tweets are stored in corrobTweets for display.
    const SIX_HOURS = 6 * 60 * 60 * 1000;

    // Status severity — higher = more definitive
    const statusSeverity = s => ({ 'Out': 4, 'Doubtful': 3, 'Game-Time Decision': 2, 'Questionable': 1, 'Probable': 0 }[s] ?? 1);

    const existing = injuryCache.find(r =>
      r.player && player &&
      r.player.toLowerCase() === player.toLowerCase() &&
      r.team === team &&
      r.game_date !== null && gameInfo.game_date !== null &&
      r.game_date === gameInfo.game_date
    );

    if (existing) {
      // Always add this tweet to the card's tweet history
      existing.corrobTweets = existing.corrobTweets || [];
      const alreadyLinked = existing.corrobTweets.some(ct => ct.tweetId === tweet.id);

      if (!alreadyLinked) {
        existing.corrobTweets.push({
          reporter:  reporter.name,
          handle:    '@' + reporter.handle,
          tweet:     tweet.text,
          tweetId:   tweet.id,
          outlet:    reporter.outlet,
          tier:      reporter.tier,
          status,                             // what this tweet reported
          timestamp: tweetTime.toISOString(),
        });
        seenTweetIds.add(tweet.id);

        // Update status if this tweet reports something more definitive
        const upgraded = statusSeverity(status) > statusSeverity(existing.status);
        if (upgraded) {
          console.log(`  [Status↑] ${player}: ${existing.status} → ${status} (per ${reporter.name})`);
          existing.status    = status;
          existing.reporter  = reporter.name;  // most recent authoritative source
          existing.handle    = '@' + reporter.handle;
          existing.outlet    = reporter.outlet;
          existing.tier      = reporter.tier;
          existing.tweet_text = tweet.text;
          if (body_part && body_part !== 'undisclosed') existing.body_part = body_part;
          if (injury_type && injury_type !== 'Undisclosed') existing.injury_type = injury_type;
        }

        if (!existing.corroborators.includes(reporter.name)) {
          existing.corroborators.push(reporter.name);
        }

        // Recalculate confidence with updated corroboration + possible status upgrade
        const existingReporter = REPORTERS.find(r => r.name === existing.reporter)
          || { tier: existing.tier || 2, signal: 'Medium', outlet: existing.outlet || '' };
        existing.confidence = calcConfidence(
          existingReporter, existing.status, existing.tweet_text,
          existing.corroborators.length,
          { daysSinceLastReport: existing.days_since_last_report }
        );

        // Persist full update to DB
        await pool?.query(
          `UPDATE injury_reports
           SET corroborators = $1, corrob_tweets = $2, confidence = $3,
               status = $4, reporter = $5, tweet_text = $6
           WHERE tweet_id = $7`,
          [
            existing.corroborators,
            JSON.stringify(existing.corrobTweets),
            existing.confidence,
            existing.status,
            existing.reporter,
            existing.tweet_text,
            existing.tweet_id,
          ]
        );

        console.log(`  [+Tweet] ${reporter.name} → "${player}" (${status}) | ${existing.corrobTweets.length} tweets total`);
      } else {
        console.log(`  [Skip dupe] tweet ${tweet.id} already linked to ${player}`);
      }
      continue;
    }

    // New report — include the primary tweet in corrobTweets too so the
    // frontend always has a consistent array to render from
    report.corrobTweets = [{
      reporter: reporter.name,
      handle:   '@' + reporter.handle,
      tweet:    tweet.text,
      tweetId:  tweet.id,
      outlet:   reporter.outlet,
      tier:     reporter.tier,
      timestamp: tweetTime.toISOString(),
    }];

    injuryCache.unshift(report);
    await saveReport(report);
    found++;
    } // end inner for (extraction of extractions)
  } // end outer for (tweet of allTweets)

  // Prune memory to last 24h
  const cutoff = Date.now() - 86400000;
  injuryCache = injuryCache.filter(r => new Date(r.time_of_report).getTime() > cutoff);

  console.log(`[Poll ${new Date().toISOString()}] +${found} new (${injuryCache.length} cached)`);
}

// ─── API ROUTES ───────────────────────────────────────────────────────────────
// Optional API key check
function auth(req, res, next) {
  const key = process.env.API_KEY;
  if (!key) return next(); // no key set = open
  const provided = req.headers['x-api-key'] || req.query.key;
  if (provided !== key) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── Roster proxy — dashboard fetches this to build its player lookup dynamically
app.get('/proxy/roster', async (req, res) => {
  // Ensure roster is loaded
  if (!Object.keys(rosterCache).length) await fetchRoster();
  const data = Object.keys(rosterCache).length ? rosterCache : ROSTER_FALLBACK;
  res.json({ roster: data, count: Object.keys(data).length, fetched_at: rosterFetchedAt });
});

// ── Schedule proxy — dashboard fetches this for matchup/game time per team
app.get('/proxy/schedule', async (req, res) => {
  if (!Object.keys(scheduleCache).length) await fetchSchedule();
  res.json({ schedule: scheduleCache, fetched_at: scheduleFetchedAt });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    cached: injuryCache.length,
    db: !!pool,
    schedule: Object.keys(scheduleCache).length > 0,
    lastPoll: new Date().toISOString(),
  });
});

// Live feed — last 24h, newest first (dashboard compatible)
app.get('/v1/injuries/live', auth, (req, res) => {
  const statusOrder = { Out: 0, Doubtful: 1, Questionable: 2, 'Game-Time Decision': 3, Probable: 4 };

  // Merge official NBA injury report entries with tweet-based reports
  // Official entries take the form of scraper data — convert to card format
  const official = getOfficialCache();
  const officialCards = official.entries
    .filter(e => e.current_status) // already filtered G-League in scraper
    .map(e => ({
      tweet_id:    `official_${e.player}_${e.game_date}`,
      player:      e.player,
      team:        e.team,
      status:      e.current_status,
      body_part:   e.reason || null,
      injury_type: e.reason || null,
      matchup:     e.matchup || null,
      game_date:   e.game_date || null,
      game_time:   e.game_time || null,
      reporter:    'NBA Official Report',
      handle:      '@NBA',
      outlet:      'official.nba.com',
      tier:        1,
      confidence:  64, // official reports are high signal but no tweet precision
      time_of_report: e.report_time || new Date(),
      tweet_text:  e.reason || '',
      corroborators: [],
      corrobTweets: [],
      source:      'official',
      report_url:  e.report_url || null,
      in_game:     false,
    }));

  // Merge: tweet reports take priority over official for same player+game_date
  const tweetPlayerDates = new Set(
    injuryCache.map(r => `${r.player}|${r.game_date}`)
  );
  const officialOnly = officialCards.filter(
    e => !tweetPlayerDates.has(`${e.player}|${e.game_date}`)
  );

  const combined = [...injuryCache, ...officialOnly];
  const sorted = combined.sort((a, b) =>
    (statusOrder[a.status] ?? 5) - (statusOrder[b.status] ?? 5) || b.confidence - a.confidence
  );
  res.json({ injuries: sorted, count: sorted.length, as_of: new Date() });
});

// Full historical query endpoint
app.get('/v1/injuries/history', auth, async (req, res) => {
  if (!pool) return res.json({ injuries: [], count: 0, note: 'No database connected' });
  try {
    const { player, team, status, days = 7, limit = 200 } = req.query;
    let where = [`time_of_report > NOW() - INTERVAL '${parseInt(days)} days'`];
    const vals = [];
    if (player) { vals.push(player); where.push(`player ILIKE $${vals.length}`); }
    if (team)   { vals.push(team);   where.push(`team ILIKE $${vals.length}`); }
    if (status) { vals.push(status); where.push(`status = $${vals.length}`); }
    const rows = await pool.query(
      `SELECT * FROM injury_reports WHERE ${where.join(' AND ')} ORDER BY time_of_report DESC LIMIT $${vals.length + 1}`,
      [...vals, parseInt(limit)]
    );
    res.json({ injuries: rows.rows, count: rows.rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Single player history
app.get('/v1/players/:player', auth, async (req, res) => {
  if (!pool) return res.json({ reports: [], count: 0 });
  try {
    const rows = await pool.query(
      `SELECT * FROM injury_reports WHERE player ILIKE $1 ORDER BY time_of_report DESC LIMIT 100`,
      [req.params.player]
    );
    res.json({ reports: rows.rows, count: rows.rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── START ────────────────────────────────────────────────────────────────────
async function start() {
  await initDB();

  // Seed fallback roster immediately so first poll has something to match against
  rosterCache = { ...ROSTER_FALLBACK };

  // Load last 24h from DB into memory on startup
  const existing = await loadRecentFromDB(24);
  existing.forEach(r => {
    if (!r.player || r.player === 'Unknown Player') return;
    if (!r.reporter) return;
    const reporterObj = REPORTERS.find(x => x.name === r.reporter);
    const handle = reporterObj ? '@' + reporterObj.handle : (r.handle || '');
    injuryCache.push({
      ...r,
      handle,
      injury: `${r.injury_type && r.injury_type !== 'Undisclosed' ? r.injury_type + ' — ' : ''}${r.body_part || ''}`,
      body: r.body_part,
      timestamp: r.time_of_report,
      tweetId: r.tweet_id,
      corrobTweets: r.corrob_tweets || [],
      in_game: r.in_game || false,
    });
    if (r.tweet_id) seenTweetIds.add(r.tweet_id);
    (r.corrob_tweets || []).forEach(ct => { if (ct.tweetId) seenTweetIds.add(ct.tweetId); });
  });
  console.log(`[Start] Loaded ${injuryCache.length} reports from DB`);

  app.listen(PORT, () => {
    console.log(`InjuryWire v2 running on :${PORT}`);
    console.log(`  TWEETAPI_KEY:    ${TWEETAPI_KEY ? '✓' : '✗ not set'}`);
    console.log(`  DATABASE_URL:    ${pool ? '✓' : '✗ not set'}`);
    console.log(`  BALLDONTLIE_KEY: ${process.env.BALLDONTLIE_KEY ? '✓' : '✗ not set (schedule disabled)'}`);
    console.log(`  API_KEY:         ${process.env.API_KEY ? '✓' : 'open (no auth)'}`);
  });

  // Start NBA official injury report scraper
  await startScraper(app);

  // Poll immediately then every minute
  await poll();
  setInterval(poll, 60000);
}

start();
