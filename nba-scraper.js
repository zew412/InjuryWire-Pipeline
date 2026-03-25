/**
 * nba-scraper.js — v2
 */
const axios  = require('axios');
const pdf    = require('pdf-parse');
const { Pool } = require('pg');

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

let lastProcessedUrl  = null;
let lastRawText       = '';
let officialCache     = {};
let officialFetchedAt = null;

async function initOfficialDB() {
  if (!pool) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS nba_official_injuries (
        id              SERIAL PRIMARY KEY,
        report_url      TEXT,
        report_time     TIMESTAMPTZ,
        game_date       DATE,
        game_time       TEXT,
        matchup         TEXT,
        team            TEXT,
        player          TEXT,
        current_status  TEXT,
        previous_status TEXT,
        reason          TEXT,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (report_url, player, team)
      );
      CREATE INDEX IF NOT EXISTS idx_official_player ON nba_official_injuries(player);
      CREATE INDEX IF NOT EXISTS idx_official_team   ON nba_official_injuries(team);
      CREATE INDEX IF NOT EXISTS idx_official_time   ON nba_official_injuries(report_time DESC);
    `);
    console.log('[NBA Official] DB schema ready ✓');
  } catch (err) { console.error('[NBA Official] DB init error:', err.message); }
}

function getCurrentPdfUrl() {
  const etStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const et = new Date(etStr);
  const roundedMins = Math.floor(et.getMinutes() / 15) * 15;
  et.setMinutes(roundedMins, 0, 0);
  const year  = et.getFullYear();
  const month = String(et.getMonth() + 1).padStart(2, '0');
  const day   = String(et.getDate()).padStart(2, '0');
  let hours   = et.getHours();
  const ampm  = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  return `https://ak-static.cms.nba.com/referee/injury/Injury-Report_${year}-${month}-${day}_${String(hours).padStart(2,'0')}_${String(roundedMins).padStart(2,'0')}${ampm}.pdf`;
}

function normaliseStatus(raw) {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (s.includes('out'))                                              return 'Out';
  if (s.includes('doubtful'))                                         return 'Doubtful';
  if (s.includes('game time')||s.includes('game-time')||s==='gtd')   return 'Game-Time Decision';
  if (s.includes('questionable'))                                     return 'Questionable';
  if (s.includes('probable'))                                         return 'Probable';
  return null;
}

const NBA_TEAMS = [
  'Atlanta Hawks','Boston Celtics','Brooklyn Nets','Charlotte Hornets','Chicago Bulls',
  'Cleveland Cavaliers','Dallas Mavericks','Denver Nuggets','Detroit Pistons',
  'Golden State Warriors','Houston Rockets','Indiana Pacers','LA Clippers',
  'Los Angeles Lakers','Memphis Grizzlies','Miami Heat','Milwaukee Bucks',
  'Minnesota Timberwolves','New Orleans Pelicans','New York Knicks',
  'Oklahoma City Thunder','Orlando Magic','Philadelphia 76ers','Phoenix Suns',
  'Portland Trail Blazers','Sacramento Kings','San Antonio Spurs',
  'Toronto Raptors','Utah Jazz','Washington Wizards',
].sort((a,b) => b.length - a.length);

const DATE_RE   = /\b(\d{2}\/\d{2}\/\d{4})\b/;
const TIME_RE   = /\b(\d{1,2}:\d{2}\s*(?:AM|PM)\s*ET)\b/i;
const STATUS_RE = /\b(Out|Doubtful|Questionable|Game.Time\s+Decision|Probable|GTD|Available|Active)\b/gi;

