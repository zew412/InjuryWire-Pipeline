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

// ─── ROSTER (player → position) ──────────────────────────────────────────────
// Covers ~200 active NBA players. Falls back to null if not found.
const ROSTER = {
  // Guards
  "Stephen Curry":"PG","Damian Lillard":"PG","Ja Morant":"PG","Trae Young":"PG",
  "Luka Doncic":"PG","Tyrese Haliburton":"PG","Shai Gilgeous-Alexander":"PG",
  "Donovan Mitchell":"SG","Devin Booker":"SG","Jaylen Brown":"SG","Zach LaVine":"SG",
  "CJ McCollum":"SG","Khris Middleton":"SG","Anthony Edwards":"SG","Jordan Poole":"SG",
  "De'Aaron Fox":"PG","Fred VanVleet":"PG","Kyle Lowry":"PG","Chris Paul":"PG",
  "Russell Westbrook":"PG","Mike Conley":"PG","Marcus Smart":"PG","Jrue Holiday":"PG",
  "Tyrese Maxey":"PG","Dejounte Murray":"PG","LaMelo Ball":"PG","Josh Giddey":"PG",
  "James Harden":"PG","D'Angelo Russell":"PG","Klay Thompson":"SG","Buddy Hield":"SG",
  "Tyler Herro":"SG","Darius Garland":"PG","Cade Cunningham":"PG","Scoot Henderson":"PG",
  // Forwards/Wings
  "LeBron James":"SF","Kevin Durant":"SF","Jayson Tatum":"SF","Paul George":"SF",
  "Kawhi Leonard":"SF","Jimmy Butler":"SF","Pascal Siakam":"SF","Bam Adebayo":"PF",
  "Draymond Green":"PF","Julius Randle":"PF","Zion Williamson":"PF","Brandon Ingram":"SF",
  "Lauri Markkanen":"PF","OG Anunoby":"SF","Scottie Barnes":"SF","Paolo Banchero":"PF",
  "Franz Wagner":"SF","Mikal Bridges":"SF","Andrew Wiggins":"SF","Harrison Barnes":"SF",
  "Tobias Harris":"PF","Al Horford":"PF","Domantas Sabonis":"PF","John Collins":"PF",
  "Evan Mobley":"PF","Onyeka Okongwu":"PF","Jabari Smith Jr.":"PF","Walker Kessler":"C",
  "Aaron Gordon":"PF","Miles Bridges":"PF","Gordon Hayward":"SF","P.J. Tucker":"PF",
  "Bruce Brown":"SF","Jerami Grant":"PF","Jalen Johnson":"SF","Keegan Murray":"SF",
  // Centers
  "Nikola Jokic":"C","Joel Embiid":"C","Giannis Antetokounmpo":"PF","Karl-Anthony Towns":"C",
  "Rudy Gobert":"C","Anthony Davis":"C","Deandre Ayton":"C","Myles Turner":"C",
  "Brook Lopez":"C","Clint Capela":"C","Jarrett Allen":"C","Steven Adams":"C",
  "Jonas Valanciunas":"C","Kristaps Porzingis":"C","Mitchell Robinson":"C",
  "Alperen Sengun":"C","Victor Wembanyama":"C","Chet Holmgren":"C","Ivica Zubac":"C",
  "Nikola Vucevic":"C","Isaiah Stewart":"C","Daniel Gafford":"C","Naz Reid":"C",
  // Stars with common name variants
  "KAT":"C","Ant":"SG","SGA":"PG","Wemby":"C","Dame":"PG","Bron":"SF",
};

function getPosition(playerName) {
  if (!playerName) return null;
  return ROSTER[playerName] || null;
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
  const patterns = [
    /^([A-Z][a-záàâäãéèêëíìîïóòôöõúùûüñç'.-]+(?:\s+[A-Z][a-záàâäãéèêëíìîïóòôöõúùûüñç'.-]+){1,3})\s*\(/,
    /^([A-Z][a-záàâäãéèêëíìîïóòôöõúùûüñç'.-]+(?:\s+[A-Z][a-záàâäãéèêëíìîïóòôöõúùûüñç'.-]+){1,3})\s+(?:is|will|won'?t|has|was|did)\b/,
    /([A-Z][a-z'.-]+(?:\s+[A-Z][a-z'.-]+){1,3})\s+(?:ruled out|out tonight|is questionable|is doubtful|is probable|listed as|will not play|won'?t play)/i,
    /([A-Z][a-z'.-]+(?:\s+[A-Z][a-z'.-]+){1,3})\s+(?:–|—|-)\s+(?:ankle|knee|quad|hamstring|achilles|back|shoulder|hip|calf|wrist)/i,
  ];
  const skipWords = /^(The|This|He|She|They|We|His|Her|Per|Via|From|With|For|Breaking|Sources|Report|Update|According)/i;
  for (const p of patterns) {
    const m = text.match(p);
    if (m?.[1] && m[1].length > 3 && !skipWords.test(m[1])) return m[1].trim();
  }
  return null;
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
         time_of_report, prev_status, days_since_last_report, tweet_text, corroborators)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      ON CONFLICT (tweet_id) DO NOTHING
    `, [
      r.tweet_id, r.player, r.position, r.team, r.status, r.injury_type, r.body_part,
      r.matchup, r.game_date, r.game_time, r.reporter, r.outlet, r.tier, r.confidence,
      r.time_of_report, r.prev_status, r.days_since_last_report, r.tweet_text,
      r.corroborators || [],
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

  // Refresh schedule each poll (cached internally for 1hr)
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
    const position  = getPosition(player);
    const confidence = calcConfidence(reporter, status, tweet.text);
    const gameInfo  = getGameInfo(reporter.team === 'All Teams' ? 'Unknown' : reporter.team);
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
      team:        reporter.team === 'All Teams' ? 'Unknown' : reporter.team,
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
      // for dashboard compat
      handle:      '@' + reporter.handle,
      injury:      `${injury_type !== 'Undisclosed' ? injury_type + ' — ' : ''}${body_part}`,
      body:        body_part,
      timestamp:   tweetTime.toISOString(),
      tweetId:     tweet.id,
    };

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
