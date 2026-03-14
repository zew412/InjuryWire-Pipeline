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
  // Los Angeles Lakers
  "Luka Doncic":{"team":"Los Angeles Lakers","position":"G"},
  "LeBron James":{"team":"Los Angeles Lakers","position":"F"},
  "Austin Reaves":{"team":"Los Angeles Lakers","position":"G"},
  "Marcus Smart":{"team":"Los Angeles Lakers","position":"G"},
  "Rui Hachimura":{"team":"Los Angeles Lakers","position":"F"},
  // Dallas Mavericks
  "Cooper Flagg":{"team":"Dallas Mavericks","position":"F"},
  "Klay Thompson":{"team":"Dallas Mavericks","position":"G"},
  "Kyrie Irving":{"team":"Dallas Mavericks","position":"G"},
  // Washington Wizards
  "Anthony Davis":{"team":"Washington Wizards","position":"F"},
  "Trae Young":{"team":"Washington Wizards","position":"G"},
  "Alex Sarr":{"team":"Washington Wizards","position":"C"},
  // New York Knicks
  "Karl-Anthony Towns":{"team":"New York Knicks","position":"C"},
  "Jalen Brunson":{"team":"New York Knicks","position":"G"},
  "Mikal Bridges":{"team":"New York Knicks","position":"F"},
  "OG Anunoby":{"team":"New York Knicks","position":"F"},
  "Josh Hart":{"team":"New York Knicks","position":"G"},
  // Minnesota Timberwolves
  "Anthony Edwards":{"team":"Minnesota Timberwolves","position":"G"},
  "Rudy Gobert":{"team":"Minnesota Timberwolves","position":"C"},
  "Julius Randle":{"team":"Minnesota Timberwolves","position":"F"},
  "Jaden McDaniels":{"team":"Minnesota Timberwolves","position":"F"},
  // Oklahoma City Thunder
  "Shai Gilgeous-Alexander":{"team":"Oklahoma City Thunder","position":"G"},
  "Jalen Williams":{"team":"Oklahoma City Thunder","position":"G"},
  "Chet Holmgren":{"team":"Oklahoma City Thunder","position":"C"},
  "Alex Caruso":{"team":"Oklahoma City Thunder","position":"G"},
  "Isaiah Hartenstein":{"team":"Oklahoma City Thunder","position":"C"},
  // Boston Celtics
  "Jayson Tatum":{"team":"Boston Celtics","position":"F"},
  "Jaylen Brown":{"team":"Boston Celtics","position":"G"},
  "Kristaps Porzingis":{"team":"Boston Celtics","position":"C"},
  "Jrue Holiday":{"team":"Boston Celtics","position":"G"},
  "Payton Pritchard":{"team":"Boston Celtics","position":"G"},
  // Cleveland Cavaliers
  "Donovan Mitchell":{"team":"Cleveland Cavaliers","position":"G"},
  "Darius Garland":{"team":"Cleveland Cavaliers","position":"G"},
  "Evan Mobley":{"team":"Cleveland Cavaliers","position":"F"},
  "Jarrett Allen":{"team":"Cleveland Cavaliers","position":"C"},
  "James Harden":{"team":"Cleveland Cavaliers","position":"G"},
  // Denver Nuggets
  "Nikola Jokic":{"team":"Denver Nuggets","position":"C"},
  "Jamal Murray":{"team":"Denver Nuggets","position":"G"},
  "Michael Porter Jr.":{"team":"Denver Nuggets","position":"F"},
  "Aaron Gordon":{"team":"Denver Nuggets","position":"F"},
  // Golden State Warriors
  "Stephen Curry":{"team":"Golden State Warriors","position":"G"},
  "Draymond Green":{"team":"Golden State Warriors","position":"F"},
  "Andrew Wiggins":{"team":"Miami Heat","position":"F"},
  "Jonathan Kuminga":{"team":"Golden State Warriors","position":"F"},
  // Houston Rockets
  "Kevin Durant":{"team":"Houston Rockets","position":"F"},
  "Alperen Sengun":{"team":"Houston Rockets","position":"C"},
  "Jalen Green":{"team":"Houston Rockets","position":"G"},
  "Fred VanVleet":{"team":"Houston Rockets","position":"G"},
  // Philadelphia 76ers
  "Joel Embiid":{"team":"Philadelphia 76ers","position":"C"},
  "Tyrese Maxey":{"team":"Philadelphia 76ers","position":"G"},
  "Paul George":{"team":"Philadelphia 76ers","position":"F"},
  // Milwaukee Bucks
  "Giannis Antetokounmpo":{"team":"Milwaukee Bucks","position":"F"},
  "Damian Lillard":{"team":"Milwaukee Bucks","position":"G"},
  "Khris Middleton":{"team":"Milwaukee Bucks","position":"F"},
  // Miami Heat
  "Bam Adebayo":{"team":"Miami Heat","position":"C"},
  "Jimmy Butler":{"team":"Golden State Warriors","position":"F"},
  "Tyler Herro":{"team":"Miami Heat","position":"G"},
  // Indiana Pacers
  "Tyrese Haliburton":{"team":"Indiana Pacers","position":"G"},
  "Pascal Siakam":{"team":"Indiana Pacers","position":"F"},
  "Myles Turner":{"team":"Indiana Pacers","position":"C"},
  // Toronto Raptors
  "Scottie Barnes":{"team":"Toronto Raptors","position":"F"},
  "RJ Barrett":{"team":"Toronto Raptors","position":"G"},
  "Immanuel Quickley":{"team":"Toronto Raptors","position":"G"},
  // Orlando Magic
  "Paolo Banchero":{"team":"Orlando Magic","position":"F"},
  "Franz Wagner":{"team":"Orlando Magic","position":"F"},
  "Jalen Suggs":{"team":"Orlando Magic","position":"G"},
  // New Orleans Pelicans
  "Zion Williamson":{"team":"New Orleans Pelicans","position":"F"},
  "Dejounte Murray":{"team":"New Orleans Pelicans","position":"G"},
  "Brandon Ingram":{"team":"New Orleans Pelicans","position":"F"},
  "CJ McCollum":{"team":"New Orleans Pelicans","position":"G"},
  // Atlanta Hawks
  "Jalen Johnson":{"team":"Atlanta Hawks","position":"F"},
  "De'Andre Hunter":{"team":"Atlanta Hawks","position":"F"},
  "Clint Capela":{"team":"Atlanta Hawks","position":"C"},
  // Sacramento Kings
  "De'Aaron Fox":{"team":"Sacramento Kings","position":"G"},
  "Domantas Sabonis":{"team":"Sacramento Kings","position":"C"},
  "DeMar DeRozan":{"team":"Sacramento Kings","position":"G"},
  // San Antonio Spurs
  "Victor Wembanyama":{"team":"San Antonio Spurs","position":"C"},
  "Devin Vassell":{"team":"San Antonio Spurs","position":"G"},
  // Utah Jazz
  "Lauri Markkanen":{"team":"Utah Jazz","position":"F"},
  "Jaren Jackson Jr.":{"team":"Utah Jazz","position":"F"},
  "Collin Sexton":{"team":"Utah Jazz","position":"G"},
  // Portland Trail Blazers
  "Scoot Henderson":{"team":"Portland Trail Blazers","position":"G"},
  "Anfernee Simons":{"team":"Portland Trail Blazers","position":"G"},
  "Deni Avdija":{"team":"Portland Trail Blazers","position":"F"},
  "Jerami Grant":{"team":"Portland Trail Blazers","position":"F"},
  // Memphis Grizzlies
  "Ja Morant":{"team":"Memphis Grizzlies","position":"G"},
  "Desmond Bane":{"team":"Memphis Grizzlies","position":"G"},
  // LA Clippers
  "Kawhi Leonard":{"team":"LA Clippers","position":"F"},
  "Ivica Zubac":{"team":"LA Clippers","position":"C"},
  "Norman Powell":{"team":"Miami Heat","position":"G"},
  // Charlotte Hornets
  "LaMelo Ball":{"team":"Charlotte Hornets","position":"G"},
  "Brandon Miller":{"team":"Charlotte Hornets","position":"F"},
  // Detroit Pistons
  "Cade Cunningham":{"team":"Detroit Pistons","position":"G"},
  "Jalen Duren":{"team":"Detroit Pistons","position":"C"},
  "Ausar Thompson":{"team":"Detroit Pistons","position":"F"},
  // Brooklyn Nets
  "Cam Thomas":{"team":"Brooklyn Nets","position":"G"},
  // Chicago Bulls
  "Zach LaVine":{"team":"Chicago Bulls","position":"G"},
  "Nikola Vucevic":{"team":"Chicago Bulls","position":"C"},
  "Coby White":{"team":"Chicago Bulls","position":"G"},
  // Phoenix Suns
  "Devin Booker":{"team":"Phoenix Suns","position":"G"},
  "Jusuf Nurkic":{"team":"Phoenix Suns","position":"C"},
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
          position: p.position || null,   // "G", "F", "C", "G-F", "F-C" etc.
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

