/**
 * InjuryWire Server
 * Polls TweetAPI for NBA injury tweets → serves them to your dashboard.
 * Deploy to Railway with two env vars: TWEETAPI_KEY and API_KEY
 */

require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── YOUR 212 REPORTERS ───────────────────────────────────────────────────────
const REPORTERS = [
  {name:"Kevin Chouinard",handle:"KLChouinard",team:"Atlanta Hawks",outlet:"Hawks.com / Zone Coverage",tier:1,signal:"High"},
  {name:"Lauren L. Williams",handle:"williamslaurenl",team:"Atlanta Hawks",outlet:"Atlanta Journal-Constitution",tier:1,signal:"High"},
  {name:"Sarah K. Spencer",handle:"sarah_k_spencer",team:"Atlanta Hawks",outlet:"Atlanta Journal-Constitution",tier:2,signal:"Medium"},
  {name:"Chris Kirschner",handle:"ChrisKirschner",team:"Atlanta Hawks",outlet:"The Athletic",tier:2,signal:"High"},
  {name:"Quenton Albertie",handle:"QuentonAlbertie",team:"Atlanta Hawks",outlet:"Last Word On Sports",tier:3,signal:"Medium"},
  {name:"Joe Barberio",handle:"JoeBarberio",team:"Atlanta Hawks",outlet:"FanDuel Sports Network SE",tier:3,signal:"Medium"},
  {name:"Jay King",handle:"ByJayKing",team:"Boston Celtics",outlet:"The Athletic",tier:1,signal:"High"},
  {name:"Chris Forsberg",handle:"ChrisForsberg_",team:"Boston Celtics",outlet:"NBC Sports Boston",tier:1,signal:"High"},
  {name:"Gary Washburn",handle:"GaryWashburn",team:"Boston Celtics",outlet:"Boston Globe",tier:1,signal:"High"},
  {name:"Adam Himmelsbach",handle:"adamhimmelsbach",team:"Boston Celtics",outlet:"Boston Globe",tier:1,signal:"High"},
  {name:"Brian Robb",handle:"BrianTRobb",team:"Boston Celtics",outlet:"MassLive",tier:2,signal:"Medium"},
  {name:"John Karalis",handle:"john_karalis",team:"Boston Celtics",outlet:"WEEI / Red's Army",tier:2,signal:"Medium"},
  {name:"A. Sherrod Blakely",handle:"SherrodBlakely",team:"Boston Celtics",outlet:"NBC Boston",tier:2,signal:"Medium"},
  {name:"Tim Bontemps",handle:"TimBontemps",team:"Boston Celtics",outlet:"ESPN",tier:2,signal:"High"},
  {name:"Erik Slater",handle:"erikslater_",team:"Brooklyn Nets",outlet:"ClutchPoints",tier:1,signal:"High"},
  {name:"Alex Schiffer",handle:"Alex__Schiffer",team:"Brooklyn Nets",outlet:"The Athletic",tier:1,signal:"High"},
  {name:"Brian Lewis",handle:"NYPost_Lewis",team:"Brooklyn Nets",outlet:"New York Post",tier:1,signal:"High"},
  {name:"Kristian Winfield",handle:"Krisplashed",team:"Brooklyn Nets",outlet:"NY Daily News",tier:2,signal:"High"},
  {name:"Ryan Rudominer",handle:"RyanRudominer",team:"Brooklyn Nets",outlet:"NetsDaily / FanSided",tier:2,signal:"Medium"},
  {name:"Ethan Sears",handle:"EthanJSears",team:"Brooklyn Nets",outlet:"New York Post",tier:2,signal:"Medium"},
  {name:"Rod Boone",handle:"rodboone",team:"Charlotte Hornets",outlet:"The Athletic",tier:1,signal:"High"},
  {name:"Rick Bonnell",handle:"rick_bonnell",team:"Charlotte Hornets",outlet:"Charlotte Observer",tier:1,signal:"High"},
  {name:"James Plowright",handle:"british_buzz",team:"Charlotte Hornets",outlet:"Locked On Hornets",tier:2,signal:"Medium"},
  {name:"Wynton McLaurin",handle:"WyntonMcLaurin",team:"Charlotte Hornets",outlet:"WCCB Charlotte",tier:2,signal:"Medium"},
  {name:"Mike Eisenberg",handle:"MikeEisenberg_",team:"Charlotte Hornets",outlet:"Hornets Beat",tier:2,signal:"Medium"},
  {name:"Steve Reed",handle:"SteveReedAP",team:"Charlotte Hornets",outlet:"Associated Press",tier:2,signal:"High"},
  {name:"KC Johnson",handle:"KCJHoop",team:"Chicago Bulls",outlet:"Chicago Sports Network",tier:1,signal:"High"},
  {name:"Julia Poe",handle:"byjuliapoe",team:"Chicago Bulls",outlet:"Chicago Tribune",tier:1,signal:"High"},
  {name:"Colleen Kane",handle:"colleenkaneCT",team:"Chicago Bulls",outlet:"Chicago Tribune",tier:2,signal:"Medium"},
  {name:"Rob Schaefer",handle:"rob_schaef",team:"Chicago Bulls",outlet:"NBC Sports Chicago",tier:2,signal:"High"},
  {name:"Darnell Mayberry",handle:"DarnellMayberry",team:"Chicago Bulls",outlet:"The Athletic",tier:2,signal:"High"},
  {name:"Sam Smith",handle:"SamSmithHoops",team:"Chicago Bulls",outlet:"Bulls.com",tier:2,signal:"Medium"},
  {name:"Ben Pope",handle:"BenPopeCST",team:"Chicago Bulls",outlet:"Chicago Sun-Times",tier:2,signal:"Medium"},
  {name:"Chris Fedor",handle:"ChrisFedor",team:"Cleveland Cavaliers",outlet:"Cleveland Plain Dealer",tier:1,signal:"High"},
  {name:"Joe Vardon",handle:"joevardon",team:"Cleveland Cavaliers",outlet:"The Athletic",tier:1,signal:"High"},
  {name:"Kelsey Russo",handle:"kelseyyrusso",team:"Cleveland Cavaliers",outlet:"The Athletic",tier:1,signal:"High"},
  {name:"Evan Dammarell",handle:"AmnoteEvan",team:"Cleveland Cavaliers",outlet:"Fear The Sword",tier:2,signal:"High"},
  {name:"Dan Labbe",handle:"dan_labbe",team:"Cleveland Cavaliers",outlet:"cleveland.com",tier:2,signal:"Medium"},
  {name:"Camryn Justice",handle:"camijustice",team:"Cleveland Cavaliers",outlet:"WEWS NewsChannel 5",tier:2,signal:"Medium"},
  {name:"Omari Sankofa II",handle:"omarisankofa",team:"Detroit Pistons",outlet:"Detroit Free Press",tier:1,signal:"High"},
  {name:"Coty Davis",handle:"CotyDavis_24",team:"Detroit Pistons",outlet:"Detroit Free Press",tier:1,signal:"High"},
  {name:"James Edwards III",handle:"JLEdwardsIII",team:"Detroit Pistons",outlet:"The Athletic",tier:1,signal:"High"},
  {name:"Rod Beard",handle:"detnewsRodBeard",team:"Detroit Pistons",outlet:"Detroit News",tier:2,signal:"Medium"},
  {name:"Vince Ellis",handle:"vinceeellis",team:"Detroit Pistons",outlet:"Detroit Free Press",tier:2,signal:"Medium"},
  {name:"Dana Gauruder",handle:"DanaGauruder",team:"Detroit Pistons",outlet:"Detroit News",tier:2,signal:"Medium"},
  {name:"Dustin Dopirak",handle:"DustinDopirak",team:"Indiana Pacers",outlet:"The Athletic",tier:1,signal:"High"},
  {name:"Scott Agness",handle:"ScottAgness",team:"Indiana Pacers",outlet:"FieldhouseFiles.com",tier:1,signal:"High"},
  {name:"James Boyd",handle:"RomeovilleKid",team:"Indiana Pacers",outlet:"Indianapolis Star",tier:2,signal:"High"},
  {name:"Tony East",handle:"TEastNBA",team:"Indiana Pacers",outlet:"SI / Pacers Digest",tier:2,signal:"Medium"},
  {name:"Nate Taylor",handle:"ByNateTaylor",team:"Indiana Pacers",outlet:"The Athletic",tier:2,signal:"Medium"},
  {name:"Mark Montieth",handle:"MontieMedia",team:"Indiana Pacers",outlet:"Pacers.com",tier:2,signal:"Medium"},
  {name:"Ira Winderman",handle:"IraHeatBeat",team:"Miami Heat",outlet:"South Florida Sun Sentinel",tier:1,signal:"High"},
  {name:"Anthony Chiang",handle:"Anthony_Chiang",team:"Miami Heat",outlet:"Miami Herald",tier:1,signal:"High"},
  {name:"Shandel Richardson",handle:"ShandelRich",team:"Miami Heat",outlet:"Sun Sentinel",tier:2,signal:"High"},
  {name:"Brady Hawk",handle:"BradyHawk305",team:"Miami Heat",outlet:"ClutchPoints",tier:2,signal:"Medium"},
  {name:"Tim Reynolds",handle:"ByTimReynolds",team:"Miami Heat",outlet:"Associated Press",tier:2,signal:"High"},
  {name:"Jason Jackson",handle:"JacksonAndAudio",team:"Miami Heat",outlet:"Heat TV",tier:2,signal:"Medium"},
  {name:"Eric Nehm",handle:"eric_nehm",team:"Milwaukee Bucks",outlet:"The Athletic",tier:1,signal:"High"},
  {name:"Matt Velazquez",handle:"Matt_Velazquez",team:"Milwaukee Bucks",outlet:"Milwaukee Journal Sentinel",tier:1,signal:"High"},
  {name:"Jim Owczarski",handle:"JimOwczarski",team:"Milwaukee Bucks",outlet:"Milwaukee Journal Sentinel",tier:2,signal:"High"},
  {name:"James Bates",handle:"JamesBates_",team:"Milwaukee Bucks",outlet:"Brew Hoop",tier:2,signal:"Medium"},
  {name:"Phoebe Arscott",handle:"PArscott_",team:"Milwaukee Bucks",outlet:"Bally Sports Wisconsin",tier:2,signal:"Medium"},
  {name:"Jaymes Langrehr",handle:"jlangrehr",team:"Milwaukee Bucks",outlet:"WISN 12",tier:2,signal:"Medium"},
  {name:"Ian Begley",handle:"IanBegley",team:"New York Knicks",outlet:"SNY",tier:1,signal:"High"},
  {name:"Steve Popper",handle:"StevePopper",team:"New York Knicks",outlet:"Newsday",tier:1,signal:"High"},
  {name:"Kristian Winfield",handle:"Krisplashed",team:"New York Knicks",outlet:"NY Daily News",tier:1,signal:"High"},
  {name:"Fred Katz",handle:"FredKatz",team:"New York Knicks",outlet:"The Athletic",tier:2,signal:"High"},
  {name:"Marc Berman",handle:"NYPost_Berman",team:"New York Knicks",outlet:"New York Post",tier:2,signal:"High"},
  {name:"Alan Hahn",handle:"alanhahn",team:"New York Knicks",outlet:"MSG Network",tier:2,signal:"Medium"},
  {name:"Stefan Bondy",handle:"SBondyNYDN",team:"New York Knicks",outlet:"NY Daily News",tier:2,signal:"Medium"},
  {name:"Jason Beede",handle:"therealBeede",team:"Orlando Magic",outlet:"Orlando Sentinel",tier:1,signal:"High"},
  {name:"Khobi Price",handle:"khobi_price",team:"Orlando Magic",outlet:"Orlando Sentinel",tier:1,signal:"High"},
  {name:"Evan Dunlap",handle:"EvanDunlap13",team:"Orlando Magic",outlet:"ClutchPoints",tier:2,signal:"Medium"},
  {name:"Bo Churney",handle:"BoChurney",team:"Orlando Magic",outlet:"Locked On Magic",tier:2,signal:"Medium"},
  {name:"Josh Robbins",handle:"JoshuaBRobbins",team:"Orlando Magic",outlet:"The Athletic",tier:2,signal:"High"},
  {name:"Scott Anez",handle:"ScottAnez",team:"Orlando Magic",outlet:"AP",tier:2,signal:"Medium"},
  {name:"Keith Pompey",handle:"PompeyOnSixers",team:"Philadelphia 76ers",outlet:"Philadelphia Inquirer",tier:1,signal:"High"},
  {name:"Kyle Neubeck",handle:"KyleNeubeck",team:"Philadelphia 76ers",outlet:"PhillyVoice",tier:1,signal:"High"},
  {name:"Rich Hofmann",handle:"rich_hofmann",team:"Philadelphia 76ers",outlet:"The Athletic",tier:1,signal:"High"},
  {name:"Gina Mizell",handle:"GinaMizell",team:"Philadelphia 76ers",outlet:"Philadelphia Inquirer",tier:2,signal:"High"},
  {name:"Tony Jones",handle:"Tjonesonthenba",team:"Philadelphia 76ers",outlet:"The Athletic",tier:2,signal:"Medium"},
  {name:"Derek Bodner",handle:"DerekBodner",team:"Philadelphia 76ers",outlet:"The Athletic / IndyPHL",tier:2,signal:"Medium"},
  {name:"Josh Lewenberg",handle:"JLew1050",team:"Toronto Raptors",outlet:"TSN",tier:1,signal:"High"},
  {name:"Doug Smith",handle:"dougsmithstar",team:"Toronto Raptors",outlet:"Toronto Star",tier:1,signal:"High"},
  {name:"Michael Grange",handle:"michaelgrange",team:"Toronto Raptors",outlet:"Sportsnet",tier:1,signal:"High"},
  {name:"Eric Koreen",handle:"ekoreen",team:"Toronto Raptors",outlet:"The Athletic",tier:2,signal:"High"},
  {name:"Vivek Jacob",handle:"vivekjacob_",team:"Toronto Raptors",outlet:"Sportsnet",tier:2,signal:"High"},
  {name:"Blake Murphy",handle:"BlakeMurphyODC",team:"Toronto Raptors",outlet:"The Athletic / Raptors Republic",tier:2,signal:"Medium"},
  {name:"Josh Robbins",handle:"JoshuaBRobbins",team:"Washington Wizards",outlet:"The Athletic",tier:1,signal:"High"},
  {name:"Ava Wallace",handle:"avarwallace",team:"Washington Wizards",outlet:"Washington Post",tier:1,signal:"High"},
  {name:"Bijan Todd",handle:"bijan_todd",team:"Washington Wizards",outlet:"NBC Sports Washington",tier:1,signal:"High"},
  {name:"Chase Hughes",handle:"ChaseHughesNBC",team:"Washington Wizards",outlet:"NBC Sports Washington",tier:2,signal:"Medium"},
  {name:"Kareem Copeland",handle:"kareemcopeland",team:"Washington Wizards",outlet:"Washington Post",tier:2,signal:"Medium"},
  {name:"Zach Selby",handle:"ZachSelby_DC",team:"Washington Wizards",outlet:"Wizards.com",tier:2,signal:"Medium"},
  {name:"Tim MacMahon",handle:"espn_macmahon",team:"Dallas Mavericks",outlet:"ESPN",tier:1,signal:"High"},
  {name:"Brad Townsend",handle:"townbrad",team:"Dallas Mavericks",outlet:"Dallas Morning News",tier:1,signal:"High"},
  {name:"Callie Caplan",handle:"CallieCaplan",team:"Dallas Mavericks",outlet:"Dallas Morning News",tier:1,signal:"High"},
  {name:"Grant Afseth",handle:"GrantAfseth",team:"Dallas Mavericks",outlet:"ClutchPoints",tier:2,signal:"High"},
  {name:"Saad Yousuf",handle:"SaadYousuf126",team:"Dallas Mavericks",outlet:"The Athletic",tier:2,signal:"High"},
  {name:"Bennett Durando",handle:"BennettDurando",team:"Denver Nuggets",outlet:"Denver Post",tier:1,signal:"High"},
  {name:"Mike Singer",handle:"msinger",team:"Denver Nuggets",outlet:"Denver Post",tier:1,signal:"High"},
  {name:"Harrison Wind",handle:"HarrisonWind",team:"Denver Nuggets",outlet:"DNVR Sports",tier:2,signal:"High"},
  {name:"Adam Mares",handle:"adam_mares",team:"Denver Nuggets",outlet:"104.3 The Fan",tier:2,signal:"High"},
  {name:"Chris Dempsey",handle:"chrisadempsey",team:"Denver Nuggets",outlet:"Altitude Sports",tier:2,signal:"Medium"},
  {name:"Anthony Slater",handle:"anthonyVslater",team:"Golden State Warriors",outlet:"ESPN",tier:1,signal:"High"},
  {name:"Marcus Thompson",handle:"marcus_thompson",team:"Golden State Warriors",outlet:"The Athletic",tier:1,signal:"High"},
  {name:"Tim Kawkami",handle:"timkawakami",team:"Golden State Warriors",outlet:"SF Standard",tier:1,signal:"High"},
  {name:"Dalton Johnson",handle:"DaltonJ_",team:"Golden State Warriors",outlet:"NBC Sports Bay Area",tier:2,signal:"High"},
  {name:"Sam Gordon",handle:"bysamgordon",team:"Golden State Warriors",outlet:"NBC Sports Bay Area",tier:2,signal:"High"},
  {name:"Nick Friedell",handle:"NickFriedell",team:"Golden State Warriors",outlet:"ESPN",tier:2,signal:"High"},
  {name:"Jonathan Feigen",handle:"Jonathan_Feigen",team:"Houston Rockets",outlet:"Houston Chronicle",tier:1,signal:"High"},
  {name:"Kelly Iko",handle:"KellyIko",team:"Houston Rockets",outlet:"The Athletic",tier:1,signal:"High"},
  {name:"Ben DuBose",handle:"BenDuBose",team:"Houston Rockets",outlet:"Space City Home Network",tier:2,signal:"High"},
  {name:"Tomer Azarly",handle:"TomerAzarly",team:"LA Clippers",outlet:"ClutchPoints",tier:1,signal:"High"},
  {name:"Law Murray",handle:"LawMurrayTheNU",team:"LA Clippers",outlet:"The Athletic",tier:1,signal:"High"},
  {name:"Joey Linn",handle:"joeylinn_",team:"LA Clippers",outlet:"The Athletic",tier:1,signal:"High"},
  {name:"Andrew Greif",handle:"AndrewGreif",team:"LA Clippers",outlet:"Los Angeles Times",tier:2,signal:"High"},
  {name:"Mike Trudell",handle:"LakersReporter",team:"Los Angeles Lakers",outlet:"Spectrum SportsNet",tier:1,signal:"High"},
  {name:"Dan Woike",handle:"DanWoike",team:"Los Angeles Lakers",outlet:"The Athletic",tier:1,signal:"High"},
  {name:"Dave McMenamin",handle:"mcten",team:"Los Angeles Lakers",outlet:"ESPN",tier:1,signal:"High"},
  {name:"Kyle Goon",handle:"kylegoon",team:"Los Angeles Lakers",outlet:"Southern California News Group",tier:2,signal:"High"},
  {name:"Jovan Buha",handle:"jovanbuha",team:"Los Angeles Lakers",outlet:"YouTube / Independent",tier:2,signal:"High"},
  {name:"Ohm Youngmisuk",handle:"NotoriousOHM",team:"Los Angeles Lakers",outlet:"ESPN",tier:2,signal:"High"},
  {name:"Damichael Cole",handle:"DamichaelC",team:"Memphis Grizzlies",outlet:"Memphis Commercial Appeal",tier:1,signal:"High"},
  {name:"Drew Hill",handle:"DrewHill_DM",team:"Memphis Grizzlies",outlet:"Memphis Commercial Appeal",tier:1,signal:"High"},
  {name:"Jon Krawczynski",handle:"JonKrawczynski",team:"Minnesota Timberwolves",outlet:"The Athletic",tier:1,signal:"High"},
  {name:"Chris Hine",handle:"ChristopherHine",team:"Minnesota Timberwolves",outlet:"Minneapolis Star Tribune",tier:1,signal:"High"},
  {name:"Dane Moore",handle:"DaneMooreNBA",team:"Minnesota Timberwolves",outlet:"Dane Moore NBA Podcast",tier:2,signal:"High"},
  {name:"Jim Eichenhofer",handle:"Jim_Eichenhofer",team:"New Orleans Pelicans",outlet:"Pelicans.com",tier:1,signal:"High"},
  {name:"Will Guillory",handle:"WillGuillory",team:"New Orleans Pelicans",outlet:"The Athletic",tier:1,signal:"High"},
  {name:"Christian Clark",handle:"cclark_13",team:"New Orleans Pelicans",outlet:"New Orleans Times-Picayune",tier:2,signal:"High"},
  {name:"Andrew Lopez",handle:"_Andrew_Lopez",team:"New Orleans Pelicans",outlet:"ESPN",tier:2,signal:"High"},
  {name:"Brandon Rahbar",handle:"BrandonRahbar",team:"Oklahoma City Thunder",outlet:"Daily Thunder",tier:1,signal:"High"},
  {name:"Joel Lorenzi",handle:"jxlorenzi",team:"Oklahoma City Thunder",outlet:"The Oklahoman",tier:1,signal:"High"},
  {name:"Rylan Stiles",handle:"Rylan_Stiles",team:"Oklahoma City Thunder",outlet:"Inside The Thunder / Locked On",tier:1,signal:"High"},
  {name:"Gerald Bourguet",handle:"GeraldBourguet",team:"Phoenix Suns",outlet:"PHNX Media",tier:1,signal:"High"},
  {name:"Duane Rankin",handle:"DuaneRankin",team:"Phoenix Suns",outlet:"Arizona Republic",tier:1,signal:"High"},
  {name:"Kellan Olson",handle:"kellanolson",team:"Phoenix Suns",outlet:"Arizona Republic",tier:2,signal:"High"},
  {name:"Casey Holdahl",handle:"CHold",team:"Portland Trail Blazers",outlet:"TrailBlazers.com",tier:1,signal:"High"},
  {name:"Jason Quick",handle:"jwquick",team:"Portland Trail Blazers",outlet:"The Athletic",tier:1,signal:"High"},
  {name:"Sean Highkin",handle:"highkin",team:"Portland Trail Blazers",outlet:"Rose Garden Report",tier:2,signal:"High"},
  {name:"James Ham",handle:"James_HamNBA",team:"Sacramento Kings",outlet:"NBC Sports California",tier:1,signal:"High"},
  {name:"Jason Anderson",handle:"JandersonSacBee",team:"Sacramento Kings",outlet:"Sacramento Bee",tier:1,signal:"High"},
  {name:"Sean Cunningham",handle:"seancunningham45",team:"Sacramento Kings",outlet:"ABC10 Sacramento",tier:2,signal:"High"},
  {name:"Jeff McDonald",handle:"JMcDonald_SAEN",team:"San Antonio Spurs",outlet:"San Antonio Express-News",tier:1,signal:"High"},
  {name:"Tom Orsborn",handle:"tom_orsborn",team:"San Antonio Spurs",outlet:"San Antonio Express-News",tier:1,signal:"High"},
  {name:"Paul Garcia",handle:"PaulGarciaNBA",team:"San Antonio Spurs",outlet:"Project Spurs / Locked On",tier:2,signal:"High"},
  {name:"Andy Larsen",handle:"andyblarsen",team:"Utah Jazz",outlet:"Salt Lake Tribune",tier:1,signal:"High"},
  {name:"Eric Walden",handle:"tribjazz",team:"Utah Jazz",outlet:"Salt Lake Tribune",tier:1,signal:"High"},
  {name:"Sarah Todd",handle:"NBASarah",team:"Utah Jazz",outlet:"KSL Sports",tier:2,signal:"High"},
  {name:"Jody Genessy",handle:"DJJazzyJody",team:"Utah Jazz",outlet:"Deseret News",tier:2,signal:"High"},
  {name:"Shams Charania",handle:"ShamsCharania",team:"All Teams",outlet:"ESPN",tier:1,signal:"High"},
  {name:"Marc Stein",handle:"TheSteinLine",team:"All Teams",outlet:"Substack / Independent",tier:1,signal:"High"},
  {name:"Chris Haynes",handle:"ChrisBHaynes",team:"All Teams",outlet:"TNT / Bleacher Report",tier:1,signal:"High"},
  {name:"Jake Fischer",handle:"JakeLFischer",team:"All Teams",outlet:"Yahoo Sports",tier:1,signal:"High"},
  {name:"Sam Amick",handle:"sam_amick",team:"All Teams",outlet:"The Athletic",tier:1,signal:"High"},
  {name:"Brian Windhorst",handle:"WindhorstESPN",team:"All Teams",outlet:"ESPN",tier:2,signal:"High"},
  {name:"Ramona Shelburne",handle:"ramonashelburne",team:"All Teams",outlet:"ESPN",tier:2,signal:"High"},
];