function parseSingleLine(line) {
  const dateMatch = line.match(DATE_RE);
  if (!dateMatch) return null;

  // Must contain a status keyword
  const statuses = [...line.matchAll(STATUS_RE)];
  if (!statuses.length) return null;

  const currentStatus = normaliseStatus(statuses[0][0]);
  if (!currentStatus) return null;

  const timeMatch = line.match(TIME_RE);
  const gameDate  = dateMatch[1];
  const gameTime  = timeMatch ? timeMatch[1] : '';

  // Find matchup (contains "vs.")
  const vsMatch = line.match(/([A-Z][A-Za-z\s]+(?:vs\.?)\s*[A-Z][A-Za-z\s]+?)(?=[A-Z][a-z])/);
  const matchup = vsMatch ? vsMatch[1].trim() : '';

  // Find team
  let teamName = '';
  let teamEnd  = -1;
  for (const team of NBA_TEAMS) {
    const idx = line.indexOf(team);
    if (idx !== -1) {
      teamName = team;
      teamEnd  = idx + team.length;
      break;
    }
  }
  if (!teamName) return null;

  // Player = text between teamEnd and first status keyword
  const firstStatusIdx = statuses[0].index;
  if (firstStatusIdx <= teamEnd) return null;
  const playerRaw = line.slice(teamEnd, firstStatusIdx).trim();
  if (!playerRaw || playerRaw.length < 4) return null;
  // Basic sanity: should look like a name (2+ words, mostly letters)
  if (!/^[A-Z][a-záàâäéèêëíìîïóòôöõúùûüñç'.\s-]{3,}$/.test(playerRaw)) return null;

  const previousStatus = statuses[1] ? normaliseStatus(statuses[1][0]) : null;

  // Reason = everything after the last status keyword
  const lastSt    = statuses[statuses.length - 1];
  const reasonRaw = line.slice(lastSt.index + lastSt[0].length).trim();
  const reason    = reasonRaw.replace(/^[-–—\s]+/, '').trim();

  return { game_date: gameDate, game_time: gameTime, matchup, team: teamName,
           player: playerRaw, current_status: currentStatus,
           previous_status: previousStatus, reason };
}

function parseInjuryText(text) {
  if (!text) return [];
  const entries = [];
  const seen    = new Set();

  // Strategy A: single-line rows (most common for pdf-parse output)
  for (const line of text.split('\n').map(l => l.trim()).filter(Boolean)) {
    const e = parseSingleLine(line);
    if (e) {
      const key = `${e.player}|${e.team}`;
      if (!seen.has(key)) { seen.add(key); entries.push(e); }
    }
  }

  // Strategy B: multi-line rows — join 10-line windows starting at each date line
  if (entries.length === 0) {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      if (!DATE_RE.test(lines[i])) continue;
      const combined = lines.slice(i, i + 10).join(' ');
      const e = parseSingleLine(combined);
      if (e) {
        const key = `${e.player}|${e.team}`;
        if (!seen.has(key)) { seen.add(key); entries.push(e); }
      }
    }
  }

  return entries;
}

async function saveEntries(entries, reportUrl, reportTime) {
  if (!pool || !entries.length) return 0;
  let saved = 0;
  for (const e of entries) {
    try {
      const dp = e.game_date.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      const pgDate = dp ? `${dp[3]}-${dp[1]}-${dp[2]}` : null;
      await pool.query(`
        INSERT INTO nba_official_injuries
          (report_url,report_time,game_date,game_time,matchup,team,player,current_status,previous_status,reason)
        VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (report_url,player,team) DO UPDATE
          SET current_status=EXCLUDED.current_status,
              previous_status=EXCLUDED.previous_status,
              reason=EXCLUDED.reason
      `, [reportUrl, reportTime, pgDate, e.game_time, e.matchup, e.team,
          e.player, e.current_status, e.previous_status, e.reason || null]);
      saved++;
    } catch (err) { console.error('[NBA Official] Save error:', err.message); }
  }
  return saved;
}

async function pollOfficialReport() {
  const url = getCurrentPdfUrl();
  if (url === lastProcessedUrl) return;
  console.log(`[NBA Official] Fetching ${url}`);
  try {
    const res  = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; InjuryWire/1.0)' } });
    const data = await pdf(res.data);
    lastRawText = data.text;
    console.log('[NBA Official] Raw sample:', data.text.slice(0, 400).replace(/\n/g, ' | '));
    const entries = parseInjuryText(data.text);
    console.log(`[NBA Official] Parsed ${entries.length} players`);
    lastProcessedUrl = url;
    if (entries.length > 0) {
      officialCache = {};
      for (const e of entries) officialCache[e.player] = { ...e, report_url: url, report_time: new Date() };
      officialFetchedAt = new Date();
      const saved = await saveEntries(entries, url, new Date());
      console.log(`[NBA Official] Saved ${saved} to DB ✓`);
    } else {
      console.warn('[NBA Official] 0 entries — visit /nba/debug to inspect raw PDF text');
    }
  } catch (err) {
    if ([403,404].includes(err.response?.status)) {
      console.log(`[NBA Official] Not published yet (${err.response.status})`);
    } else {
      console.error('[NBA Official] Error:', err.message);
    }
  }
}

function getOfficialCache() {
  return { entries: Object.values(officialCache), count: Object.keys(officialCache).length, fetched_at: officialFetchedAt };
}
function getOfficialStatusForPlayer(name) {
  if (!name) return null;
  return officialCache[name] || Object.values(officialCache).find(e => e.player.toLowerCase() === name.toLowerCase()) || null;
}

async function startScraper(app) {
  await initOfficialDB();
  if (pool) {
    try {
      const rows = await pool.query(`SELECT DISTINCT ON (player,team) * FROM nba_official_injuries
        WHERE report_time > NOW() - INTERVAL '12 hours' ORDER BY player,team,report_time DESC`);
      for (const r of rows.rows) officialCache[r.player] = r;
      officialFetchedAt = new Date();
      console.log(`[NBA Official] Loaded ${rows.rowCount} entries from DB ✓`);
    } catch (err) { console.error('[NBA Official] Startup load error:', err.message); }
  }

  if (app) {
    app.get('/nba/injuries',     (req,res) => res.json(getOfficialCache()));
    app.get('/nba/player/:name', (req,res) => {
      const e = getOfficialStatusForPlayer(req.params.name);
      return e ? res.json(e) : res.status(404).json({ error: 'Not in official report' });
    });
    app.get('/nba/history', async (req,res) => {
      if (!pool) return res.json({ entries:[], count:0 });
      try {
        const rows = await pool.query(`SELECT * FROM nba_official_injuries
          WHERE report_time > NOW() - INTERVAL '7 days' ORDER BY report_time DESC LIMIT 2000`);
        res.json({ entries: rows.rows, count: rows.rowCount });
      } catch (err) { res.status(500).json({ error: err.message }); }
    });
    app.get('/nba/latest-url', (req,res) => res.json({ last: lastProcessedUrl, current: getCurrentPdfUrl() }));
    // Debug: returns raw PDF text so we can verify/fix the parser
    app.get('/nba/debug', async (req,res) => {
      const url = getCurrentPdfUrl();
      try {
        const r = await axios.get(url, { responseType:'arraybuffer', timeout:20000 });
        const d = await pdf(r.data);
        res.json({ url, text: d.text.slice(0,4000), total_length: d.text.length });
      } catch (err) {
        res.json({ url, error: err.message, cached_text: lastRawText.slice(0,4000) });
      }
    });
  }

  await pollOfficialReport();
  setInterval(pollOfficialReport, 60000);
  console.log('[NBA Official] Scraper started — polling every 60s ✓');
}

module.exports = { startScraper, getOfficialCache, getOfficialStatusForPlayer };