// Returns true if name is a known active NBA player
function isKnownPlayer(name) {
  return !!getRosterEntry(name);
}

// ─── NBA SCHEDULE CACHE ───────────────────────────────────────────────────────
// Maps team name → { matchup, game_date, game_time }
let scheduleCache = {};
let scheduleFetchedAt = null;

async function fetchSchedule() {
  const BDLKEY = process.env.BALLDONTLIE_KEY;
  if (!BDLKEY) return;

  // Don't refetch more than once per hour
  if (scheduleFetchedAt && (Date.now() - scheduleFetchedAt) < 3600000) return;

  try {
    const today = new Date().toISOString().split('T')[0];
    // Look at today + next 2 days to catch games currently being reported on
    const dates = [0, 1, 2].map(d => {
      const dt = new Date(); dt.setDate(dt.getDate() + d);
      return dt.toISOString().split('T')[0];
    });

    const all = {};
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
        // Parse game time — balldontlie returns UTC ISO string
        let game_time = null;
        if (g.status && g.status.includes(':')) {
          // "7:30 pm ET" style or ISO
          game_time = g.status;
        } else if (g.date) {
          const d = new Date(g.date);
          game_time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) + ' ET';
        }
        const entry = { matchup, game_date: date, game_time };
        all[home] = entry;
        all[away] = entry;
      }
    }
    scheduleCache = all;
    scheduleFetchedAt = Date.now();
    console.log(`[Schedule] Cached ${Object.keys(all).length / 2} games`);
  } catch (err) {
    console.warn('[Schedule] Fetch failed:', err.message);
  }
}