// Build a quick lookup: handle → reporter info
const REPORTER_MAP = {};
REPORTERS.forEach(r => { REPORTER_MAP[r.handle.toLowerCase()] = r; });

// ─── INJURY KEYWORDS ──────────────────────────────────────────────────────────
const INJURY_KEYWORDS = [
  'out tonight','ruled out','will not play',"won't play",'wont play',
  'not playing','did not practice','dnp','scratched',
  'questionable','doubtful','probable','gtd','game-time',
  'listed as','on the injury report','load management',
  'knee','ankle','hamstring','achilles','back injury','shoulder',
  'hip','groin','calf','foot injury','wrist','elbow',
  'concussion','illness','sore','soreness','sprain','strain',
  'day-to-day','week-to-week','out indefinitely','ruled out',
];

function isInjuryTweet(text) {
  const lower = text.toLowerCase();
  return INJURY_KEYWORDS.some(kw => lower.includes(kw));
}

// ─── STATUS EXTRACTION ────────────────────────────────────────────────────────
function extractStatus(text) {
  const t = text.toLowerCase();
  if (/ruled out|will not play|won'?t play|is out|out tonight|not playing|scratched|dnp/.test(t)) return 'Out';
  if (/doubtful/.test(t)) return 'Doubtful';
  if (/game.time decision|gtd/.test(t)) return 'Game-Time Decision';
  if (/questionable/.test(t)) return 'Questionable';
  if (/probable/.test(t)) return 'Probable';
  return 'Questionable';
}

function extractBodyPart(text) {
  const t = text.toLowerCase();
  const parts = ['ankle','knee','hamstring','achilles','back','shoulder','hip','groin','calf','foot','wrist','elbow','hand','concussion','illness'];
  return parts.find(p => t.includes(p)) || 'undisclosed';
}

function extractPlayer(text) {
  const patterns = [
    /^([A-Z][a-z]+(?: [A-Z][a-z'-]+)+)\s+(?:is|will|won'?t|has|was)/,
    /([A-Z][a-z]+(?: [A-Z][a-z'-]+)+)\s+(?:is|will not|won'?t)\s+(?:play|out|questionable|doubtful)/i,
    /([A-Z][a-z]+(?: [A-Z][a-z'-]+){1,2})\s+(?:listed|ruled|scratched|inactive)/i,
    /([A-Z][a-z]+(?: [A-Z][a-z'-]+)+)\s+(?:\(|—|-)\s*(?:ankle|knee|hamstring|back|shoulder)/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m?.[1]?.length > 3) return m[1];
  }
  return null;
}

function calcConfidence(reporter, status) {
  const tierScore   = reporter.tier === 1 ? 40 : reporter.tier === 2 ? 25 : 10;
  const signalScore = reporter.signal === 'High' ? 35 : 20;
  const statusScore = status === 'Out' ? 15 : status === 'Doubtful' ? 12 : status === 'Questionable' ? 8 : 5;
  return Math.min(99, tierScore + signalScore + statusScore) / 100;
}

// ─── IN-MEMORY STORE ─────────────────────────────────────────────────────────
// Stores the last 6 hours of injury reports. Resets on server restart.
let injuryCache = [];
const seenTweetIds = new Set();
const SIX_HOURS = 6 * 60 * 60 * 1000;

function pruneOldReports() {
  const cutoff = Date.now() - SIX_HOURS;
  injuryCache = injuryCache.filter(r => new Date(r.timestamp).getTime() > cutoff);
}

// ─── TWEETAPI POLLING ─────────────────────────────────────────────────────────
const TWEETAPI_KEY = process.env.TWEETAPI_KEY;

async function pollTweetAPI() {
  if (!TWEETAPI_KEY) {
    console.log('No TWEETAPI_KEY set — skipping poll');
    return;
  }

  console.log(`[${new Date().toISOString()}] Polling TweetAPI...`);

  // Build search query: injury terms from our reporters only
  const handles = REPORTERS.filter(r => r.tier === 1).map(r => `from:${r.handle}`).join(' OR ');
  const injuryTerms = '(out tonight OR questionable OR "game-time" OR "ruled out" OR "will not play" OR doubtful OR GTD OR probable OR injury OR "load management" OR ankle OR knee OR hamstring)';
  const query = `(${handles}) ${injuryTerms} -is:retweet lang:en`;

  try {
    const response = await axios.get('https://api.tweetapi.com/tw-v2/search', {
      headers: { 'X-API-Key': TWEETAPI_KEY },
      params:  { query, type: 'Latest' },
      timeout: 15000,
    });

    const tweets = response.data?.data || [];
    let found = 0;

    for (const tweet of tweets) {
      if (seenTweetIds.has(tweet.id)) continue;
      if (!isInjuryTweet(tweet.text)) continue;

      const authorHandle = (tweet.author?.username || tweet.authorUsername || '').toLowerCase();
      const reporter = REPORTER_MAP[authorHandle];
      if (!reporter) continue;

      seenTweetIds.add(tweet.id);

      const status  = extractStatus(tweet.text);
      const body    = extractBodyPart(tweet.text);
      const player  = extractPlayer(tweet.text);
      const conf    = Math.round(calcConfidence(reporter, status) * 100);

      injuryCache.unshift({
        id:         tweet.id,
        player:     player || 'Unknown Player',
        team:       reporter.team,
        injury:     body.charAt(0).toUpperCase() + body.slice(1),
        body,
        status,
        confidence: conf,
        reporter:   reporter.name,
        handle:     '@' + reporter.handle,
        outlet:     reporter.outlet,
        tier:       reporter.tier,
        tweet:      tweet.text,
        timestamp:  tweet.created_at || new Date().toISOString(),
        corroborators: [],
      });
      found++;
    }

    console.log(`  Found ${found} new injury tweets (${injuryCache.length} total cached)`);
  } catch (err) {
    console.error('TweetAPI error:', err.response?.data || err.message);
  }

  pruneOldReports();
}

// ─── API ROUTES ───────────────────────────────────────────────────────────────
app.use(cors());

// No API key required — public endpoints

// Health check — public, no auth needed
app.get('/health', (req, res) => {
  res.json({ status: 'ok', cached: injuryCache.length, lastPoll: lastPollTime });
});

// Main endpoint — what your dashboard calls
app.get('/v1/injuries/live', (req, res) => {
  pruneOldReports();
  const sorted = [...injuryCache].sort((a, b) => {
    const order = { Out: 0, Doubtful: 1, Questionable: 2, 'Game-Time Decision': 3, Probable: 4 };
    return (order[a.status] ?? 5) - (order[b.status] ?? 5) || b.confidence - a.confidence;
  });
  res.json({ injuries: sorted, count: sorted.length, as_of: new Date() });
});

// ─── START ────────────────────────────────────────────────────────────────────
let lastPollTime = null;

async function startServer() {
  app.listen(PORT, () => {
    console.log(`InjuryWire API running on port ${PORT}`);
    console.log(`TWEETAPI_KEY: ${TWEETAPI_KEY ? 'SET ✓' : 'NOT SET — running without live data'}`);
    console.log(`API_KEY: ${process.env.API_KEY ? 'SET ✓' : 'NOT SET'}`);
  });

  // Poll immediately on startup, then every 10 minutes
  await pollTweetAPI();
  lastPollTime = new Date().toISOString();
  setInterval(async () => {
    await pollTweetAPI();
    lastPollTime = new Date().toISOString();
  }, 10 * 60 * 1000);
}

startServer();