function getGameInfo(team) {
  return scheduleCache[team] || { matchup: null, game_date: null, game_time: null };
}

// ─── REPORTERS ────────────────────────────────────────────────────────────────
const REPORTERS = [
  {name:"Kevin Chouinard",handle:"KLChouinard",team:"Atlanta Hawks",outlet:"Hawks.com",tier:1,signal:"High",conf:"E"},
  {name:"Lauren L. Williams",handle:"williamslaurenl",team:"Atlanta Hawks",outlet:"Atlanta Journal-Constitution",tier:1,signal:"High",conf:"E"},
  {name:"Chris Kirschner",handle:"ChrisKirschner",team:"Atlanta Hawks",outlet:"The Athletic",tier:2,signal:"High",conf:"E"},
  {name:"Jay King",handle:"ByJayKing",team:"Boston Celtics",outlet:"The Athletic",tier:1,signal:"High",conf:"E"},
  {name:"Chris Forsberg",handle:"ChrisForsberg_",team:"Boston Celtics",outlet:"NBC Sports Boston",tier:1,signal:"High",conf:"E"},
  {name:"Gary Washburn",handle:"GaryWashburn",team:"Boston Celtics",outlet:"Boston Globe",tier:1,signal:"High",conf:"E"},
  {name:"Adam Himmelsbach",handle:"adamhimmelsbach",team:"Boston Celtics",outlet:"Boston Globe",tier:1,signal:"High",conf:"E"},
  {name:"Erik Slater",handle:"erikslater_",team:"Brooklyn Nets",outlet:"ClutchPoints",tier:1,signal:"High",conf:"E"},
  {name:"Alex Schiffer",handle:"Alex__Schiffer",team:"Brooklyn Nets",outlet:"The Athletic",tier:1,signal:"High",conf:"E"},
  {name:"Brian Lewis",handle:"NYPost_Lewis",team:"Brooklyn Nets",outlet:"New York Post",tier:1,signal:"High",conf:"E"},
  {name:"Rod Boone",handle:"rodboone",team:"Charlotte Hornets",outlet:"The Athletic",tier:1,signal:"High",conf:"E"},
  {name:"Rick Bonnell",handle:"rick_bonnell",team:"Charlotte Hornets",outlet:"Charlotte Observer",tier:1,signal:"High",conf:"E"},
  {name:"KC Johnson",handle:"KCJHoop",team:"Chicago Bulls",outlet:"Chicago Sports Network",tier:1,signal:"High",conf:"E"},
  {name:"Julia Poe",handle:"byjuliapoe",team:"Chicago Bulls",outlet:"Chicago Tribune",tier:1,signal:"High",conf:"E"},
  {name:"Chris Fedor",handle:"ChrisFedor",team:"Cleveland Cavaliers",outlet:"Cleveland Plain Dealer",tier:1,signal:"High",conf:"E"},
  {name:"Joe Vardon",handle:"joevardon",team:"Cleveland Cavaliers",outlet:"The Athletic",tier:1,signal:"High",conf:"E"},
  {name:"Kelsey Russo",handle:"kelseyyrusso",team:"Cleveland Cavaliers",outlet:"The Athletic",tier:1,signal:"High",conf:"E"},
  {name:"Omari Sankofa II",handle:"omarisankofa",team:"Detroit Pistons",outlet:"Detroit Free Press",tier:1,signal:"High",conf:"E"},
  {name:"James Edwards III",handle:"JLEdwardsIII",team:"Detroit Pistons",outlet:"The Athletic",tier:1,signal:"High",conf:"E"},
  {name:"Dustin Dopirak",handle:"DustinDopirak",team:"Indiana Pacers",outlet:"The Athletic",tier:1,signal:"High",conf:"E"},
  {name:"Scott Agness",handle:"ScottAgness",team:"Indiana Pacers",outlet:"FieldhouseFiles.com",tier:1,signal:"High",conf:"E"},
  {name:"Ira Winderman",handle:"IraHeatBeat",team:"Miami Heat",outlet:"Sun Sentinel",tier:1,signal:"High",conf:"E"},
  {name:"Anthony Chiang",handle:"Anthony_Chiang",team:"Miami Heat",outlet:"Miami Herald",tier:1,signal:"High",conf:"E"},
  {name:"Eric Nehm",handle:"eric_nehm",team:"Milwaukee Bucks",outlet:"The Athletic",tier:1,signal:"High",conf:"E"},
  {name:"Matt Velazquez",handle:"Matt_Velazquez",team:"Milwaukee Bucks",outlet:"Milwaukee Journal Sentinel",tier:1,signal:"High",conf:"E"},
  {name:"Ian Begley",handle:"IanBegley",team:"New York Knicks",outlet:"SNY",tier:1,signal:"High",conf:"E"},
  {name:"Steve Popper",handle:"StevePopper",team:"New York Knicks",outlet:"Newsday",tier:1,signal:"High",conf:"E"},
  {name:"Fred Katz",handle:"FredKatz",team:"New York Knicks",outlet:"The Athletic",tier:2,signal:"High",conf:"E"},
  {name:"Jason Beede",handle:"therealBeede",team:"Orlando Magic",outlet:"Orlando Sentinel",tier:1,signal:"High",conf:"E"},
  {name:"Khobi Price",handle:"khobi_price",team:"Orlando Magic",outlet:"Orlando Sentinel",tier:1,signal:"High",conf:"E"},
  {name:"Keith Pompey",handle:"PompeyOnSixers",team:"Philadelphia 76ers",outlet:"Philadelphia Inquirer",tier:1,signal:"High",conf:"E"},
  {name:"Kyle Neubeck",handle:"KyleNeubeck",team:"Philadelphia 76ers",outlet:"PhillyVoice",tier:1,signal:"High",conf:"E"},
  {name:"Rich Hofmann",handle:"rich_hofmann",team:"Philadelphia 76ers",outlet:"The Athletic",tier:1,signal:"High",conf:"E"},
  {name:"Josh Lewenberg",handle:"JLew1050",team:"Toronto Raptors",outlet:"TSN",tier:1,signal:"High",conf:"E"},
  {name:"Doug Smith",handle:"dougsmithstar",team:"Toronto Raptors",outlet:"Toronto Star",tier:1,signal:"High",conf:"E"},
  {name:"Michael Grange",handle:"michaelgrange",team:"Toronto Raptors",outlet:"Sportsnet",tier:1,signal:"High",conf:"E"},
  {name:"Josh Robbins",handle:"JoshuaBRobbins",team:"Washington Wizards",outlet:"The Athletic",tier:1,signal:"High",conf:"E"},
  {name:"Ava Wallace",handle:"avarwallace",team:"Washington Wizards",outlet:"Washington Post",tier:1,signal:"High",conf:"E"},
  {name:"Tim MacMahon",handle:"espn_macmahon",team:"Dallas Mavericks",outlet:"ESPN",tier:1,signal:"High",conf:"W"},
  {name:"Callie Caplan",handle:"CallieCaplan",team:"Dallas Mavericks",outlet:"Dallas Morning News",tier:1,signal:"High",conf:"W"},
  {name:"Saad Yousuf",handle:"SaadYousuf126",team:"Dallas Mavericks",outlet:"The Athletic",tier:2,signal:"High",conf:"W"},
  {name:"Bennett Durando",handle:"BennettDurando",team:"Denver Nuggets",outlet:"Denver Post",tier:1,signal:"High",conf:"W"},
  {name:"Mike Singer",handle:"msinger",team:"Denver Nuggets",outlet:"Denver Post",tier:1,signal:"High",conf:"W"},
  {name:"Harrison Wind",handle:"HarrisonWind",team:"Denver Nuggets",outlet:"DNVR Sports",tier:2,signal:"High",conf:"W"},
  {name:"Anthony Slater",handle:"anthonyVslater",team:"Golden State Warriors",outlet:"ESPN",tier:1,signal:"High",conf:"W"},
  {name:"Marcus Thompson",handle:"marcus_thompson",team:"Golden State Warriors",outlet:"The Athletic",tier:1,signal:"High",conf:"W"},
  {name:"Jonathan Feigen",handle:"Jonathan_Feigen",team:"Houston Rockets",outlet:"Houston Chronicle",tier:1,signal:"High",conf:"W"},
  {name:"Kelly Iko",handle:"KellyIko",team:"Houston Rockets",outlet:"The Athletic",tier:1,signal:"High",conf:"W"},
  {name:"Tomer Azarly",handle:"TomerAzarly",team:"LA Clippers",outlet:"ClutchPoints",tier:1,signal:"High",conf:"W"},
  {name:"Law Murray",handle:"LawMurrayTheNU",team:"LA Clippers",outlet:"The Athletic",tier:1,signal:"High",conf:"W"},
  {name:"Mike Trudell",handle:"LakersReporter",team:"Los Angeles Lakers",outlet:"Spectrum SportsNet",tier:1,signal:"High",conf:"W"},
  {name:"Dave McMenamin",handle:"mcten",team:"Los Angeles Lakers",outlet:"ESPN",tier:1,signal:"High",conf:"W"},
  {name:"Dan Woike",handle:"DanWoike",team:"Los Angeles Lakers",outlet:"The Athletic",tier:1,signal:"High",conf:"W"},
  {name:"Damichael Cole",handle:"DamichaelC",team:"Memphis Grizzlies",outlet:"Memphis Commercial Appeal",tier:1,signal:"High",conf:"W"},
  {name:"Drew Hill",handle:"DrewHill_DM",team:"Memphis Grizzlies",outlet:"Memphis Commercial Appeal",tier:1,signal:"High",conf:"W"},
  {name:"Jon Krawczynski",handle:"JonKrawczynski",team:"Minnesota Timberwolves",outlet:"The Athletic",tier:1,signal:"High",conf:"W"},
  {name:"Chris Hine",handle:"ChristopherHine",team:"Minnesota Timberwolves",outlet:"Minneapolis Star Tribune",tier:1,signal:"High",conf:"W"},
  {name:"Jim Eichenhofer",handle:"Jim_Eichenhofer",team:"New Orleans Pelicans",outlet:"Pelicans.com",tier:1,signal:"High",conf:"W"},
  {name:"Will Guillory",handle:"WillGuillory",team:"New Orleans Pelicans",outlet:"The Athletic",tier:1,signal:"High",conf:"W"},
  {name:"Brandon Rahbar",handle:"BrandonRahbar",team:"Oklahoma City Thunder",outlet:"Daily Thunder",tier:1,signal:"High",conf:"W"},
  {name:"Joel Lorenzi",handle:"jxlorenzi",team:"Oklahoma City Thunder",outlet:"The Oklahoman",tier:1,signal:"High",conf:"W"},
  {name:"Gerald Bourguet",handle:"GeraldBourguet",team:"Phoenix Suns",outlet:"PHNX Media",tier:1,signal:"High",conf:"W"},
  {name:"Duane Rankin",handle:"DuaneRankin",team:"Phoenix Suns",outlet:"Arizona Republic",tier:1,signal:"High",conf:"W"},
  {name:"Casey Holdahl",handle:"CHold",team:"Portland Trail Blazers",outlet:"TrailBlazers.com",tier:1,signal:"High",conf:"W"},
  {name:"Jason Quick",handle:"jwquick",team:"Portland Trail Blazers",outlet:"The Athletic",tier:1,signal:"High",conf:"W"},
  {name:"James Ham",handle:"James_HamNBA",team:"Sacramento Kings",outlet:"NBC Sports California",tier:1,signal:"High",conf:"W"},
  {name:"Jason Anderson",handle:"JandersonSacBee",team:"Sacramento Kings",outlet:"Sacramento Bee",tier:1,signal:"High",conf:"W"},
  {name:"Jeff McDonald",handle:"JMcDonald_SAEN",team:"San Antonio Spurs",outlet:"San Antonio Express-News",tier:1,signal:"High",conf:"W"},
  {name:"Tom Orsborn",handle:"tom_orsborn",team:"San Antonio Spurs",outlet:"San Antonio Express-News",tier:1,signal:"High",conf:"W"},
  {name:"Andy Larsen",handle:"andyblarsen",team:"Utah Jazz",outlet:"Salt Lake Tribune",tier:1,signal:"High",conf:"W"},
  {name:"Eric Walden",handle:"tribjazz",team:"Utah Jazz",outlet:"Salt Lake Tribune",tier:1,signal:"High",conf:"W"},
  // National
  {name:"Shams Charania",handle:"ShamsCharania",team:"All Teams",outlet:"ESPN",tier:1,signal:"High",conf:"NAT"},
  {name:"Adrian Wojnarowski",handle:"wojespn",team:"All Teams",outlet:"ESPN",tier:1,signal:"High",conf:"NAT"},
  {name:"Chris Haynes",handle:"ChrisBHaynes",team:"All Teams",outlet:"TNT",tier:1,signal:"High",conf:"NAT"},
  {name:"Jake Fischer",handle:"JakeLFischer",team:"All Teams",outlet:"Yahoo Sports",tier:1,signal:"High",conf:"NAT"},
  {name:"Sam Amick",handle:"sam_amick",team:"All Teams",outlet:"The Athletic",tier:1,signal:"High",conf:"NAT"},
  {name:"Marc Stein",handle:"TheSteinLine",team:"All Teams",outlet:"Substack",tier:1,signal:"High",conf:"NAT"},
  {name:"Brian Windhorst",handle:"WindhorstESPN",team:"All Teams",outlet:"ESPN",tier:2,signal:"High",conf:"NAT"},
  {name:"Ramona Shelburne",handle:"ramonashelburne",team:"All Teams",outlet:"ESPN",tier:2,signal:"High",conf:"NAT"},
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

function extractPlayer(text) {
  // ── Step 1: Full-roster scan first (most reliable) ──────────────────────────
  // Check roster cache against the tweet text — exact name match preferred
  const lowerText = text.toLowerCase();
  for (const name of Object.keys(rosterCache)) {
    if (name.length < 5) continue; // skip too-short names
    // Require whole-word match to avoid partial hits
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(text)) return name;
  }

  // ── Step 2: Regex candidates with strict filtering ───────────────────────────
  // These words commonly appear capitalized mid-tweet but are NOT player names
  const skipStart = /^(The|This|He|She|They|We|His|Her|Their|Per|Via|From|With|For|Breaking|Sources|Report|Update|According|It|In|At|No\.|No,|NBA|League|Official|Team|Head|Sources:|UPDATE|BREAKING|Just|Out|Game|Tonight|Today|Now|Here|After|Before|During|Without|Against|Between|All|Both|Neither|Each|Every|Some|Any|More|Most|Less|Few|Several|Many|Such|Other|Same|Next|Last|Another|One|Two|Three|First|Second|Third)/i;

  // Valid NBA first names — helps filter garbage
  const knownFirstNames = new Set([
    'LeBron','Luka','Anthony','Kevin','Stephen','Steph','Giannis','Jayson','Shai','Damian',
    'Joel','Nikola','Karl','Bam','Kawhi','Paul','Jimmy','Donovan','Victor','Tyrese',
    'Scottie','Paolo','Chet','Zion','Ja','Devin','Trae','Jaylen','Jalen','Darius','Evan',
    'Jamal','Michael','Aaron','Andrew','Draymond','Rudy','Julius','Julius','Jaden','Alex',
    'Isaiah','Alperen','Fred','Amen','Kelly','Khris','Brook','Bobby','Tyler','Terry',
    'Miles','Myles','Pascal','Bennedict','RJ','Immanuel','Jakob','Franz','Wendell',
    'Brandon','Dejounte','CJ','Herb','Jonas','Trey','Josh','Karl','Ian','Mikal','OG',
    'Donovan','De\'Aaron','Domantas','DeMar','Keegan','Jeff','Tom','Andy','Eric','Scott',
    'Scoot','Anfernee','Jerami','Deandre','Deni','Lauri','Jaren','Collin','Walker',
    'Cooper','Klay','Kyrie','Marcus','Austin','Rui','Cam','Cade','Ausar','Zach','Coby',
    'LaMelo','Jalen','James','Kristaps','Al','Payton','Max','Jonathan','Luguentz',
    'De\'Andre','Clint','De\'Aaron','Dyson','Herb','Trey','Jordan','Malcolm',
  ]);

  const patterns = [
    // "PlayerName (body part)" at start of tweet
    /^([A-Z][a-záàâäéèêëíìîïóòôöõúùûüñç'.-]+(?:\s+[A-Z][a-záàâäéèêëíìîïóòôöõúùûüñç'.-]+){1,2})\s*\(/,
    // "PlayerName is/will/won't/has/was" at start
    /^([A-Z][a-záàâäéèêëíìîïóòôöõúùûüñç'.-]+(?:\s+[A-Z][a-záàâäéèêëíìîïóòôöõúùûüñç'.-]+){1,2})\s+(?:is|will|won'?t|has|was|did)\b/,
    // "PlayerName ruled out / questionable / doubtful / listed as" anywhere
    /([A-Z][a-z'.-]+(?:\s+[A-Z][a-z'.-]+){1,2})\s+(?:ruled out|out tonight|is questionable|is doubtful|is probable|listed as|will not play|won'?t play|has been ruled)/i,
    // "PlayerName — ankle/knee/etc" injury dash pattern
    /([A-Z][a-z'.-]+(?:\s+[A-Z][a-z'.-]+){1,2})\s+(?:–|—|-)\s+(?:ankle|knee|quad|hamstring|achilles|back|shoulder|hip|calf|wrist|hand|foot)/i,
  ];

  const candidates = [];
  for (const p of patterns) {
    const m = text.match(p);
    if (!m?.[1]) continue;
    const name = m[1].trim();
    const parts = name.split(' ');
    // Must be 2+ words, each 2+ chars, first name must be known or be plausible
    if (parts.length < 2) continue;
    if (parts.some(w => w.length < 2)) continue;
    if (skipStart.test(name)) continue;
    // First word must be a plausible first name (in known set OR title-cased 4+ char word)
    if (!knownFirstNames.has(parts[0]) && parts[0].length < 4) continue;
    // Reject if any word is a common non-name word
    const nonNameWords = /^(no|not|out|the|and|but|just|also|only|even|then|than|when|that|this|they|them|their|about|after|before|during|tonight|tonight|game|team|will|wont|was|per|via|for|from|with)\b/i;
    if (parts.some(w => nonNameWords.test(w))) continue;
    candidates.push(name);
  }

  // Prefer roster-verified candidate
  for (const name of candidates) {
    if (isKnownPlayer(name)) return name;
  }

  // Return best unverified candidate only if it passes basic plausibility
  const best = candidates[0];
  if (best) {
    const firstWord = best.split(' ')[0];
    if (knownFirstNames.has(firstWord)) return best;
  }

  return null; // Return null rather than bad garbage — skipped reports are better than wrong ones
}

function calcConfidence(reporter, status, tweetText, corrobCount = 0) {
  const tierPts   = reporter.tier === 1 ? 35 : reporter.tier === 2 ? 22 : 10;
  const outletPts = ['ESPN','The Athletic','AP','Associated Press','Reuters','USA Today']
    .some(o => (reporter.outlet||'').includes(o)) ? 20 : reporter.tier === 1 ? 15 : 10;
  const statusMap = { Out: 0.95, Doubtful: 0.8, 'Game-Time Decision': 0.65, Questionable: 0.5, Probable: 0.35 };
  const sw = statusMap[status] || 0.5;
  const statusPts = sw >= 0.9 ? 18 : sw >= 0.75 ? 14 : sw >= 0.55 ? 10 : 6;
  const langPts   = tweetText ? Math.min(15, Math.round((tweetText.length / 260) * 15)) : 8;
  const signalPts = reporter.signal === 'High' ? 8 : 4;
  const corrPts   = Math.min(corrobCount * 3, 9);
  return Math.min(tierPts + outletPts + statusPts + langPts + signalPts + corrPts, 99);
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

    const player    = extractPlayer(tweet.text);
    if (!player) continue;

    const status    = extractStatus(tweet.text);
    const body_part = extractBodyPart(tweet.text);
    const injury_type = extractInjuryType(tweet.text);

    // Use live roster for authoritative team/position
    const rosterEntry = getRosterEntry(player);
    const position  = rosterEntry?.position || null;
    const team      = rosterEntry?.team
      || (reporter.team === 'All Teams' ? 'Unknown' : reporter.team);

    const confidence = calcConfidence(reporter, status, tweet.text);
    const gameInfo  = getGameInfo(team);
    const tweetTime = tweet.created_at ? new Date(tweet.created_at) : new Date();

    // Look up history for this player
    const [prev_status, days_since_last_report] = await Promise.all([
      getPrevStatus(player),
      getDaysSinceLastReport(player),
    ]);

    const report = {
      tweet_id:    tweet.id,
      player,
      position,
      team,
      status,
      injury_type,
      body_part,
      matchup:     gameInfo.matchup,
      game_date:   gameInfo.game_date,
      game_time:   gameInfo.game_time,
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
      // for dashboard compat
      handle:      '@' + reporter.handle,
      injury:      `${injury_type !== 'Undisclosed' ? injury_type + ' — ' : ''}${body_part}`,
      body:        body_part,
      timestamp:   tweetTime.toISOString(),
      tweetId:     tweet.id,
    };

    // ── Grouping: same player + same status within 3 hours → merge as corroboration
    const THREE_HOURS = 3 * 60 * 60 * 1000;
    const existing = injuryCache.find(r =>
      r.player && player &&
      r.player.toLowerCase() === player.toLowerCase() &&
      r.status === status &&
      Math.abs(new Date(r.time_of_report).getTime() - tweetTime.getTime()) < THREE_HOURS
    );

    if (existing) {
      // Add as corroborator on the existing report instead of creating a new one
      if (!existing.corroborators.includes(reporter.name)) {
        existing.corroborators.push(reporter.name);
        existing.corrobTweets = existing.corrobTweets || [];
        existing.corrobTweets.push({
          reporter: reporter.name,
          handle:   '@' + reporter.handle,
          tweet:    tweet.text,
          tweetId:  tweet.id,
          outlet:   reporter.outlet,
          tier:     reporter.tier,
        });
        // Boost confidence slightly for corroboration
        existing.confidence = Math.min(existing.confidence + 3, 99);
        // Update DB record
        await pool?.query(
          `UPDATE injury_reports SET corroborators = $1, confidence = $2 WHERE tweet_id = $3`,
          [existing.corroborators, existing.confidence, existing.tweet_id]
        );
      }
      console.log(`  [Grouped] ${reporter.name} → ${player} (${status})`);
      continue;
    }

    injuryCache.unshift(report);
    await saveReport(report);
    found++;
  }

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
  const sorted = [...injuryCache].sort((a, b) =>
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
    injuryCache.push({
      ...r,
      handle: r.reporter ? '@' + (REPORTERS.find(x => x.name === r.reporter)?.handle || '') : '',
      injury: `${r.injury_type !== 'Undisclosed' ? r.injury_type + ' — ' : ''}${r.body_part}`,
      body: r.body_part,
      timestamp: r.time_of_report,
      tweetId: r.tweet_id,
      corrobTweets: r.corrob_tweets || [],
    });
    if (r.tweet_id) seenTweetIds.add(r.tweet_id);
  });
  console.log(`[Start] Loaded ${injuryCache.length} reports from DB`);

  app.listen(PORT, () => {
    console.log(`InjuryWire v2 running on :${PORT}`);
    console.log(`  TWEETAPI_KEY:    ${TWEETAPI_KEY ? '✓' : '✗ not set'}`);
    console.log(`  DATABASE_URL:    ${pool ? '✓' : '✗ not set'}`);
    console.log(`  BALLDONTLIE_KEY: ${process.env.BALLDONTLIE_KEY ? '✓' : '✗ not set (schedule disabled)'}`);
    console.log(`  API_KEY:         ${process.env.API_KEY ? '✓' : 'open (no auth)'}`);
  });

  // Poll immediately then every minute
  await poll();
  setInterval(poll, 60000);
}

start();
