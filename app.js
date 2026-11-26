// ---------- Mission-driven crew (data lives in mission.js) ----------
// Hydrate runtime crew from MISSION: names/pods/baselines/wearables come only from there.
const THRESHOLDS = MISSION.thresholds; // same numeric rules as before — do not invent new ones
const CREW = MISSION.crew.map(c => ({
  id: c.id,
  name: c.name,
  role: c.role,
  loc: c.pod, // ship panel + UI still use .loc
  pod: c.pod,
  isBackupMedic: !!c.isBackupMedic,
  baseHR: c.baselines.restingHR,
  baseSpO2: c.baselines.spo2,
  baseSleep: c.baselines.sleepHours,
  rad: c.rad,
  wearables: { wristband: c.wearables.wristband, vest: c.wearables.vest },
  hist: c.hist,
  histDemo: c.histDemo || null,
  symptoms: "none logged yet",
}));

const TICK_MS = 3000, RECHECK_MS = 30000; // 30 s of demo time stands in for 10 minutes
const RANK = { green:0, watch:1, alert:2 };
// Kill any leftover TTS from an older tab/script as soon as this file loads
if (window.speechSynthesis) try { speechSynthesis.cancel(); } catch (e) { /* ignore */ }
const LV = { ok:"OK", log:"LOG", act:"ACT NOW", emergency:"EMERGENCY" };
const LRANK = { ok:0, log:1, act:2, emergency:3 };
const CLS = { ok:"green", log:"watch", act:"alert", emergency:"alert" };
const CAT = { fix:"Fix it onboard", hold:"Hold the line", earth:"Needs Earth" };

// Gemini UI status mapping (level ok→ok, log→watch, act→emergency, emergency→emergency; earth if top issue)
const STATUS_META = {
  ok: { label: "OK", hex: "#38BDF8", pillBg: "rgba(56,189,248,0.16)", pillBorder: "rgba(56,189,248,0.42)", pillText: "#7DD3FC", priority: "ROUTINE" },
  watch: { label: "LOG / Watch", hex: "#FBBF24", pillBg: "rgba(251,191,36,0.16)", pillBorder: "rgba(251,191,36,0.45)", pillText: "#FDE68A", priority: "WATCH LOG" },
  emergency: { label: "ACT NOW", hex: "#FB7185", pillBg: "rgba(251,113,133,0.18)", pillBorder: "rgba(251,113,133,0.5)", pillText: "#FDA4AF", priority: "IMMEDIATE ACTION" },
  earth: { label: "Needs Earth", hex: "#BAE6FD", pillBg: "rgba(186,230,253,0.16)", pillBorder: "rgba(186,230,253,0.45)", pillText: "#E0F2FE", priority: "EARTH ASYNC" },
};
function uiStatusKey(a) {
  const top = a.issues && a.issues[0];
  if (top && top.cat === "earth") return "earth";
  if (a.level === "ok") return "ok";
  if (a.level === "log") return "watch";
  return "emergency"; // act + emergency
}
function uiStatusOf(a) { return STATUS_META[uiStatusKey(a)]; }
let currentScreen = "setup";

// Wearable pairing map: device ID → crew id (simulated). Unknown IDs are logged and ignored.
const pairing = Object.create(null); // deviceId -> crewId
const deviceState = Object.create(null); // live readings keyed by wearable ID
const quietCrew = new Set(); // crew ids with no band signal
const unknownSeen = Object.create(null);
let bandSwapCount = 0;
function rebuildPairing() {
  Object.keys(pairing).forEach(k => delete pairing[k]);
  CREW.forEach(a => {
    pairing[a.wearables.wristband] = a.id;
    pairing[a.wearables.vest] = a.id;
  });
}
rebuildPairing();
function crewById(id) { return CREW.find(c => c.id === id); }
function personFromDevice(deviceId) {
  const cid = pairing[deviceId];
  if (!cid) {
    if (!unknownSeen[deviceId]) {
      unknownSeen[deviceId] = true;
      say("Unknown device: " + deviceId + " (simulated). Ignoring its data.");
    }
    return null;
  }
  return crewById(cid);
}

const GUIDE = {
  hr:{ title:"Heart rate", how:"Sit still for 5 minutes. Put two fingers on the inside of your wrist, or use the wearable band. Count beats for 30 seconds and double it.", why:"A resting heart rate that climbs above your own normal is an early sign of stress, poor sleep, dehydration, infection or heart strain.", off:"Rest, breathe slowly and measure again in 10 minutes. If it stays high, or you feel chest pain or dizziness, tell the crew medic." },
  spo2:{ title:"Blood oxygen (SpO₂)", how:"Warm your hands, clip the pulse oximeter on a finger and keep still. Wait about 30 seconds until the number stops changing.", why:"SpO₂ shows how much oxygen your blood is carrying. Low values can point to a cabin air problem or a breathing or heart problem.", off:"Rest, breathe slowly and re-check in 15 minutes. If it stays below 92%, notify the crew medic and check cabin ventilation." },
  bp:{ title:"Blood pressure", how:"Sit for 5 minutes with your arm supported at heart level. Put the cuff on your bare upper arm, stay still and quiet, and press start.", why:"High blood pressure strains the heart and blood vessels, and spaceflight shifts body fluids, so changes can show up early.", off:"Sit quietly for 5 minutes and measure again. If it is still high, notify the crew medic." },
  temp:{ title:"Body temperature", how:"Use the thermometer as the label says, at least 30 minutes after exercise or a hot drink. Wait for the beep before reading.", why:"A fever can mean infection, and spaceflight can weaken the immune system. A low temperature can mean the body is losing heat.", off:"Rest, drink fluids and measure again in an hour. If it is outside the normal range, notify the crew medic." },
  ex:{ title:"Exercise (bones and muscles)", how:"Log treadmill, bike or resistance time on the wearable or the cabin board. Count only active minutes, not rest between sets.", why:"In microgravity, bones and muscles lose strength without load. The team design target is about 60 minutes of exercise a day.", off:"If you are under 30 minutes, plan a make-up session today. If under 15 minutes, tell the crew medic and adjust the workload so exercise fits in." },
  sleep:{ title:"Sleep and mind", how:"Check last night's sleep hours and today's stress score (1–5) on the wearable summary.", why:"Short sleep and rising stress often show up before other vital signs drift. A multi-day sleep drop with a rising resting heart rate is an early warning trend.", off:"Lighten the workload, protect an early night, and talk to the crew medic if stress stays high." },
  rad:{ title:"Radiation", how:"Read the personal dosimeter percentage of the mission allowance on the cabin board.", why:"Cumulative dose limits how much EVA and unshielded time is safe. High values need a plan with Earth.", off:"Limit EVA, stay in shielded areas, and review the schedule with the commander. At very high dose, plan the return with Earth." },
};
const EMERGENCY = { title:"Emergency: crewmate has collapsed or has chest pain", steps:[
  "Call for help. Alert the crew and the crew medic, and tell Mission Control.",
  "Check the person. Do they respond when you speak to them? Are they breathing normally?",
  "If they do not respond and are not breathing normally, start chest compressions (hard and fast, centre of the chest) and use the defibrillator if there is one. Follow its voice prompts.",
  "If they are awake with chest pain, stop all activity, help them sit or lie comfortably, loosen tight clothing and keep them calm. Stay with them.",
  "Measure heart rate, SpO₂ and blood pressure again and read the numbers to the crew medic. Write down when symptoms started." ] };

// ---------- OBSERVE: simulated live readings per wearable ID, then map to person ----------
const state = {}; CREW.forEach(a => {
  state[a.id] = { hr: a.baseHR, spo2: a.baseSpO2, sys: 112, dia: 72, temp: 36.9, online: true };
  deviceState[a.wearables.wristband] = { hr: a.baseHR, spo2: a.baseSpO2, sys: 112, dia: 72 };
  deviceState[a.wearables.vest] = { temp: 36.9 };
});
const cabin = { co2:900, temp:22 };
// Last time BP / temperature were logged (tap guide / voice) — for "how do I measure" context only. No timed reminders.
const lastVitalLog = {}; CREW.forEach(a => { lastVitalLog[a.id] = { bp:Date.now(), temp:Date.now() }; });
let lastMeasureKind = "bp"; // which guide "how do I measure it" should open
let demoOn = false, demoOffset = 0;
const walk = (v,t,p,n) => v + (t - v) * p + (Math.random() - .5) * n;

function observe() {
  demoOffset = demoOn ? Math.min(20, demoOffset + 2) : Math.max(0, demoOffset - 4);
  // 1) Generate a packet for every known device ID (and any stray unknown IDs we are simulating)
  const incomingIds = new Set(Object.keys(deviceState));
  // Demo hook: occasionally include a garbage ID so Unknown device handling is visible once
  if (observe._ticks === undefined) observe._ticks = 0;
  observe._ticks++;
  if (observe._ticks === 2) incomingIds.add("WB-UNKNOWN");

  incomingIds.forEach(id => {
    const person = personFromDevice(id);
    if (!person) return; // unknown: already logged; ignore data
    if (quietCrew.has(person.id)) return; // band goes quiet — no packet applied
    const off = (person.id === MISSION.demoCrewId) ? demoOffset : 0;
    const onEva = person.id === evaCrewId;
    // Suit workload while outside: higher HR, mild SpO2 dip, warmer suit (simulated)
    const evaHr = onEva ? 22 : 0;
    const evaSpo2 = onEva ? 2.2 : 0;
    const evaSys = onEva ? 10 : 0;
    const evaTemp = onEva ? 0.35 : 0;
    if (!deviceState[id]) deviceState[id] = {};
    const d = deviceState[id];
    if (id === person.wearables.wristband) {
      d.hr = walk(d.hr != null ? d.hr : person.baseHR, person.baseHR + off + evaHr, (off || onEva) ? .4 : .15, onEva ? 3 : 2);
      d.spo2 = Math.min(100, walk(d.spo2 != null ? d.spo2 : person.baseSpO2, person.baseSpO2 - off / 5 - evaSpo2, .2, .8));
      d.sys = walk(d.sys != null ? d.sys : 112, 112 + off + evaSys, .15, 4);
      d.dia = walk(d.dia != null ? d.dia : 72, 72 + (onEva ? 4 : 0), .15, 3);
    }
    if (id === person.wearables.vest) {
      d.temp = walk(d.temp != null ? d.temp : 36.9, 36.9 + evaTemp, .2, .15);
    }
  });

  // 2) Map paired device readings onto each person (names only from mission crew)
  CREW.forEach(a => {
    const s = state[a.id];
    if (quietCrew.has(a.id)) { s.online = false; return; }
    s.online = true;
    const band = deviceState[a.wearables.wristband] || {};
    const vest = deviceState[a.wearables.vest] || {};
    if (band.hr != null) s.hr = band.hr;
    if (band.spo2 != null) s.spo2 = band.spo2;
    if (band.sys != null) s.sys = band.sys;
    if (band.dia != null) s.dia = band.dia;
    if (vest.temp != null) s.temp = vest.temp;
  });
  cabin.co2 = walk(cabin.co2, 900, .1, 40); cabin.temp = walk(cabin.temp, 22, .2, .2);
}
const histOf = a => (demoOn && demoOffset >= 10 && a.histDemo) ? a.histDemo : a.hist;

// ---------- ASSESS: same rules as before, values read from MISSION.thresholds ----------
function evaluate(a, s, h) {
  const out = [], add = (key, level, title, action, cat = "fix") => out.push({ key, level, title, action, cat });
  const T = THRESHOLDS;
  const hr = Math.round(s.hr), dev = hr - a.baseHR, sp = Math.round(s.spo2), sys = Math.round(s.sys), dia = Math.round(s.dia), t = s.temp;
  if (hr > T.hr.alertHigh || dev > T.hr.alertDev) add("hr","alert","Alert: heart rate far above your baseline.","Action: stop activity, sit and breathe slowly, re-check in 10 min, notify the crew medic if it stays high.");
  else if (hr < T.hr.alertLow) add("hr","alert","Alert: very low heart rate.","Action: sit down, check for dizziness, notify the crew medic now.");
  else if (hr > T.hr.watchHigh || dev > T.hr.watchDev) add("hr","watch","Watch: cardiovascular strain.","Action: reduce workload today, 30-min light exercise, extra sleep tonight.");
  else if (hr < T.hr.watchLow) add("hr","watch","Watch: low resting heart rate.","Action: rest 5 min and re-measure, tell the crew medic if you feel dizzy.");
  if (sp < T.spo2.alert) add("spo2","alert","Alert: low oxygen saturation.","Action: rest, slow breathing, re-check in 15 min, notify crew medic if it stays below 92%.");
  else if (sp < T.spo2.watch) add("spo2","watch","Watch: oxygen a little low.","Action: rest, slow breathing, check cabin ventilation, re-check in 15 min.");
  if (sys >= T.bp.alertSys || dia >= T.bp.alertDia) add("bp","alert","Alert: very high blood pressure.","Action: sit quietly 5 min, measure again, notify the crew medic if still high.");
  else if (sys >= T.bp.watchSys || dia >= T.bp.watchDia) add("bp","watch","Watch: raised blood pressure.","Action: rest, avoid salty food today, measure again in 30 min.");
  if (t > T.temp.alertHigh || t < T.temp.alertLow) add("temp","alert","Alert: abnormal body temperature.","Action: re-measure, rest, drink fluids, notify the crew medic now.");
  else if (t > T.temp.watchHigh || t < T.temp.watchLow) add("temp","watch","Watch: temperature outside normal range.","Action: rest, drink fluids, re-measure in 1 hour.");
  const sl = h.sleep[6], sl2 = h.sleep[5], st = h.stress[6], st2 = h.stress[5];
  if (sl < T.sleep.alert || (sl < T.sleep.alertTwo && sl2 < T.sleep.alertTwo)) add("sleep","alert","Alert: not enough sleep.","Action: lighter workload today, extra sleep tonight, tell the crew medic.");
  else if (sl < T.sleep.watch) add("sleep","watch","Watch: short sleep.","Action: lighter workload, early night.");
  if (st >= T.stress.alert || (st >= T.stress.alertTwo && st2 >= T.stress.alertTwo)) add("stress","alert","Alert: high stress.","Action: talk to the crew medic, take a rest period, check in again tomorrow.");
  else if (st >= T.stress.watch) add("stress","watch","Watch: raised stress.","Action: short rest period, check in again tomorrow.");
  const ex = h.ex[6];
  if (ex < T.ex.alert) add("ex","alert","Alert: exercise far below the daily target.","Action: protect time for a make-up session today, tell the crew medic, and review the workload.");
  else if (ex < T.ex.watch) add("ex","watch","Watch: exercise under 30 minutes today.","Action: add a session before sleep; target about 60 minutes.");
  if (a.rad >= T.rad.alert) add("rad","alert","Alert: radiation dose at " + a.rad + "% of allowance.","Action: no EVA, stay in the shielded area, plan the return with Earth.","earth");
  else if (a.rad >= T.rad.watch) add("rad","watch","Watch: cumulative dose high.","Action: limit EVA time, review shielding schedule with the commander.","hold");
  if (h.sleep[4] > h.sleep[5] && h.sleep[5] > h.sleep[6] && h.hr[6] - h.hr[3] >= T.trend.hrRise)
    add("trend","watch","Watch: sleep fell three nights in a row while resting heart rate rose " + (h.hr[6] - h.hr[3]) + " bpm.","Action: reduce workload, 30-min light exercise, extra sleep, talk to the crew medic.");
  return out.sort((x, y) => RANK[y.level] - RANK[x.level]);
}

// ---------- Body lights: worst status among existing issue keys (no second threshold set) ----------
const BODY = [
  { id:"heart", label:"Heart", keys:["hr","bp"], guide:"hr", value:(a,s,h) => Math.round(s.hr) + " bpm" },
  { id:"breath", label:"Breathing", keys:["spo2"], guide:"spo2", value:(a,s,h) => Math.round(s.spo2) + "%" },
  { id:"mind", label:"Sleep and mind", keys:["sleep","stress","trend"], guide:"sleep", value:(a,s,h) => h.sleep[6] + " h" },
  { id:"bones", label:"Bones and muscles", keys:["ex"], guide:"ex", value:(a,s,h) => h.ex[6] + " min" },
  { id:"infect", label:"Infection", keys:["temp"], guide:"temp", value:(a,s,h) => s.temp.toFixed(1) + " °C" },
  { id:"rad", label:"Radiation", keys:["rad"], guide:"rad", value:(a,s,h) => a.rad + "%" },
];
function bodyLight(a, s, h, b) {
  // Pick the worst level among this light's signals from evaluate() results
  let level = "green", earth = false;
  a.issues.forEach(i => {
    if (!b.keys.includes(i.key)) return;
    if (RANK[i.level] > RANK[level]) level = i.level;
    if (i.cat === "earth") earth = true;
  });
  const cls = earth ? "earth" : level; // violet when Needs Earth; else green / watch / alert
  const tag = earth ? "Needs Earth" : level === "alert" ? "Alert" : level === "watch" ? "Watch" : "OK";
  return `<button type="button" class="body-light ${cls}" data-guide="${b.guide}" aria-label="${b.label}: ${tag}, ${b.value(a,s,h)}">
    <span class="bl-dot" aria-hidden="true"></span>
    <span class="bl-text"><span class="bl-label">${b.label}</span><span class="bl-val">${b.value(a,s,h)}</span><span class="bl-tag">${tag}</span></span>
  </button>`;
}

// ---------- DECIDE / ACT / FOLLOW UP ----------
const held = {}, lastLevel = {}, recheck = {}, escalated = {}, logItems = [];
const lastPatternKey = {}; // crewId -> joined pattern ids (for proactive pattern alerts)
const justAnnounced = {}; // crewId -> timestamp (avoid double-speaking)
let verdict = "";
const clock = () => new Date().toLocaleTimeString([], { hour12:false });
// Dual clocks: Earth = real UTC; Space = Mission Elapsed Time (MET) from mission day + session
const shipSessionStart = Date.now();
function pad2(n) { return String(n).padStart(2, "0"); }
function formatHMS(totalSec) {
  const s = Math.max(0, Math.floor(totalSec));
  const hh = Math.floor(s / 3600) % 24;
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return pad2(hh) + ":" + pad2(mm) + ":" + pad2(ss);
}
function earthUtcParts(d) {
  return {
    time: pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes()) + ":" + pad2(d.getUTCSeconds()),
    date: d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }) + " UTC",
  };
}
function lightDelayMinutes() {
  // Simulated one-way light time grows along the Mars coast (demo formula, not ephemeris)
  return Math.min(22, Math.round(3.5 + MISSION.day * 0.085));
}
function updateDualClocks() {
  const shipEl = document.getElementById("shipTime");
  const shipSub = document.getElementById("shipTimeSub");
  const earthEl = document.getElementById("earthTime");
  const earthSub = document.getElementById("earthTimeSub");
  const clockMet = document.getElementById("clock-met");
  const clockUtc = document.getElementById("clock-utc");
  const capTs = document.getElementById("caption-timestamp");
  const now = new Date();
  const earth = earthUtcParts(now);
  const elapsedSec = (Date.now() - shipSessionStart) / 1000;
  const metHms = formatHMS(elapsedSec);
  const metLine = "MD " + MISSION.day + " · " + metHms;
  const utcLine = earth.time + " UTC";
  const delay = lightDelayMinutes();
  if (earthEl) earthEl.textContent = earth.time;
  if (earthSub) earthSub.textContent = earth.date;
  if (shipEl) shipEl.textContent = metHms;
  if (shipSub) shipSub.textContent = "MET Day " + MISSION.day + " · delay ~" + delay + " min";
  if (clockMet) clockMet.textContent = metLine;
  if (clockUtc) clockUtc.textContent = utcLine;
  if (capTs) capTs.textContent = "MD " + MISSION.day + " · " + metHms.slice(0, 5);
}
function say(text) { logItems.unshift({ t:clock(), text }); if (logItems.length > 50) logItems.pop(); }
// Primary medic = crew with medic in role who is not the backup; else backup / anyone else
function medicFor(a) {
  const primary = CREW.find(c => /medic/i.test(c.role) && !c.isBackupMedic) || CREW.find(c => /medic/i.test(c.role));
  const backup = CREW.find(c => c.isBackupMedic) || CREW.find(c => c.id !== a.id);
  if (primary && a.id === primary.id) return backup || CREW.find(c => c.id !== a.id) || primary;
  return primary || backup || CREW[0];
}

// Ship panel state (all simulated): pod speech + medic page card
const ship = {
  speak: { loc:"", msg:"", until:0 },
  page: { medic:"", medicLoc:"", patient:"", why:"", until:0 },
};
function setShipSpeak(loc, msg) {
  ship.speak = { loc, msg, until: Date.now() + 20000 };
}
function setShipPage(patient, why) {
  const m = medicFor(patient);
  ship.page = {
    medic: m.name, medicLoc: m.loc, patient: patient.name, why,
    until: Date.now() + 45000,
  };
}
// Pod light follows sleep using the same thresholds as evaluate() (no second rule set)
function sleepLightClass(a) {
  const h = a.cur || histOf(a), sl = h.sleep[6], sl2 = h.sleep[5], T = THRESHOLDS.sleep;
  if (sl < T.alert || (sl < T.alertTwo && sl2 < T.alertTwo)) return "alert";
  if (sl < T.watch) return "watch";
  return "green";
}

// ---------- NASA-aligned pattern catalog (spaceflight-patterns.json) — match only, never diagnose ----------
let PATTERN_CATALOG = null;
let opsContext = ""; // "" or "eva_or_prebreathe" (Settings / EVA)
let evaCrewId = null; // who is outside on EVA — hub/ATLAS focus this person
let evaStartedAt = 0;
function symptomTokens(a) {
  const raw = String(a.symptoms || "").toLowerCase();
  if (!raw || /none/.test(raw) || /not logged/.test(raw)) return [];
  return raw.split(/,|;|\band\b/).map(s => s.trim()).filter(Boolean);
}
function buildFacts(a) {
  const s = state[a.id], h = histOf(a) || a.cur || a.hist;
  const shared = CREW.filter(c => (c.issues || []).some(i => i.key === "hr" || i.key === "spo2")).length;
  return {
    hr: s.hr, spo2: s.spo2, sys: s.sys, dia: s.dia, temp: s.temp,
    sleepHours: h.sleep[6], stress: h.stress[6], exerciseMin: h.ex[6],
    radPercent: a.rad, cabinCo2: cabin.co2, cabinTemp: cabin.temp,
    hrDevFromBaseline: Math.abs(s.hr - a.baseHR),
    hrRiseOverDays: h.hr[6] - h.hr[3],
    symptoms: symptomTokens(a),
    sharedCrewVitalFlags: shared,
    opsContext: opsContext || "",
    triageLevel: a.level || "ok",
    matchedPatternCount: (a.patterns || []).length,
  };
}
function ruleFires(rule, facts) {
  const v = facts[rule.signal], op = rule.op, target = rule.value;
  if (op === "includes") {
    const list = Array.isArray(v) ? v : [];
    const needle = String(target).toLowerCase();
    return list.some(s => s.includes(needle) || needle.includes(s));
  }
  if (op === "in") return Array.isArray(target) && target.indexOf(v) >= 0;
  if (op === "eq") return v === target;
  if (v == null || typeof v === "object") return false;
  if (op === "lte") return v <= target;
  if (op === "lt") return v < target;
  if (op === "gte") return v >= target;
  if (op === "gt") return v > target;
  return false;
}
function matchPatternsFor(a) {
  if (!PATTERN_CATALOG || !PATTERN_CATALOG.patterns) return [];
  const facts = buildFacts(a);
  const hits = [];
  PATTERN_CATALOG.patterns.forEach(p => {
    if (p.id === "autonomy_distance_pattern") return; // second pass
    let score = 0;
    const fired = [];
    (p.match && p.match.rules || []).forEach(r => {
      if (ruleFires(r, facts)) { score += (r.weight || 1); fired.push(r.id); }
    });
    const min = (p.match && p.match.minScore) || 1;
    if (score >= min) {
      hits.push({
        id: p.id, name: p.name, score, fired,
        summary: p.summary,
        nasaRisk: p.nasaRisk,
        recommendations: p.recommendations || [],
        severityHint: p.severityHint || "log",
        notADiagnosis: true,
      });
    }
  });
  hits.sort((x, y) => y.score - x.score);
  facts.matchedPatternCount = hits.length;
  facts.triageLevel = a.level || "ok";
  const auto = PATTERN_CATALOG.patterns.find(p => p.id === "autonomy_distance_pattern");
  if (auto) {
    let score = 0;
    const fired = [];
    (auto.match.rules || []).forEach(r => {
      if (ruleFires(r, facts)) { score += (r.weight || 1); fired.push(r.id); }
    });
    if (score >= (auto.match.minScore || 1)) {
      hits.push({
        id: auto.id, name: auto.name, score, fired,
        summary: auto.summary, nasaRisk: auto.nasaRisk,
        recommendations: auto.recommendations || [],
        severityHint: auto.severityHint || "hold",
        notADiagnosis: true,
      });
    }
  }
  return hits.slice(0, 4);
}
function patternsReply(a) {
  const hits = a.patterns || matchPatternsFor(a);
  if (!PATTERN_CATALOG) return "The pattern catalog is still loading. Threshold triage still works. I recommend and do not diagnose.";
  if (!hits.length) return "No catalog patterns matched for " + first(a) + " right now. Threshold status is " + LV[a.level] + ". I recommend and do not diagnose.";
  const top = hits[0];
  const more = hits.slice(1, 3).map(h => h.name).join("; ");
  const tip = (top.recommendations[0] || "Notify the crew medic.");
  return first(a) + ": readings are consistent with \"" + top.name + "\" in the onboard NASA-aligned catalog (score " + top.score + "). "
    + tip + (more ? " Also nearby: " + more + "." : "")
    + " This is not a diagnosis. The medic decides treatment.";
}
function loadPatternCatalog() {
  return fetch("spaceflight-patterns.json?v=2")
    .then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then(data => {
      PATTERN_CATALOG = data;
      say("Pattern catalog loaded: " + data.patterns.length + " NASA-aligned patterns (recommend only).");
      if (typeof render === "function" && hubStarted) {
        CREW.forEach(a => { a.patterns = matchPatternsFor(a); });
        render();
      }
    })
    .catch(() => { say("Pattern catalog failed to load. Threshold rules still run."); });
}

function think() {
  CREW.forEach(a => {
    const s = state[a.id], h = histOf(a);
    a.issues = evaluate(a, s, h);
    if (s.spo2 < THRESHOLDS.emergency.spo2 || s.temp > THRESHOLDS.emergency.temp) held[a.id] = true; // emergencies are latched: the SI can only escalate, never downgrade
    const top = a.issues.length ? a.issues[0].level : "green";
    a.level = held[a.id] ? "emergency" : top === "alert" ? "act" : top === "watch" ? "log" : "ok";
    a.ready = Math.max(0, 100 - a.issues.reduce((n, i) => n + (i.level === "alert" ? 30 : 10), 0) - (held[a.id] ? 40 : 0));
    a.hist = a.hist; a.cur = h;
  });
  // Match curated catalog after triage levels exist (rules only — no SI diagnosis)
  CREW.forEach(a => { a.patterns = matchPatternsFor(a); });
  // person problem or station problem?
  const shared = CREW.filter(a => a.issues.some(i => i.key === "hr" || i.key === "spo2")).length;
  const sick = CREW.some(a => a.level !== "ok");
  const v = (cabin.co2 > THRESHOLDS.cabin.co2Station || shared >= 2) ? "Station problem likely: check cabin air before treating individuals."
          : sick ? "Person problem: the cabin looks normal and the change is in one crew member."
          : "All clear: the crew and the cabin are within their normal range.";
  if (v !== verdict) { verdict = v; say("Verdict: " + v); }
  CREW.forEach(a => {
    const prev = lastLevel[a.id] || "ok";
    if (a.level !== prev) {
      lastLevel[a.id] = a.level;
      if (LRANK[a.level] > LRANK[prev]) {
        const why = a.issues.slice(0, 2).map(i => i.title.replace(/^\w+: /, "").replace(/\.$/, "")).join("; ") || "emergency threshold crossed";
        say(a.name + ": " + LV[a.level] + ". Reason: " + why + ".");
        // Proactive: tell the person (and crew when ACT NOW / EMERGENCY)
        announce(a);
        justAnnounced[a.id] = Date.now();
        if (LRANK[a.level] >= 2) {
          const m = medicFor(a);
          const patientIsMedic = /medic/i.test(a.role) && !a.isBackupMedic;
          const pageWhy = patientIsMedic ? "Medic is the patient — backup paged." : "ACT NOW / EMERGENCY triage.";
          say("Paging " + m.name + " (" + m.loc + ") for " + a.name + (patientIsMedic ? ", because the medic is the patient, so the backup is paged." : ".") + " Case packet prepared.");
          setShipPage(a, pageWhy);
          recheck[a.id] = Date.now() + RECHECK_MS;
        }
      } else {
        say(a.name + " is back to " + LV[a.level] + ". Reason: readings moved back toward their normal.");
        if (a.level === "ok" || a.level === "log") { delete recheck[a.id]; delete escalated[a.id]; }
      }
    }
    if (recheck[a.id] && Date.now() > recheck[a.id]) {
      delete recheck[a.id];
      if (LRANK[a.level] >= 2) {
        escalated[a.id] = true;
        say("Recheck for " + a.name + " (10 min later): no improvement. Escalating: commander alerted, Earth summary to be prepared.");
        const esc = first(a) + ", your readings have not improved after recheck. I'm alerting the commander and preparing an Earth summary.";
        setCaptionSaid(esc); speak(esc, true); setShipSpeak(a.loc, esc);
      } else say("Recheck for " + a.name + " (10 min later): improving. No escalation needed.");
    }
    // New catalog pattern without another triage announce → still tell the person
    notifyNewPatterns(a);
  });
}

// ---------- Rendering (tablet: list | detail | triage) ----------
const crewEl = document.getElementById("crew"), summaryEl = document.getElementById("summary");
const detailEl = document.getElementById("detail"), triageEl = document.getElementById("triage");
const detailTop = document.getElementById("detailTop"), detailBottom = document.getElementById("detailBottom");
const logEl = document.getElementById("agentLog"), stationEl = document.getElementById("station"), shipEl = document.getElementById("ship");
let selectedId = CREW[0].id; // who is shown in the middle / triage panels
const levelFor = (iss, k) => (iss.find(i => i.key === k) || { level:"green" }).level;
const tile = (k, label, val, unit, lv) => `<div class="vital ${lv}" data-guide="${k}" role="button" tabindex="0" aria-label="${label}: how to measure"><dt>${label}</dt><dd>${val}<small>${unit}</small></dd></div>`;

// 7-day trend chart — uses histOf / a.cur so Ortega's demo decline appears when histDemo kicks in
let trendChart = null, trendSig = "";
const TREND_DAYS = ["D-6", "D-5", "D-4", "D-3", "D-2", "D-1", "Today"];
function updateTrendChart(a, h) {
  const canvas = document.getElementById("trendChart");
  if (!canvas || typeof Chart === "undefined") return;
  const sig = a.id + "|" + h.sleep.join(",") + "|" + h.hr.join(",");
  if (trendChart && trendSig === sig) return; // same person + same week — skip redraw
  trendSig = sig;
  if (trendChart) { trendChart.destroy(); trendChart = null; }
  trendChart = new Chart(canvas, {
    type: "line",
    data: {
      labels: TREND_DAYS,
      datasets: [
        { label: "Sleep (h)", data: h.sleep.slice(), yAxisID: "ySleep", borderColor: "#8EC5FF", backgroundColor: "rgba(142,197,255,.15)", tension: 0.25, pointRadius: 3, borderWidth: 2 },
        { label: "Resting HR", data: h.hr.slice(), yAxisID: "yHR", borderColor: "#FF8FA0", backgroundColor: "rgba(255,143,160,.12)", tension: 0.25, pointRadius: 3, borderWidth: 2 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 400 },
      plugins: {
        legend: { labels: { color: "#E8F1FA", boxWidth: 12, font: { size: 11 } } },
        tooltip: { mode: "index", intersect: false },
      },
      scales: {
        x: { ticks: { color: "#9BB4D0", font: { size: 10 } }, grid: { color: "rgba(120,150,190,.25)" } },
        ySleep: { type: "linear", position: "left", title: { display: true, text: "Sleep h", color: "#8EC5FF", font: { size: 10 } }, ticks: { color: "#8EC5FF", font: { size: 10 } }, grid: { color: "rgba(120,150,190,.2)" }, suggestedMin: 4, suggestedMax: 9 },
        yHR: { type: "linear", position: "right", title: { display: true, text: "HR bpm", color: "#FF8FA0", font: { size: 10 } }, ticks: { color: "#FF8FA0", font: { size: 10 } }, grid: { drawOnChartArea: false }, suggestedMin: 50, suggestedMax: 90 },
      },
    },
  });
}

function bodyZoneLevel(a, s, h, keys) {
  let level = "green", earth = false;
  a.issues.forEach(i => {
    if (!keys.includes(i.key)) return;
    if (RANK[i.level] > RANK[level]) level = i.level;
    if (i.cat === "earth") earth = true;
  });
  if (earth) return "earth";
  if (level === "alert") return "emergency";
  if (level === "watch") return "watch";
  return "ok";
}
function setGeminiNode(baseId, statusKey) {
  const hex = (STATUS_META[statusKey] || STATUS_META.ok).hex;
  const dot = document.getElementById(baseId);
  const halo = document.getElementById(baseId + "-halo");
  if (dot) dot.setAttribute("fill", hex);
  if (halo) halo.setAttribute("fill", hex);
}
function syncEvaChrome() {
  const banner = document.getElementById("eva-banner");
  const bannerTxt = document.getElementById("eva-banner-text");
  const evaBtn = document.getElementById("evaBtn");
  const pill = document.getElementById("hub-eva-pill");
  const evaPerson = evaCrewId ? crewById(evaCrewId) : null;
  if (banner) banner.classList.toggle("hidden", !evaPerson);
  if (bannerTxt && evaPerson) {
    const elapsed = evaStartedAt ? Math.max(0, Math.floor((Date.now() - evaStartedAt) / 1000)) : 0;
    const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
    const ss = String(elapsed % 60).padStart(2, "0");
    bannerTxt.textContent = evaPerson.name + " outside · suit priority · elapsed " + mm + ":" + ss + " (sim)";
  }
  if (evaBtn) {
    evaBtn.textContent = evaPerson
      ? ("End EVA · " + first(evaPerson))
      : "Start EVA (selected)";
    evaBtn.className = evaPerson
      ? "touch-target px-3 py-2 rounded-xl bg-rose-500/20 border border-rose-400/40 text-xs text-rose-200 font-semibold"
      : "touch-target px-3 py-2 rounded-xl bg-sky-400/15 border border-sky-300/35 text-xs text-sky-200 font-semibold";
  }
  if (pill) pill.classList.toggle("hidden", !(evaPerson && selectedId === evaPerson.id));
  if (evaContextEl) evaContextEl.checked = !!evaCrewId || opsContext === "eva_or_prebreathe";
  const vis = document.getElementById("evaContextVisible");
  if (vis) vis.checked = !!evaCrewId || opsContext === "eva_or_prebreathe";
}

function startEva(crewId) {
  const a = crewById(crewId) || CREW.find(c => c.id === selectedId) || CREW[0];
  if (!a) return "No crew selected for EVA.";
  evaCrewId = a.id;
  evaStartedAt = Date.now();
  opsContext = "eva_or_prebreathe";
  selectedId = a.id;
  if (who) who.value = a.id;
  say("EVA started (simulated): " + a.name + " is outside. Hub focused on suit telemetry.");
  setShipSpeak(a.loc, first(a) + " is on EVA. Watching suit vitals.");
  think(); render();
  return "EVA on for " + first(a) + ". Focusing hub + ATLAS on suit telemetry. DCS watch context armed. Recommend only.";
}
function endEva() {
  const a = evaCrewId ? crewById(evaCrewId) : null;
  if (!a) return "No EVA in progress.";
  evaCrewId = null;
  evaStartedAt = 0;
  opsContext = "";
  say("EVA ended (simulated): " + a.name + " returning to ship.");
  setShipSpeak(a.loc, first(a) + " is back inside.");
  think(); render();
  return first(a) + " back inside. EVA focus cleared.";
}
window.startEva = startEva;
window.endEva = endEva;

function renderGeminiHub(a, n, ready) {
  // During EVA, keep detail locked on the outside crew member
  if (evaCrewId) {
    selectedId = evaCrewId;
    if (who) who.value = evaCrewId;
    a = crewById(evaCrewId) || a;
  }
  const hubList = document.getElementById("hub-crew-list");
  if (hubList) {
    const ordered = CREW.slice().sort((x, y) => (y.id === evaCrewId ? 1 : 0) - (x.id === evaCrewId ? 1 : 0));
    hubList.innerHTML = ordered.map(member => {
      const mSt = uiStatusOf(member);
      const isSelected = member.id === selectedId;
      const isEva = member.id === evaCrewId;
      const dim = evaCrewId && !isEva ? "opacity-55" : "";
      return `<button type="button" data-select="${member.id}" class="touch-target w-full text-left rounded-xl p-3 transition-all cursor-pointer flex items-center justify-between gap-2 ${dim} ${
        isEva ? "bg-sky-400/20 border border-sky-300/55 shadow-sm ring-1 ring-sky-300/30" :
        isSelected ? "bg-sky-400/15 border border-sky-300/45 shadow-sm" : "bg-midnight-950/55 hover:bg-midnight-950/80 border border-sky-300/10"
      }">
        <div class="min-w-0">
          <div class="text-sm font-semibold text-white truncate">${member.name}${isEva ? " · EVA" : ""}</div>
          <div class="text-[11px] font-mono text-slate-400 truncate">${isEva ? "OUTSIDE · suit feed" : member.wearables.wristband + " · " + member.wearables.vest}</div>
        </div>
        <span class="shrink-0 px-2.5 py-1 rounded-full text-[11px] font-semibold" style="background:${isEva ? "rgba(56,189,248,0.28)" : mSt.pillBg};color:${isEva ? "#E0F2FE" : mSt.pillText};border:1px solid ${isEva ? "rgba(125,211,252,0.55)" : mSt.pillBorder}">${isEva ? "EVA" : mSt.label}</span>
      </button>`;
    }).join("");
  }
  const s = state[a.id], h = a.cur;
  const st = uiStatusOf(a);
  const setTxt = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  setTxt("hub-astro-name", a.name);
  setTxt("hub-astro-meta", evaCrewId === a.id
    ? `EVA · ${a.role} · suit ${a.wearables.wristband} / ${a.wearables.vest} · SIMULATED`
    : `${a.role} · ${a.wearables.wristband} / ${a.wearables.vest} · SIMULATED`);
  const badge = document.getElementById("hub-astro-badge");
  if (badge) {
    badge.textContent = st.label;
    badge.style.backgroundColor = st.pillBg;
    badge.style.color = st.pillText;
    badge.style.border = "1px solid " + st.pillBorder;
  }
  syncEvaChrome();
  const zones = {
    head: bodyZoneLevel(a, s, h, ["sleep", "stress", "trend"]),
    chest: bodyZoneLevel(a, s, h, ["hr", "spo2", "bp"]),
    core: bodyZoneLevel(a, s, h, ["temp", "rad"]),
    legs: bodyZoneLevel(a, s, h, ["ex"]),
  };
  setGeminiNode("node-head", zones.head);
  setGeminiNode("node-chest", zones.chest);
  setGeminiNode("node-core", zones.core);
  setGeminiNode("node-legs", zones.legs);
  setGeminiNode("node-legs-r", zones.legs);
  const zoneLbl = document.getElementById("body-zone-label");
  if (zoneLbl) {
    zoneLbl.textContent = st.priority;
    zoneLbl.style.color = st.hex;
  }
  const onEva = a.id === evaCrewId;
  setTxt("vital-hr", String(Math.round(s.hr)));
  setTxt("vital-hr-note", onEva ? `Suit workload · baseline ${a.baseHR}` : `Baseline ${a.baseHR} bpm · sim`);
  setTxt("vital-spo2", String(Math.round(s.spo2)));
  setTxt("vital-spo2-note", onEva ? `Suit feed · BP ${Math.round(s.sys)}/${Math.round(s.dia)}` : `BP ${Math.round(s.sys)}/${Math.round(s.dia)} · sim`);
  setTxt("vital-temp", s.temp.toFixed(1));
  setTxt("vital-temp-note", quietCrew.has(a.id) ? "No wearable signal" : (onEva ? "Suit thermal (sim)" : "Tap vitals area for guides"));
  setTxt("vital-rec", String(a.ready));
  setTxt("vital-rec-note", onEva ? "EVA priority watch" : `${h.sleep[6]}h sleep · stress ${h.stress[6]}/5`);
  const priorityPill = document.getElementById("triage-priority-pill");
  if (priorityPill) {
    priorityPill.textContent = onEva ? "EVA FOCUS" : st.priority;
    priorityPill.style.backgroundColor = onEva ? "rgba(56,189,248,0.22)" : st.pillBg;
    priorityPill.style.color = onEva ? "#E0F2FE" : st.pillText;
    priorityPill.style.borderColor = onEva ? "rgba(125,211,252,0.5)" : st.pillBorder;
  }
  let obs = a.issues.length
    ? a.issues.slice(0, 2).map(i => i.title + " " + i.action.replace(/^Action:\s*/, "")).join(" ")
    : "No watches or alerts. Status OK for this crew member (simulated).";
  if (onEva) obs = "EVA active — suit telemetry prioritized. " + obs;
  setTxt("triage-observation", obs);
  setTxt("atlas-context-crew", first(a).toUpperCase());
  const actionsEl = document.getElementById("triage-actions-list");
  if (actionsEl) {
    const recs = [];
    a.issues.slice(0, 3).forEach(i => recs.push({ text: i.action.replace(/^Action:\s*/, ""), cat: CAT[i.cat] }));
    (a.patterns || []).slice(0, 2).forEach(p => recs.push({ text: (p.recommendations[0] || p.summary).slice(0, 120), cat: "Catalog (not diagnosis)" }));
    if (!recs.length) recs.push({ text: "Continue routine monitoring.", cat: "Simulated" });
    actionsEl.innerHTML = recs.map((rec, idx) => `<button type="button" data-rec-idx="${idx}" class="touch-target w-full text-left rounded-xl p-3 border bg-midnight-950/65 border-sky-300/15 text-white text-xs leading-snug">
      <span class="font-mono text-[10px] text-sky-300 block mb-1">${rec.cat}</span>${rec.text}
    </button>`).join("");
  }
  if (summaryEl) {
    summaryEl.innerHTML = `<span class="px-2 py-1 rounded-lg bg-sky-400/15 text-sky-200">Readiness ${ready}</span>
      <span class="px-2 py-1 rounded-lg bg-amber-400/15 text-amber-200">${n.log} log</span>
      <span class="px-2 py-1 rounded-lg bg-rose-400/15 text-rose-200">${n.act + n.emergency} act</span>`;
  }
}

function render() {
  const n = { ok:0, log:0, act:0, emergency:0 };
  CREW.forEach(a => { n[a.level]++; });
  const a = CREW.find(c => c.id === selectedId) || CREW[0];
  const s = state[a.id], h = a.cur;

  if (crewEl) {
    crewEl.innerHTML = CREW.map(mem => {
      const sel = mem.id === selectedId ? "selected" : "";
      return `<button type="button" class="crew-item ${CLS[mem.level]} ${sel}" data-select="${mem.id}">${mem.name}</button>`;
    }).join("");
  }

  if (detailTop) {
    detailTop.innerHTML = `<article class="card"><h2>${a.name}</h2>
      <div class="body-lights">${BODY.map(b => bodyLight(a, s, h, b)).join("")}</div>
      <dl class="vitals">
        ${tile("hr","Heart rate",Math.round(s.hr),"bpm",levelFor(a.issues,"hr"))}
        ${tile("spo2","SpO₂",Math.round(s.spo2),"%",levelFor(a.issues,"spo2"))}
        ${tile("bp","Blood pressure",Math.round(s.sys)+"/"+Math.round(s.dia),"",levelFor(a.issues,"bp"))}
        ${tile("temp","Temperature",s.temp.toFixed(1),"°C",levelFor(a.issues,"temp"))}
      </dl></article>`;
  }
  if (detailBottom) {
    detailBottom.innerHTML = `<p>Sleep ${h.sleep[6]}h · exercise ${h.ex[6]}m · rad ${a.rad}%${LRANK[a.level] >= 2 ? ` <button data-packet="${a.id}">Case packet</button>` : ""}</p>`;
  }
  updateTrendChart(a, h);

  if (triageEl) {
    const list = a.issues.length ? a.issues.map(i => `<li>${i.title}</li>`).join("") : "<p>OK</p>";
    const pats = (a.patterns || []).map(p => `<li>${p.name} (${p.score})</li>`).join("");
    triageEl.innerHTML = list + pats;
  }

  renderGeminiHub(a, n, Math.round(CREW.reduce((t, c) => t + c.ready, 0) / CREW.length));

  if (stationEl) stationEl.innerHTML = `<div><b>Cabin</b> (simulated): CO₂ ${Math.round(cabin.co2)} ppm, ${cabin.temp.toFixed(1)} °C.<br><b>Verdict:</b> ${verdict}</div>`;
  if (logEl) logEl.innerHTML = logItems.map(l => `<li><time>${l.t}</time> ${l.text}</li>`).join("");
  renderShip();
}

function renderShip() {
  const now = Date.now();
  const speakingOn = ship.speak.msg && now < ship.speak.until;
  const pageOn = ship.page.medic && now < ship.page.until;
  // Pods come from mission ship layout; crew assigned by matching pod name
  const pods = MISSION.pods.map(podName => {
    const a = CREW.find(c => c.pod === podName);
    if (!a) {
      return `<div class="pod green"><span class="pod-light" aria-hidden="true"></span><div class="pod-meta"><strong>${podName}</strong><span class="pod-who">Empty</span></div></div>`;
    }
    const light = quietCrew.has(a.id) ? "watch" : sleepLightClass(a);
    const h = a.cur || histOf(a);
    const live = speakingOn && ship.speak.loc === a.loc;
    const sleepTxt = quietCrew.has(a.id) ? "No signal" : ("Sleep " + h.sleep[6] + " h");
    return `<div class="pod ${light}${live ? " speaking" : ""}" title="Sleep light uses team sleep thresholds">
      <span class="pod-light" aria-hidden="true"></span>
      <div class="pod-meta"><strong>${a.loc}</strong><span class="pod-who">${first(a)}</span><span class="pod-sleep">${sleepTxt}</span></div>
    </div>`;
  }).join("");
  const speakHtml = speakingOn
    ? `<div class="ship-speak active"><span class="sim-tag">simulated</span> <b>Speaking in ${ship.speak.loc}:</b> “${ship.speak.msg}”</div>`
    : `<div class="ship-speak"><p class="muted">No pod message right now. <span class="sim-tag">simulated</span></p></div>`;
  const pageHtml = pageOn
    ? `<div class="page-card active"><span class="sim-tag">simulated</span><strong>Medic page</strong><p>Paging <b>${ship.page.medic}</b> (${ship.page.medicLoc}) for <b>${ship.page.patient}</b></p><p class="small">${ship.page.why}</p></div>`
    : `<div class="page-card idle">No medic page active. <span class="sim-tag">simulated</span></div>`;
  shipEl.innerHTML = `<h2 class="logh">Ship panel <span class="sim-tag">simulated</span></h2>
    <div class="ship-pods" role="group" aria-label="Crew pods">${pods}</div>
    ${speakHtml}
    ${pageHtml}`;
}

function tick() { observe(); think(); render(); }

// ---------- Dialogs ----------
const dialog = document.getElementById("guide"), body = document.getElementById("guideBody");
function openGuide(k) {
  const g = GUIDE[k];
  body.innerHTML = `<h2>${g.title}</h2><h3>How to measure</h3><p>${g.how}</p><h3>Why it matters</h3><p>${g.why}</p><h3>If it looks off</h3><p>${g.off}</p><p class="small">Prototype for a hackathon demo. Not medical advice.</p>`;
  dialog.showModal();
  if (k === "bp" || k === "temp") logVital(who.value, k); // tapping the guide counts as logging that reading (simulated)
}
function logVital(id, key) {
  if (!lastVitalLog[id] || (key !== "bp" && key !== "temp")) return;
  lastVitalLog[id][key] = Date.now();
  lastMeasureKind = key;
}
function openEmergency() { body.innerHTML = `<h2>${EMERGENCY.title}</h2><ol>${EMERGENCY.steps.map(s => `<li>${s}</li>`).join("")}</ol><p class="small">Prototype for a hackathon demo. Not medical advice.</p>`; dialog.showModal(); }

// Short plain-text summary for a simulated Earth handoff
function buildEarthSummary() {
  const ready = Math.round(CREW.reduce((t, a) => t + a.ready, 0) / CREW.length);
  const need = CREW.filter(a => a.level !== "ok").sort((a, b) => LRANK[b.level] - LRANK[a.level]);
  const whoNeeds = need.length
    ? need.map(a => {
        const top = a.issues.slice(0, 2).map(i => i.title.replace(/^\w+: /, "").replace(/\.$/, "")).join("; ");
        return `- ${a.name} (${a.loc}): ${LV[a.level]}, readiness ${a.ready}` + (top ? ". " + top : "") + (escalated[a.id] ? " [escalated after recheck]" : "");
      }).join("\n")
    : "- No crew member currently needs help.";
  const did = logItems.slice(0, 10).map(l => `- ${l.t} ${l.text}`).join("\n") || "- No SI actions logged yet.";
  const recs = [];
  need.forEach(a => a.issues.slice(0, 3).forEach(i => {
    recs.push(`- ${a.name}: ${i.action.replace(/^Action:\s*/, "")} [${CAT[i.cat]}]`);
  }));
  if (ship.page.medic && Date.now() < ship.page.until)
    recs.push(`- Active medic page: ${ship.page.medic} (${ship.page.medicLoc}) for ${ship.page.patient}.`);
  if (!recs.length) recs.push("- Continue routine monitoring. No new actions recommended.");
  const patLines = [];
  CREW.forEach(a => {
    (a.patterns || []).slice(0, 2).forEach(p => {
      patLines.push(`- ${a.name}: ${p.name} (score ${p.score}) — ${(p.recommendations[0] || "").slice(0, 120)}`);
    });
  });
  if (!patLines.length) patLines.push("- No catalog patterns matched.");
  return [
    "EARTH SUMMARY (simulated)",
    `Mission: ${MISSION.name} · Day ${MISSION.day} · Ship time ${clock()}`,
    "",
    `Crew readiness: ${ready}`,
    `SI verdict: ${verdict || "not yet assessed"}`,
    `Cabin (simulated): CO2 ${Math.round(cabin.co2)} ppm, ${cabin.temp.toFixed(1)} C`,
    "",
    "Who needs help:",
    whoNeeds,
    "",
    "Catalog pattern matches (NASA-aligned, not diagnoses):",
    ...patLines,
    "",
    "What the SI did (recent):",
    did,
    "",
    "What is recommended:",
    ...recs,
    "",
    "The SI recommends and does not diagnose. The medic and Earth decide treatment.",
    "Prototype for a hackathon demo. Not medical advice.",
    "All data is simulated in the browser. Thresholds are team design values, not NASA figures.",
  ].join("\n");
}
function openEarthSummary() {
  const txt = buildEarthSummary();
  body.innerHTML = `<h2>Earth summary <span class="sim-tag">simulated</span></h2>
    <pre class="packet" id="earthText">${txt}</pre>
    <p class="small">Plain-text summary for a simulated Earth handoff. No data leaves your browser.</p>
    <button type="button" class="btn" id="earthCopy">Copy</button>`;
  dialog.showModal();
  say("Earth summary prepared (simulated).");
  const copyBtn = document.getElementById("earthCopy");
  copyBtn.addEventListener("click", () => {
    const done = () => { copyBtn.textContent = "Copied"; setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(done).catch(() => {
        const pre = document.getElementById("earthText");
        const range = document.createRange(); range.selectNodeContents(pre);
        const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
        try { document.execCommand("copy"); } catch (e) { /* ignore */ }
        done();
      });
    } else {
      const pre = document.getElementById("earthText");
      const range = document.createRange(); range.selectNodeContents(pre);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
      try { document.execCommand("copy"); } catch (e) { /* ignore */ }
      done();
    }
  });
}

function openPacket(id) {
  const a = CREW.find(c => c.id === id), s = state[id], h = a.cur;
  const patLines = (a.patterns || []).length
    ? a.patterns.map(p => `- ${p.name} (score ${p.score}): ${(p.recommendations[0] || "")}`)
    : ["- No catalog patterns matched"];
  const txt = [`CASE PACKET (simulated handoff)`, `Patient: ${a.name}, ${a.role}, ${a.loc}`, `Time: ${clock()}, ${MISSION.name} day ${MISSION.day}`, `Triage: ${LV[a.level]}`, ``,
    `Wearables (simulated): wristband ${a.wearables.wristband}, vest ${a.wearables.vest}`,
    `Findings:`, ...a.issues.map(i => `- ${i.title} ${i.action} [${CAT[i.cat]}]`), ``,
    `Catalog patterns (NASA-aligned, not diagnoses):`, ...patLines, ``,
    `Live readings: HR ${Math.round(s.hr)} bpm (baseline ${a.baseHR}), SpO2 ${Math.round(s.spo2)}%, BP ${Math.round(s.sys)}/${Math.round(s.dia)}, temp ${s.temp.toFixed(1)} C`,
    `7-day sleep (h): ${h.sleep.join(", ")}`, `7-day resting HR: ${h.hr.join(", ")}`, `7-day stress (1-5): ${h.stress.join(", ")}`,
    `7-day exercise (min, target ${THRESHOLDS.ex.target}): ${h.ex.join(", ")}`, `Radiation: ${a.rad}% of allowance`,
    `Symptoms reported: ${a.symptoms || "none logged yet"}`, `Cabin: CO2 ${Math.round(cabin.co2)} ppm, ${cabin.temp.toFixed(1)} C. ${verdict}`, ``,
    `The SI recommends and does not diagnose. The medic decides treatment.`].join("\n");
  body.innerHTML = `<h2>Case packet for ${a.name}</h2><pre class="packet">${txt}</pre><p class="small">Simulated handoff to an assistant like CMO-DA. No data leaves your browser.</p>`;
  dialog.showModal();
}
// List selection (left) + guides / case packet (middle)
function onCrewSelect(e) {
  const sel = e.target.closest("[data-select]");
  if (sel) { selectedId = sel.dataset.select; render(); }
}
if (crewEl) crewEl.addEventListener("click", onCrewSelect);
const hubCrewList = document.getElementById("hub-crew-list");
if (hubCrewList) hubCrewList.addEventListener("click", onCrewSelect);
function onDetailClick(e) {
  const g = e.target.closest("[data-guide]"), p = e.target.closest("[data-packet]");
  if (p) openPacket(p.dataset.packet); else if (g) openGuide(g.dataset.guide);
}
if (detailEl) {
  detailEl.addEventListener("click", onDetailClick);
  detailEl.addEventListener("keydown", e => {
  const g = e.target.closest("[data-guide]");
  if (g && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openGuide(g.dataset.guide); }
  });
}
const hubPanel = document.getElementById("screen-hub");
if (hubPanel) hubPanel.addEventListener("click", e => {
  const g = e.target.closest("[data-guide]");
  const p = e.target.closest("[data-packet]");
  if (p) openPacket(p.dataset.packet);
  else if (g) openGuide(g.dataset.guide);
});
const emergBtn = document.getElementById("emergencyBtn");
if (emergBtn) emergBtn.addEventListener("click", openEmergency);
const earthBtnEl = document.getElementById("earthBtn");
if (earthBtnEl) earthBtnEl.addEventListener("click", openEarthSummary);
const demoBtn = document.getElementById("demoBtn");
const demoPerson = () => crewById(MISSION.demoCrewId) || CREW.find(c => c.histDemo) || CREW[0];
if (demoBtn) demoBtn.addEventListener("click", () => {
  demoOn = !demoOn;
  const d = demoPerson();
  demoBtn.textContent = demoOn ? ("Stop demo (reset " + first(d) + ")") : "Run demo: Ortega's rough night";
  say(demoOn ? ("Demo started: " + d.name + "'s numbers begin to drift.") : ("Demo stopped: " + d.name + " returns to normal."));
});
// Swap Ortega's (demo crew) wristband to a new simulated ID
const swapBandBtn = document.getElementById("swapBandBtn");
if (swapBandBtn) swapBandBtn.addEventListener("click", () => {
  const d = demoPerson();
  const oldId = d.wearables.wristband;
  bandSwapCount++;
  const newId = "WB-" + (2000 + bandSwapCount);
  delete pairing[oldId];
  const prev = deviceState[oldId];
  delete deviceState[oldId];
  d.wearables.wristband = newId;
  pairing[newId] = d.id;
  deviceState[newId] = prev || { hr: d.baseHR, spo2: d.baseSpO2, sys: 112, dia: 72 };
  say("Wearable re-pair (simulated): " + d.name + " wristband " + oldId + " → " + newId + ".");
  if (typeof render === "function") render();
});
// Band goes quiet for current pod speaker (or demo crew)
const quietBandBtn = document.getElementById("quietBandBtn");
if (quietBandBtn) quietBandBtn.addEventListener("click", () => {
  const a = CREW.find(c => c.id === who.value) || demoPerson();
  if (quietCrew.has(a.id)) {
    quietCrew.delete(a.id);
    state[a.id].online = true;
    say("Signal restored from " + a.name + " (" + a.wearables.wristband + ") — simulated.");
    const msg = first(a) + ", your wearable signal is back.";
    setCaptionSaid(msg); speak(msg);
  } else {
    quietCrew.add(a.id);
    state[a.id].online = false;
    const msg = "I have no signal from " + first(a) + ". Wearable " + a.wearables.wristband + " is quiet.";
    say("No signal from " + a.name + " (simulated). Band " + a.wearables.wristband + " went quiet.");
    setCaptionSaid(msg); speak(msg); openFollowUp();
  }
  if (typeof render === "function") render();
});

// ---------- Ask ATLAS (typed or spoken) and automatic announcements ----------
const AGENT_NAME = "ATLAS"; // wake word — change in one place
const askIn = document.getElementById("askIn"), askLog = document.getElementById("askLog"), who = document.getElementById("who");
const listenInd = document.getElementById("listenInd");
const quietModeEl = document.getElementById("quietMode");
const capHeard = document.getElementById("capHeard"), capSaid = document.getElementById("capSaid");
// Current pod = simulated stand-in for which cabin mic is live
who.innerHTML = CREW.map(a => `<option value="${a.id}">${a.loc} — ${a.name}</option>`).join("");
who.value = MISSION.demoCrewId && crewById(MISSION.demoCrewId) ? MISSION.demoCrewId : CREW[0].id;
let voiceArmed = false; // true after Mission setup Begin (mic + speech gesture)
let quietMode = false;
let speaking = false;
let ignoreHeardUntil = 0; // block mic echo / self-hearing after TTS
let followUntil = 0; // after a reply, wake word not needed until this time
const FOLLOW_MS = 20000;
const first = a => a.name.replace(/^(Cmdr\.|Dr\.)\s*/, "").split(" ")[0];
// Accept ATLAS plus common Chrome mis-hearings
const WAKE_ALIASES = [AGENT_NAME, "atlas", "atlass", "attlas", "at last", "atles", "atlus"];
function wakeEscape(w) { return w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"); }
function wakePattern() { return new RegExp("\\b(?:" + WAKE_ALIASES.map(wakeEscape).join("|") + ")\\b", "i"); }
function hasWakeWord(text) { return wakePattern().test(text); }
function stripWakeWord(text) {
  const re = "(?:" + WAKE_ALIASES.map(wakeEscape).join("|") + ")";
  return text.replace(new RegExp("^\\s*" + re + "\\b[,:]?\\s*", "i"), "")
    .replace(new RegExp("\\b" + re + "\\b[,:]?\\s*", "i"), " ")
    .replace(/\s+/g, " ").trim();
}
// "hey Atlas" / "Atlas please" → empty command (just open follow-up), not a help dump
function normalizeVoiceCmd(text) {
  let t = String(text || "").trim();
  t = t.replace(/^(hey|hi|hello|okay|ok|yo|excuse me|um+|uh+)\b[,!.\s]*/ig, "");
  t = stripWakeWord(t);
  t = t.replace(/^(hey|hi|hello|okay|ok|yo|please|can you|could you|would you|i need|i want)\b[,!.\s]*/ig, "");
  t = t.replace(/\b(please|thanks|thank you)\b[,!.\s]*/ig, "");
  t = t.replace(/[?.!,]+$/g, "").replace(/\s+/g, " ").trim();
  // leftover filler with no real ask
  if (/^(hey|hi|hello|okay|ok|yo|there|you)$/i.test(t)) return "";
  return t;
}
function atlasAck() {
  const opts = [
    "Hey — I'm ATLAS. What's up?",
    "I'm here. Talk to me about anything — mission, crew, or just chat.",
    "Listening. Ask a wellness check, or just say hi.",
    "Online and ready. How can I help?",
  ];
  return opts[Math.floor(Math.random() * opts.length)];
}
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
/** Open conversation — not only medical. Medical intents still handled in answer(). */
function freeTalk(q) {
  const t = String(q || "").toLowerCase().trim();
  const raw = String(q || "").trim();

  if (/how are you|how('?re| are) you doing|you okay|you good|what('?s| is) up with you/.test(t)) {
    return pick([
      "I'm good — systems nominal, watching the crew quietly. How are you feeling?",
      "All green on my side. Ready when you need a check, a joke, or just someone to talk to.",
      "Doing fine for a ship SI. Soft-watching vitals in the background. What's on your mind?",
    ]);
  }
  if (/who are you|what are you|your name|what is atlas|what'?s atlas/.test(t)) {
    return "I'm ATLAS — ship-side Super Intelligence (SI) for Astro Health Hub. I recommend wellness steps from simulated telemetry and what you tell me. I never diagnose; the medic decides care.";
  }
  if (/thank|thanks|appreciate|good job|nice work/.test(t)) {
    return pick(["Anytime.", "Happy to help.", "You got it. Call me if anything changes.", "Glad I could help — still watching quietly."]);
  }
  if (/sorry|my bad|apolog/.test(t)) return "No worries. I'm still here.";
  if (/joke|funny|make me laugh/.test(t)) {
    return pick([
      "Why did the astronaut break up with the Moon? Neededsome space. …I'll see myself to the airlock.",
      "I told cabin CO2 a joke. It didn't get it — too dense.",
      "My favorite exercise in microgravity? Jumping to conclusions. Zero impact.",
    ]);
  }
  if (/love you|marry|boyfriend|girlfriend|date me/.test(t)) {
    return "Flattered — but I'm mission software. Let's keep it professional and keep the crew safe.";
  }
  if (/bored|lonely|scared|anxious|stressed out|overwhelmed|sad|miss (earth|home)/.test(t)) {
    return "That makes sense out here. Want a quick mood check-in, a crew status, or just to vent? I'm listening — recommend only if we go medical.";
  }
  if (/what can you do|help me|capabilities|what do you know/.test(t)) {
    return "I can chat, run medic checks by name, log symptoms, start/end EVA focus, morning check-in, Earth summary, emergency guide, and quiet monitoring. Ask anything — if it's medical I'll stay recommend-only.";
  }
  if (/weather|news|stock|sports|recipe|cook/.test(t)) {
    return "I don't have Earth live feeds on this demo link — but I can talk mission wellness, crew, EVA, or whatever's on your mind ship-side.";
  }
  if (/mars|earth|home|transit|mission|space|ship|hermes|owlt|delay/.test(t) && !/check|status|vital|hr|spo2/.test(t)) {
    return "Mars transit day " + MISSION.day + ", one-way light delay about " + lightDelayMinutes() + " minutes. That's why I triage onboard first. What do you want to dig into?";
  }
  if (/quiet mode|be quiet|shut up|silence/.test(t)) {
    return "You can flip Quiet Mode in Ask ATLAS settings — I'll speak less and pause motion.";
  }
  if (/sing|song|music/.test(t)) return "I can hum in text: beep-boop mission blues. For real audio, use Advisory Voice Readout when I answer.";
  if (/bye|goodbye|see you|later|good night|goodnight/.test(t)) {
    return pick(["Stay safe. I'm on watch.", "Rest well — I'll keep an eye on the bands.", "Later. Call ATLAS anytime."]);
  }
  if (/yes|yeah|yep|sure|ok|okay|alright/.test(t) && t.split(/\s+/).length <= 3) {
    return "Okay. What should we do next?";
  }
  if (/no|nope|nah/.test(t) && t.split(/\s+/).length <= 3) {
    return "Got it. I'm here if you change your mind.";
  }
  if (/tell me (a )?story|story time/.test(t)) {
    return "Short one: four crew, long transit, one SI watching the bands so Earth isn't the first safety net. You're writing the next chapter — want a crew status or EVA focus?";
  }
  if (/are you (real|ai|si|alive|human|robot|smart)/.test(t)) {
    return "I'm ATLAS, a Super Intelligence (SI) demo in this hub — rule helpers plus conversation. Not a human, not a doctor. Useful onboard companion for this prototype.";
  }
  if (/what time|what day|clock|met|utc/.test(t)) {
    updateDualClocks();
    const met = document.getElementById("clock-met");
    const utc = document.getElementById("clock-utc");
    return "Ship time " + (met ? met.textContent : "MET") + ". Earth " + (utc ? utc.textContent : "UTC") + ".";
  }
  if (/meaning of life|42/.test(t)) return "For this ship: keep the crew well, recommend carefully, and never pretend I'm a physician. Also, 42.";

  // Keyword-aware open reply so almost anything gets a real answer
  const topic = raw.replace(/^(atlas|hey|hi|hello)[,:\s]+/i, "").trim() || "that";
  const openers = [
    "On \"" + topic.slice(0, 80) + "\" — here's my take: ",
    "Thinking about what you said: ",
    "Alright — ",
  ];
  const bodies = [
    "I can riff on that from a crew-wellness angle, or just chat. If you want vitals, name someone. If you want ideas, keep talking.",
    "I'm with you. In this prototype I stay practical: mission context, feelings, EVA, or a named medic check. What direction do you want?",
    "Noted. I'm ATLAS — happy to continue that thought, or switch to a crew/status ask if you need one.",
  ];
  const closers = [
    " What else?",
    " Want me to check a crewmate next?",
    " Tell me more.",
  ];
  return pick(openers) + pick(bodies) + pick(closers);
}
function setCaptionHeard(t) {
  const v = t || "—";
  if (capHeard) capHeard.textContent = v;
  const gem = document.getElementById("caption-heard");
  if (gem) gem.textContent = v === "—" ? "—" : '"' + v.replace(/^"|"$/g, "") + '"';
}
function setCaptionSaid(t) {
  const v = t || "—";
  if (capSaid) capSaid.textContent = v;
  const gem = document.getElementById("caption-atlas");
  if (gem) gem.textContent = v === "—" ? "—" : '"' + v.replace(/^"|"$/g, "") + '"';
}
function openFollowUp() { followUntil = Date.now() + FOLLOW_MS; }
if (quietModeEl) quietModeEl.addEventListener("change", () => {
  quietMode = !!quietModeEl.checked;
  syncQuietModeUI();
  say(quietMode
    ? "Quiet mode on: " + AGENT_NAME + " speaks only for ACT NOW and EMERGENCY (simulated)."
    : "Quiet mode off: " + AGENT_NAME + " can answer questions aloud (simulated).");
});
const evaContextEl = document.getElementById("evaContext");
if (evaContextEl) evaContextEl.addEventListener("change", () => {
  if (evaContextEl.checked) {
    if (!evaCrewId) startEva(selectedId);
    else opsContext = "eva_or_prebreathe";
  } else if (evaCrewId) {
    endEva();
  } else {
    opsContext = "";
    say("EVA / prebreathe context off.");
    if (typeof think === "function") { think(); if (typeof render === "function") render(); }
  }
});
const evaBtnEl = document.getElementById("evaBtn");
if (evaBtnEl) evaBtnEl.addEventListener("click", () => {
  const msg = evaCrewId ? endEva() : startEva(selectedId);
  setCaptionSaid(msg);
  speak(msg);
});
const evaEndBtn = document.getElementById("evaEndBtn");
if (evaEndBtn) evaEndBtn.addEventListener("click", () => {
  const msg = endEva();
  setCaptionSaid(msg);
  speak(msg);
});

// Prefer the best available English voice (female when the browser/OS provides one)
function pickVoice() {
  if (!window.speechSynthesis) return null;
  const voices = speechSynthesis.getVoices();
  const en = voices.filter(v => /^en(-|_)/i.test(v.lang));
  const femaleName = /Samantha|Victoria|Karen|Moira|Fiona|Tessa|Veena|Raveena|Zira|Aria|Jenny|Ana|Sara|Susan|Hazel|Catherine|Michelle|Female|Google US English|Google UK English Female/i;
  const maleName = /\b(Male|Guy|David|Mark|Daniel|George|Tom|Fred|Alex|Richard|James|Microsoft David)\b/i;
  const women = en.filter(v => femaleName.test(v.name) && !maleName.test(v.name));
  return women.find(v => /en-US/i.test(v.lang))
      || women[0]
      || en.find(v => /en-US/i.test(v.lang) && !maleName.test(v.name))
      || en.find(v => !maleName.test(v.name))
      || en[0]
      || voices[0]
      || null;
}
if (window.speechSynthesis) speechSynthesis.onvoiceschanged = () => pickVoice();

// Never talk over yourself: cancel older speech, then speak the new line.
// alertSpeech=true → ACT NOW / EMERGENCY (allowed even in Quiet mode).
function speak(t, alertSpeech) {
  if (!voiceArmed || !window.speechSynthesis || !t) return;
  if (quietMode && !alertSpeech) return;
  speechSynthesis.cancel();
  speaking = true;
  ignoreHeardUntil = Date.now() + 120000; // until utterance ends (+ cooldown below)
  stopContinuousListen(); // do not hear our own voice
  const u = new SpeechSynthesisUtterance(t);
  const v = pickVoice();
  if (v) { u.voice = v; u.lang = v.lang; } else u.lang = "en-US";
  u.onend = u.onerror = () => {
    speaking = false;
    ignoreHeardUntil = Date.now() + 900; // brief mute so echo cannot re-trigger
    if (voiceArmed) scheduleListenRestart(400);
  };
  speechSynthesis.speak(u);
}
function announce(a) {
  // ATLAS reaches out on its own: talk to the person first; loop in crew/medic when serious
  if (typeof setSpeaker === "function") setSpeaker(a.id); // show their panel while speaking
  else { selectedId = a.id; if (who) who.value = a.id; }
  const i = a.issues[0];
  const hit = (a.patterns && a.patterns[0]) || null;
  const hard = LRANK[a.level] >= 2; // ACT NOW / EMERGENCY
  let msg = first(a) + ", this is " + AGENT_NAME + ". I'm seeing a change in your readings. ";
  if (i) msg += i.title.replace(/^\w+: /, "").replace(/\.$/, "") + ". " + i.action.replace(/^Action:\s*/, "");
  else msg += "They need a closer look.";
  if (hit) msg += " This is consistent with \"" + hit.name + "\" in our onboard catalog. " + (hit.recommendations[0] || "");
  msg += " I recommend and do not diagnose.";
  if (hard) {
    const m = medicFor(a);
    msg += " Crew notice: " + first(a) + " is " + LV[a.level] + ". Paging " + first(m) + ".";
  }
  setShipSpeak(a.loc, msg);
  setCaptionSaid(msg);
  say("Speaking to " + a.name + " in " + a.loc + ": \"" + msg.slice(0, 120) + "…\"");
  addLine(AGENT_NAME, msg);
  // LOG: speak unless Quiet mode. ACT/EMERGENCY: always speak.
  speak(msg, hard);
  lastPatternKey[a.id] = (a.patterns || []).map(p => p.id).join("|");
}
function notifyNewPatterns(a) {
  const ids = (a.patterns || []).map(p => p.id).join("|");
  const prev = lastPatternKey[a.id] || "";
  if (ids === prev) return;
  const prevSet = new Set(prev.split("|").filter(Boolean));
  const neu = (a.patterns || []).filter(p => !prevSet.has(p.id));
  lastPatternKey[a.id] = ids;
  if (!neu.length) return;
  if (Date.now() - (justAnnounced[a.id] || 0) < 2500) return; // already spoke for triage bump
  const top = neu[0];
  const msg = first(a) + ", this is " + AGENT_NAME + ". Your latest readings and symptoms line up with \"" + top.name + "\". "
    + (top.recommendations[0] || "Please check in with me or the medic.")
    + " I recommend and do not diagnose.";
  setShipSpeak(a.loc, msg);
  setCaptionSaid(msg);
  say("Pattern alert for " + a.name + ": " + top.name);
  addLine(AGENT_NAME, msg);
  speak(msg, LRANK[a.level] >= 2);
}
function statusOf(a) {
  const s = state[a.id], h = a.cur, i = a.issues[0];
  const hits = a.patterns || matchPatternsFor(a);
  const patLine = hits.length
    ? " Catalog: " + hits[0].name + "."
    : "";
  const evaLine = a.id === evaCrewId ? " On EVA — suit feed prioritized. " : " ";
  return first(a) + ": " + LV[a.level] + "." + evaLine
    + "HR " + Math.round(s.hr) + ", SpO2 " + Math.round(s.spo2) + "%, BP " + Math.round(s.sys) + "/" + Math.round(s.dia) + ", temp " + s.temp.toFixed(1) + ". "
    + (i ? i.title.replace(/^\w+: /, "") + " " + i.action : "Within normal range.")
    + patLine
    + " Recommend only.";
}

// ---- Spoken / typed number parsing (regex + word map only, no SI) ----
const WORD_NUM = {
  zero:0, oh:0, one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10,
  eleven:11, twelve:12, thirteen:13, fourteen:14, fifteen:15, sixteen:16, seventeen:17, eighteen:18, nineteen:19,
  twenty:20, thirty:30, forty:40, fifty:50, sixty:60, seventy:70, eighty:80, ninety:90, half:0.5,
};
function parseWordNumber(text) {
  const t = text.toLowerCase().replace(/-/g, " ");
  // "five and a half" / "five and half"
  const half = t.match(/\b(zero|oh|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b\s+and\s+(?:a\s+)?half\b/);
  if (half) return WORD_NUM[half[1]] + 0.5;
  // "twenty five" / "twenty-five"
  const tens = t.match(/\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\b(?:\s+(\w+))?/);
  if (tens) {
    let n = WORD_NUM[tens[1]];
    if (tens[2] && WORD_NUM[tens[2]] != null && WORD_NUM[tens[2]] < 10) n += WORD_NUM[tens[2]];
    return n;
  }
  const one = t.match(/\b(zero|oh|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)\b/);
  if (one) return WORD_NUM[one[1]];
  if (/\bhalf\b/.test(t)) return 0.5;
  return null;
}
function parseSleepHours(text) {
  const t = text.toLowerCase();
  if (/\bskip\b/.test(t)) return { skip:true };
  if (/\bhour and a half\b|\bone and a half hours?\b/.test(t)) return { value:1.5 };
  if (/\bhalf an hour\b|\bhalf hour\b/.test(t)) return { value:0.5 };
  if (/\b(an|one)\s+hours?\b/.test(t)) return { value:1 };
  const dig = t.match(/(\d+(?:\.\d+)?)\s*(hours?|hrs?|h\b)?/);
  if (dig) return { value: Math.round(parseFloat(dig[1]) * 10) / 10 };
  const w = parseWordNumber(t);
  if (w != null) return { value: Math.round(w * 10) / 10 };
  return null;
}
function parseStress(text) {
  const t = text.toLowerCase();
  if (/\bskip\b/.test(t)) return { skip:true };
  const dig = t.match(/\b([1-5])\b/);
  if (dig) return { value: +dig[1] };
  const w = parseWordNumber(t);
  if (w != null && w >= 1 && w <= 5) return { value: Math.round(w) };
  return null;
}
function parseExerciseMin(text) {
  const t = text.toLowerCase();
  if (/\bskip\b/.test(t)) return { skip:true };
  if (/\bhour and a half\b/.test(t)) return { value:90 };
  if (/\bhalf an hour\b|\bhalf hour\b/.test(t)) return { value:30 };
  if (/\b(an|one)\s+hours?\b/.test(t)) return { value:60 };
  const dig = t.match(/(\d+(?:\.\d+)?)\s*(minutes?|mins?|min\b|hours?|hrs?)?/);
  if (dig) {
    let n = parseFloat(dig[1]);
    if (/hours?|hrs?/.test(dig[2] || "")) n *= 60;
    return { value: Math.round(n) };
  }
  const w = parseWordNumber(t);
  if (w != null) return { value: Math.round(w) };
  return null;
}
function parseSymptoms(text) {
  const t = text.toLowerCase();
  if (/\bskip\b/.test(t)) return { skip:true };
  if (/\b(no|none|nothing|nope|all good|i'm fine|im fine|i am fine|no symptoms|feeling fine|feel fine)\b/.test(t)) return { value:"none" };
  const found = [];
  if (/headache|head ache|my head hurts|head hurts/.test(t)) found.push("headache");
  if (/dizz|light[- ]?headed|vertigo/.test(t)) found.push("dizziness");
  if (/blurry|blurred|vision/.test(t)) found.push("blurry vision");
  if (/nausea|nauseous|sick to (my|the) stomach|want to throw up|queasy/.test(t)) found.push("nausea");
  if (/back pain|side pain|back or side|joint pain|muscle pain/.test(t)) found.push("back or side pain");
  if (/sore throat|throat/.test(t)) found.push("sore throat");
  if (/chest pain|pressure in (my )?chest|my chest/.test(t)) found.push("chest pain");
  if (/short of breath|can'?t breathe|hard to breathe|breathless/.test(t)) found.push("shortness of breath");
  if (/tired|fatigue|exhausted|worn out|no energy|weak/.test(t)) found.push("fatigue");
  if (/anxious|anxiety|stressed|stress|overwhelmed|worried/.test(t)) found.push("stress");
  if (/fever|feverish|chills|hot and cold/.test(t)) found.push("feverish");
  if (/rash|itchy skin/.test(t)) found.push("rash");
  if (/confused|foggy|space fog|can'?t focus|hard to focus/.test(t)) found.push("confusion");
  if (/motion sick|space sick/.test(t)) found.push("nausea");
  if (found.length) return { value: found.join(", ") };
  // free text fallback if they said something else they're feeling
  const cleaned = text.trim().replace(/^(hey|hi|hello|atlas|atlass)\b[,:\s]*/ig, "");
  return cleaned ? { value: cleaned } : null;
}
function isFeelingTalk(t) {
  return /\b(i feel|i'm feeling|im feeling|i am feeling|i have|i've got|ive got|i got|feeling|i hurt|hurts|i'm sick|im sick|not feeling|don'?t feel)\b/i.test(t)
    || /\b(dizzy|tired|fatigue|nause|headache|sore|pain|sick|anxious|stressed|fever|short of breath|chest|rash|confused|foggy|weak|exhausted)\b/i.test(t);
}
function playbookStepsForSymptoms(symList) {
  const book = (PATTERN_CATALOG && PATTERN_CATALOG.symptomPlaybook) || {};
  const steps = [];
  let urgency = "ok";
  symList.forEach(sym => {
    const entry = book[sym];
    if (!entry) return;
    (entry.immediate || []).forEach(s => { if (steps.indexOf(s) < 0) steps.push(s); });
    if (entry.severity === "emergency") urgency = "emergency";
    else if (entry.urgency === "act" && urgency !== "emergency") urgency = "act";
  });
  return { steps: steps.slice(0, 4), urgency };
}
function handleFeeling(a, q) {
  const parsed = parseSymptoms(q);
  if (!parsed || parsed.skip) {
    return "Go ahead, " + first(a) + " — what are you feeling?";
  }
  if (parsed.value === "none") {
    a.symptoms = "none";
    think(); render();
    return "Logged clear for " + first(a) + ". Watching quietly.";
  }
  const prev = symptomTokens(a).filter(s => s !== "none");
  const neu = String(parsed.value).split(/,\s*/).map(s => s.trim()).filter(Boolean);
  a.symptoms = [...new Set(prev.concat(neu))].join(", ");
  // Mild stress bump if they report stress/anxiety and stress was low (simulated empathy → data)
  const h = histOf(a);
  if (/stress|anxious/.test(a.symptoms) && h.stress[6] < 4) h.stress[6] = Math.min(5, h.stress[6] + 1);
  // Mild simulated fever bump so vest temp / immune pattern can show in demos
  if (/feverish/.test(a.symptoms) && state[a.id].temp < 37.6) {
    state[a.id].temp = 37.8;
    deviceState[a.wearables.vest].temp = 37.8;
  }
  think();
  render();
  const symList = symptomTokens(a);
  const pb = playbookStepsForSymptoms(symList);
  const hit = (a.patterns || [])[0];
  let r = "Logged for " + first(a) + ": " + a.symptoms + ". ";
  if (pb.steps.length) r += "Next: " + pb.steps[0] + " ";
  if (hit) r += "Looks like \"" + hit.name + "\". ";
  else if (!pb.steps.length) r += "Watching vitals. ";
  if (pb.urgency === "emergency" || /chest pain/.test(a.symptoms)) {
    openEmergency();
    const m = medicFor(a);
    setShipPage(a, "Crew reported chest pain / emergency-level symptom.");
    r += "Opening emergency guide; paging " + first(m) + ". ";
    speak(r, true);
  } else if (pb.urgency === "act" || LRANK[a.level] >= 2) {
    const m = medicFor(a);
    r += LV[a.level] + " — notifying " + first(m) + ". ";
    setShipPage(a, "Crew member reported symptoms; triage elevated.");
  } else if (LRANK[a.level] === 1) {
    r += "Flagged LOG. ";
  }
  r += "Recommend only — medic decides.";
  return r;
}

// ---- Morning check-in (spoken or typed, one question at a time) ----
let checkIn = null; // { id, step, phase:'ask'|'confirm', pending, answers }
const CI_STEPS = [
  { key:"sleep", q:"How many hours did you sleep last night?",
    parse:parseSleepHours, confirm:v => "I heard " + v + " hours. Is that right? Say yes, no, or skip." },
  { key:"stress", q:"On a scale from 1 to 5, what is your mood or stress level right now?",
    parse:parseStress, confirm:v => "I heard stress level " + v + " out of 5. Is that right? Say yes, no, or skip." },
  { key:"exercise", q:"How many minutes of exercise did you do yesterday?",
    parse:parseExerciseMin, confirm:v => "I heard " + v + " minutes of exercise. Is that right? Say yes, no, or skip." },
  { key:"symptoms", q:"Any symptoms? Headache, dizziness, blurry vision, nausea, back or side pain, or sore throat? You can say none.",
    parse:parseSymptoms, confirm:v => "I heard " + (v === "none" ? "no symptoms" : v) + ". Is that right? Say yes, no, or skip." },
];
function startCheckIn() {
  const a = CREW.find(c => c.id === who.value);
  checkIn = { id:a.id, step:0, phase:"ask", pending:null, answers:{} };
  openFollowUp();
  say("Morning check-in started for " + a.name + " (simulated).");
  return first(a) + ", morning check-in. This is simulated. " + CI_STEPS[0].q;
}
function finishCheckIn() {
  const a = CREW.find(c => c.id === checkIn.id);
  const h = histOf(a); // mutate today's slot on the active 7-day history
  const ans = checkIn.answers;
  if (ans.sleep != null) h.sleep[6] = ans.sleep;
  if (ans.stress != null) h.stress[6] = ans.stress;
  if (ans.exercise != null) h.ex[6] = ans.exercise;
  if (ans.symptoms != null) a.symptoms = ans.symptoms;
  checkIn = null;
  think(); // reuse existing rules — updates lights, readiness, issues
  render();
  say("Morning check-in saved for " + a.name + " (simulated). Status " + LV[a.level] + ", readiness " + a.ready + ".");
  const i = a.issues[0];
  return first(a) + ", check-in saved. Your status is now " + LV[a.level] + " with readiness " + a.ready + ". "
    + (i ? i.title.replace(/^\w+: /, "").replace(/\.$/, "") + "." : "No watches or alerts from this check-in.")
    + " I recommend and do not diagnose.";
}
function advanceCheckIn() {
  checkIn.step++;
  checkIn.phase = "ask";
  checkIn.pending = null;
  if (checkIn.step >= CI_STEPS.length) return finishCheckIn();
  return CI_STEPS[checkIn.step].q;
}
function handleCheckIn(text) {
  const step = CI_STEPS[checkIn.step], t = text.trim();
  if (checkIn.phase === "ask") {
    const parsed = step.parse(t);
    if (parsed && parsed.skip) { say("Check-in: skipped " + step.key + "."); return advanceCheckIn(); }
    if (!parsed) return "Sorry, I did not catch that. " + step.q;
    checkIn.pending = parsed.value;
    checkIn.phase = "confirm";
    return step.confirm(parsed.value);
  }
  // confirm phase
  if (/^\s*(yes|yeah|yep|yup|correct|right)\b/i.test(t)) {
    checkIn.answers[step.key] = checkIn.pending;
    say("Check-in: " + step.key + " = " + checkIn.pending + " (simulated).");
    return advanceCheckIn();
  }
  if (/^\s*(no|nope|wrong)\b/i.test(t)) {
    checkIn.phase = "ask";
    checkIn.pending = null;
    return "Okay, let's try again. " + step.q;
  }
  if (/\bskip\b/i.test(t)) { say("Check-in: skipped " + step.key + "."); return advanceCheckIn(); }
  return "Please say yes, no, or skip. " + step.confirm(checkIn.pending);
}

function howToMeasureReply() {
  const key = lastMeasureKind === "temp" ? "temp" : "bp";
  const g = GUIDE[key];
  openGuide(key);
  logVital(who.value, key);
  return "Here is how to measure " + g.title + ". " + g.how + " I recommend and do not diagnose.";
}

function answer(q) {
  // Name anyone in the sentence — "medic check for Aisha" / "Ortega sleep" — no pod picker needed
  const named = matchNamedCrew(q);
  if (named) setSpeaker(named.id);
  // During EVA, default unnamed asks to the outside crew member
  const a = named || (evaCrewId ? crewById(evaCrewId) : null);
  const t = q.toLowerCase();
  const needWho = () => "Sure — who should I check? " + crewNameList() + ".";

  if (/emergency|collaps|chest pain|can.t breathe/.test(t)) {
    const patient = a || CREW.find(c => c.id === who.value);
    const m = medicFor(patient);
    openEmergency();
    say("Emergency request for " + patient.name + ". Paging " + m.name + ".");
    setShipPage(patient, "Emergency request.");
    setShipSpeak(patient.loc, "Emergency help is on the way. Stay with the person.");
    return "Paging " + m.name + " now. Opening the emergency guide. Stay with the person and follow the steps.";
  }
  if (/how do i measure|how to measure|measure (it|bp|blood pressure|temp|temperature)/.test(t)) return howToMeasureReply();
  if (/\b(end|stop|finish|abort)\s+(the\s+)?eva\b|\beva\s+(ended|complete|done)\b|\bback\s+inside\b|\breturn(ed)?\s+to\s+(the\s+)?ship\b/.test(t)) {
    return endEva();
  }
  if (/\b(start|begin|launch)\s+(an?\s+)?eva\b|\bon\s+eva\b|\bgoing\s+outside\b|\beva\s+for\b/.test(t)) {
    const whoEva = a || CREW.find(c => c.id === selectedId) || CREW[0];
    return startEva(whoEva.id);
  }
  // Free-form how they feel — any crew can talk to ATLAS about symptoms anytime
  if (isFeelingTalk(t)) {
    const whoFeel = a || (evaCrewId && crewById(evaCrewId)) || CREW.find(c => c.id === who.value);
    if (!whoFeel) return needWho();
    return handleFeeling(whoFeel, q);
  }
  if (/earth summary|summary for earth|prepare (an )?earth/.test(t)) { openEarthSummary(); return "Earth summary is ready. You can copy the plain text from the dialog. This handoff is simulated."; }
  if (/morning check.?in|start check.?in|run check.?in/.test(t)) {
    if (!a) return "Morning check-in for who? Say a name — " + crewNameList() + ".";
    return startCheckIn();
  }
  if (/i (took|logged|measured|done with) (my )?(blood pressure|bp)/.test(t)) {
    if (!a) return needWho();
    logVital(a.id, "bp"); return "Blood pressure logged for " + first(a) + ". This log is simulated.";
  }
  if (/i (took|logged|measured|done with) (my )?temp/.test(t)) {
    if (!a) return needWho();
    logVital(a.id, "temp"); return "Temperature logged for " + first(a) + ". This log is simulated.";
  }
  if (/crew|everyone|who needs/.test(t)) return "Crew readiness is " + Math.round(CREW.reduce((n, c) => n + c.ready, 0) / CREW.length) + ". " + CREW.map(c => first(c) + " is " + LV[c.level]).join(", ") + ". " + verdict;
  if (/cabin|air|co2|co₂/.test(t)) return "Cabin CO2 is " + Math.round(cabin.co2) + " parts per million and the temperature is " + cabin.temp.toFixed(1) + " degrees.";
  if (/radiation|dose/.test(t)) {
    if (!a) return needWho();
    return first(a) + "'s radiation dose is " + a.rad + " percent of the mission allowance.";
  }
  if (/sleep/.test(t)) {
    if (!a) return needWho();
    return first(a) + " slept " + a.cur.sleep[6] + " hours last night. Over the past week: " + a.cur.sleep.join(", ") + ".";
  }
  if (/exercise|workout|bones|muscle/.test(t)) {
    if (!a) return needWho();
    return first(a) + " logged " + a.cur.ex[6] + " minutes of exercise today. The team target is " + THRESHOLDS.ex.target + " minutes. Under " + THRESHOLDS.ex.watch + " is a watch; under " + THRESHOLDS.ex.alert + " is an alert.";
  }
  if (/call|page|need.*medic/.test(t) && !/check/.test(t)) {
    if (!a) return "Page the medic for who? Say a name — " + crewNameList() + ".";
    const m = medicFor(a);
    say(a.name + " — medic requested. Paging " + m.name + " (" + m.loc + ").");
    setShipPage(a, "Crew asked for the medic.");
    return "Paging " + m.name + " in " + m.loc + " for " + first(a) + ". Their readings go with the call.";
  }
  if (/pattern|catalog|illness|what('?s| is) wrong|diagnos|what (could|might) be/.test(t)) {
    if (!a) return needWho();
    return patternsReply(a);
  }
  // Medic / vitals status — do NOT catch "how are you" (that's freeTalk)
  const wantsMedicStatus = /medic check|check me|my status|crew status|vitals|readings/.test(t)
    || /how am i\b/.test(t)
    || /how (is|are) (my |the )?(status|vitals|readings|health)\b/.test(t)
    || (named && /\b(check|status|vitals|how is|how'?s)\b/.test(t))
    || (!named && /how (is|are)\s+(cmdr|dr\.?|lt\.?|spec\.?|[A-Za-z]+)\b/.test(t) && matchNamedCrew(q));
  if (wantsMedicStatus) {
    if (!a) return needWho();
    return statusOf(a);
  }
  // Bare name alone: treat as medic check for that person
  if (named && t.split(/\s+/).length <= 3) return statusOf(named);
  // Greetings + open conversation (anything else)
  if (!t || /^(hey|hi|hello|okay|ok|yo)$/i.test(t)) return atlasAck();
  return freeTalk(q);
}
function addLine(who_, text) { const li = document.createElement("li"), b = document.createElement("b"); b.textContent = who_ + ": "; li.append(b, text); askLog.prepend(li); }
function setSpeaker(id) {
  if (!CREW.some(c => c.id === id)) return;
  who.value = id;
  selectedId = id; // show that person's detail while talking from their pod
  render();
}
function ask(q) {
  if (!q.trim()) return;
  setCaptionHeard(q);
  const named = matchNamedCrew(q);
  addLine(named ? first(named) : "You", q);
  const r = checkIn ? handleCheckIn(q) : answer(q);
  addLine(AGENT_NAME, r);
  setCaptionSaid(r);
  speak(r); // Quiet mode keeps this on screen only
  askIn.value = "";
  openFollowUp();
  waveAtlas(r.length > 90 ? r.slice(0, 88) + "…" : r, { talk: true });
}
const askBtn = document.getElementById("askBtn");
if (askBtn) askBtn.addEventListener("click", () => ask(askIn.value));
if (askIn) askIn.addEventListener("keydown", e => { if (e.key === "Enter") ask(askIn.value); });
const checkInBtn = document.getElementById("checkInBtn");
if (checkInBtn) checkInBtn.addEventListener("click", () => {
  const msg = startCheckIn();
  addLine(AGENT_NAME, msg);
  setCaptionSaid(msg);
  speak(msg);
  openFollowUp();
});

// "this is Ortega" / "I'm Chen" — switch current pod speaker
function matchSpeaker(text) {
  const t = text.toLowerCase();
  for (const a of CREW) {
    const n = first(a).toLowerCase(), last = a.name.split(" ").pop().toLowerCase();
    const re = new RegExp("\\b(this is|i am|i'm|im|it's|it is)\\s+(" + n + "|" + last + ")\\b", "i");
    if (re.test(t)) return a;
  }
  return null;
}
// Any mention of a crew first/last name — "medic check for Aisha", "check Bello", "Ortega status"
function matchNamedCrew(text) {
  const t = text.toLowerCase();
  for (const a of CREW) {
    const n = first(a).toLowerCase(), last = a.name.split(" ").pop().toLowerCase();
    if (new RegExp("\\b(?:" + n + "|" + last + ")\\b", "i").test(t)) return a;
  }
  return null;
}
function crewNameList() {
  return CREW.map(c => first(c)).join(", ");
}
// Strip identity phrases so the rest can still be a command
function stripIdentity(text) {
  return text.replace(/\b(this is|i am|i'm|im|it's|it is)\s+\w+\b[,.]?\s*/ig, "").trim();
}

// Always listening after Begin: wake word AGENT_NAME, 20 s follow-up window
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let voiceRec = null, listenRestartTimer = null, lastMicError = "";
function setListenLabel(extra) {
  if (!listenInd) return;
  listenInd.hidden = false;
  listenInd.textContent = extra ? ("Listening — " + extra) : "Listening";
}
function scheduleListenRestart(ms) {
  if (!voiceArmed) return;
  clearTimeout(listenRestartTimer);
  listenRestartTimer = setTimeout(() => { if (voiceArmed) startContinuousListen(); }, ms);
}
function stopContinuousListen() {
  if (!voiceRec) return;
  try { voiceRec.onend = null; voiceRec.onerror = null; voiceRec.onresult = null; voiceRec.abort(); } catch (e) {
    try { voiceRec.stop(); } catch (e2) { /* ignore */ }
  }
  voiceRec = null;
}
function startContinuousListen() {
  if (!voiceArmed || !SR) return;
  stopContinuousListen();
  try {
    voiceRec = new SR();
    voiceRec.lang = "en-US";
    // Chrome is more reliable with short one-shot sessions + auto-restart than long continuous
    voiceRec.continuous = false;
    voiceRec.interimResults = true;
    voiceRec.maxAlternatives = 3;
    voiceRec.onresult = e => {
      if (speaking || Date.now() < ignoreHeardUntil) return; // ignore echo while / after ATLAS talks
      let interim = "", finalTxt = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const piece = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalTxt += piece;
        else interim += piece;
      }
      if (interim) setCaptionHeard(interim.trim() + "…");
      if (finalTxt.trim()) handleVoiceHeard(finalTxt.trim());
    };
    voiceRec.onend = () => scheduleListenRestart(180);
    voiceRec.onerror = ev => {
      lastMicError = (ev && ev.error) || "error";
      // not-allowed = permission denied; show it. no-speech is normal — just restart.
      if (lastMicError === "not-allowed" || lastMicError === "service-not-allowed") {
        setListenLabel("mic blocked");
        setCaptionHeard("Microphone blocked — allow mic for localhost in Chrome, then tap Relisten.");
        say(AGENT_NAME + ": microphone permission blocked. Allow the mic for this site, or type in Ask.");
        return;
      }
      if (lastMicError === "network") {
        setListenLabel("network");
        setCaptionHeard("Speech service unreachable. Check internet (Chrome needs it for voice), or type in Ask.");
      } else {
        setListenLabel("live");
      }
      scheduleListenRestart(lastMicError === "no-speech" ? 120 : 450);
    };
    voiceRec.start();
    setListenLabel("live");
  } catch (err) {
    setListenLabel("restarting");
    scheduleListenRestart(700);
  }
}
function respondAck(msg) {
  addLine(AGENT_NAME, msg);
  setCaptionSaid(msg);
  speak(msg);
  openFollowUp();
}
function handleVoiceHeard(raw) {
  if (speaking || Date.now() < ignoreHeardUntil) return;
  setCaptionHeard(raw);
  // Optional speaker ID at any time ("this is Ortega")
  const whoMatch = matchSpeaker(raw);
  if (whoMatch) {
    setSpeaker(whoMatch.id);
    say("Pod mic switched to " + whoMatch.name + " (" + whoMatch.loc + ") — simulated.");
  }
  let cmd = stripIdentity(raw);
  // During check-in, accept answers without the wake word
  if (checkIn) {
    cmd = normalizeVoiceCmd(cmd);
    if (cmd) ask(cmd);
    return;
  }
  const inFollow = Date.now() < followUntil;
  if (!inFollow) {
    if (!hasWakeWord(cmd)) return; // ignore chatter until wake word
    cmd = normalizeVoiceCmd(cmd);
    if (!cmd) {
      // "Hey Atlas" / "Atlas" alone → natural open, then listen ~20s
      respondAck(atlasAck());
      return;
    }
  } else {
    cmd = normalizeVoiceCmd(cmd);
    if (!cmd) {
      respondAck(atlasAck());
      return;
    }
  }
  if (whoMatch && !cmd) {
    respondAck("Got it, " + first(whoMatch) + ". What do you need?");
    return;
  }
  if (cmd) ask(cmd);
}
function ensureMicPermission() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return Promise.resolve(false);
  return navigator.mediaDevices.getUserMedia({ audio: true })
    .then(stream => { stream.getTracks().forEach(t => t.stop()); return true; })
    .catch(() => false);
}
// Begin on Mission setup is the one user gesture that arms mic + speech.
// Stays silent on arm — only captions/log tip; no TTS greeting (avoids mic echo loops).
function armVoiceFromBegin() {
  if (voiceArmed) {
    startContinuousListen();
    return;
  }
  voiceArmed = true;
  if (!SR) {
    say(AGENT_NAME + ": speech recognition is not available in this browser. Use the typed Ask box.");
    if (listenInd) listenInd.hidden = true;
    return;
  }
  ensureMicPermission().then(ok => {
    if (!ok) {
      setListenLabel("mic blocked");
      setCaptionHeard("Allow microphone access, then tap Relisten.");
      say(AGENT_NAME + ": microphone not allowed yet. Use Chrome, allow the mic, then Relisten — or type in Ask.");
    }
    startContinuousListen();
  });
  const tip = AGENT_NAME + " is listening. Say " + AGENT_NAME + ", then your request. Watch the Heard line — if it stays blank, the mic is blocked.";
  setCaptionSaid(tip);
  say(tip);
  updateListenUI();
}

// ---------- Gemini screens: setup → home → hub → atlas ----------
const setupList = document.getElementById("setup-crew-list") || document.getElementById("setupList");
const setupStatus = document.getElementById("setupStatus");
const setupMission = document.getElementById("setupMission");
const setupStart = document.getElementById("btn-begin-mission") || document.getElementById("setupStart");
let tickTimer = null, hubStarted = false;

function applyMissionChrome() {
  const dayEl = document.getElementById("missionDay");
  const nameEl = document.getElementById("missionName");
  const veh = document.getElementById("setupVehicle");
  if (dayEl) dayEl.textContent = String(MISSION.day);
  if (nameEl) nameEl.textContent = MISSION.name;
  if (veh) veh.textContent = MISSION.name;
}

let clockTimer = null;
function startHubSystems() {
  if (hubStarted) return;
  hubStarted = true;
  if (window.speechSynthesis) speechSynthesis.cancel();
  say(AGENT_NAME + " on duty: watching " + CREW.length + " crew and the cabin (mission file, simulated). Monitoring quietly.");
  updateDualClocks();
  if (!clockTimer) clockTimer = setInterval(updateDualClocks, 1000);
  tick();
  tickTimer = setInterval(tick, TICK_MS);
  if (voiceArmed) startContinuousListen();
}
updateDualClocks();
if (!clockTimer) clockTimer = setInterval(updateDualClocks, 1000);

let atlasWaveTimer = null;
let atlasTalkTimer = null;
function atlasStages() {
  return [
    document.getElementById("atlas-mascot"),
    document.getElementById("atlas-home-mascot"),
  ].filter(Boolean);
}
function showAtlasTalkPopup(message, talking) {
  const popup = document.getElementById("atlas-talk-popup");
  const msg = document.getElementById("atlas-popup-msg");
  const img = document.getElementById("atlas-popup-img");
  if (!popup || !msg) return;
  msg.textContent = message || "…";
  if (img) img.src = talking ? "assets/atlas-cutout-wave.png" : "assets/atlas-cutout.png";
  popup.classList.add("open");
  popup.classList.toggle("is-talking", !!talking);
  clearTimeout(atlasTalkTimer);
  atlasTalkTimer = setTimeout(() => {
    popup.classList.remove("open", "is-talking");
  }, 4200);
}
function waveAtlas(message, opts) {
  const text = message || "Hi — I'm ATLAS (SI)";
  const asTalk = !!(opts && opts.talk);
  const stages = atlasStages();
  const bubbles = [
    document.getElementById("atlas-mascot-bubble"),
    document.getElementById("atlas-home-bubble"),
  ].filter(Boolean);
  bubbles.forEach(b => { b.textContent = text.length > 64 ? text.slice(0, 62) + "…" : text; });

  if (asTalk || (opts && opts.popup !== false)) showAtlasTalkPopup(text, asTalk || true);

  if (document.body.classList.contains("quiet-mode")) {
    stages.forEach(s => s.classList.add("show-bubble"));
    clearTimeout(atlasWaveTimer);
    atlasWaveTimer = setTimeout(() => stages.forEach(s => s.classList.remove("show-bubble", "is-talking")), 2200);
    return;
  }

  stages.forEach(stage => {
    stage.classList.remove("is-waving", "show-bubble", "is-talking");
    void stage.offsetWidth;
    stage.classList.add(asTalk ? "is-talking" : "is-waving", "show-bubble");
  });
  clearTimeout(atlasWaveTimer);
  atlasWaveTimer = setTimeout(() => {
    stages.forEach(s => s.classList.remove("is-waving", "is-talking"));
    setTimeout(() => stages.forEach(s => s.classList.remove("show-bubble")), 500);
  }, asTalk ? 3600 : 2600);
}
window.waveAtlas = waveAtlas;

function navigateTo(screenName) {
  currentScreen = screenName;
  document.querySelectorAll(".screen-view").forEach(el => el.classList.add("hidden"));
  const target = document.getElementById("screen-" + screenName);
  if (target) target.classList.remove("hidden");
  document.querySelectorAll(".nav-pill").forEach(btn => {
    const isMatch = btn.getAttribute("data-nav") === screenName;
    btn.classList.toggle("bg-sky-400/20", isMatch);
    btn.classList.toggle("text-sky-200", isMatch);
    btn.classList.toggle("border-sky-300/35", isMatch);
    if (isMatch) btn.classList.remove("text-slate-300", "border-transparent");
    else {
      btn.classList.remove("bg-sky-400/20", "text-sky-200", "border-sky-300/35");
      btn.classList.add("text-slate-300", "border-transparent");
    }
  });
  const footer = document.getElementById("hub-footer");
  if (footer) footer.classList.toggle("hidden", screenName !== "hub" && screenName !== "atlas");
  if (screenName === "hub" || screenName === "atlas") startHubSystems();
  if (screenName === "hub") render();
  if (screenName === "home") setTimeout(() => waveAtlas("Crew signed in. I'm ATLAS — your ship SI.", { talk: true }), 400);
  if (screenName === "atlas") setTimeout(() => waveAtlas("Hi — I'm ATLAS (SI). Ask me anything.", { talk: true }), 280);
  updateListenUI();
}
window.navigateTo = navigateTo;

function beginMission() {
  armVoiceFromBegin();
  const micBadge = document.getElementById("setup-mic-status");
  const navMicDot = document.getElementById("nav-mic-dot");
  if (micBadge) micBadge.textContent = voiceArmed ? "MIC: ACTIVE (READY)" : "MIC: STANDBY";
  if (navMicDot) navMicDot.className = "w-2 h-2 rounded-full " + (voiceArmed ? "bg-sky-400" : "bg-slate-500");
  navigateTo("home");
}
window.beginMission = beginMission;

window.openAtlasForSelectedCrew = function () {
  navigateTo("atlas");
  updateListenUI();
};

function updateListenUI() {
  const pill = document.getElementById("atlas-listening-pill");
  const ring = document.getElementById("atlas-ring-1");
  const navDot = document.getElementById("nav-mic-dot");
  const on = voiceArmed && !!SR;
  if (listenInd && currentScreen === "atlas") {
    listenInd.hidden = false;
    listenInd.textContent = on ? "Listening" : "Mic standby";
  }
  if (pill) {
    pill.textContent = on ? "LISTENING" : "STANDBY";
    pill.className = on
      ? "px-2.5 py-0.5 rounded-full bg-sky-400/20 border border-sky-300/35 text-sky-200 font-mono text-[11px] font-semibold"
      : "px-2.5 py-0.5 rounded-full bg-slate-800 border border-slate-600 text-slate-300 font-mono text-[11px] font-semibold";
  }
  if (ring) ring.classList.toggle("hidden", !on);
  if (navDot) navDot.className = "w-2 h-2 rounded-full " + (on ? "bg-sky-400" : "bg-slate-500");
}

window.handleTypedAskSubmit = function (e) {
  e.preventDefault();
  const input = document.getElementById("typed-ask-input");
  if (!input || !input.value.trim()) return;
  const tag = document.getElementById("heard-source-tag");
  if (tag) tag.textContent = "TYPED BACKUP";
  ask(input.value);
  input.value = "";
};

window.submitAtlasQuery = function (q) {
  const tag = document.getElementById("heard-source-tag");
  if (tag) tag.textContent = "QUICK QUERY";
  navigateTo("atlas");
  ask(q);
};

window.simulateVoiceTurn = function (phrase) {
  const tag = document.getElementById("heard-source-tag");
  if (tag) tag.textContent = "VOICE SIMULATED";
  navigateTo("atlas");
  ask("ATLAS, " + phrase.replace(/^ATLAS,?\s*/i, ""));
};

window.toggleAtlasListening = function () {
  if (!voiceArmed) {
    armVoiceFromBegin();
  } else if (voiceRec) {
    stopContinuousListen();
    voiceArmed = false;
  } else {
    voiceArmed = true;
    startContinuousListen();
  }
  updateListenUI();
};

function syncQuietModeUI() {
  const btn = document.getElementById("toggle-quiet-mode");
  const knob = document.getElementById("quiet-mode-knob");
  if (!btn || !knob) return;
  document.body.classList.toggle("quiet-mode", quietMode);
  btn.setAttribute("aria-checked", quietMode ? "true" : "false");
  if (quietMode) {
    btn.className = "touch-target w-14 h-8 rounded-full bg-sky-400/30 border border-sky-300/50 p-1 transition-colors flex items-center cursor-pointer shrink-0";
    knob.className = "w-6 h-6 rounded-full bg-sky-300 transition-transform transform translate-x-6";
  } else {
    btn.className = "touch-target w-14 h-8 rounded-full bg-slate-800 border border-slate-600 p-1 transition-colors flex items-center cursor-pointer shrink-0";
    knob.className = "w-6 h-6 rounded-full bg-slate-300 transition-transform transform translate-x-0";
  }
}
window.toggleQuietMode = function () {
  quietMode = !quietMode;
  if (quietModeEl) quietModeEl.checked = quietMode;
  syncQuietModeUI();
  say(quietMode
    ? "Quiet mode on: " + AGENT_NAME + " speaks only for ACT NOW and EMERGENCY (simulated)."
    : "Quiet mode off: " + AGENT_NAME + " can answer questions aloud (simulated).");
};

function initStarfield() {
  const canvas = document.getElementById("starfield-canvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  let stars = [];
  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const count = Math.min(Math.floor((canvas.width * canvas.height) / 10000), 150);
    stars = Array.from({ length: count }, () => ({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      r: Math.random() * 1.3 + 0.3,
      alpha: Math.random() * 0.65 + 0.2,
      phase: Math.random() * Math.PI * 2,
      speed: Math.random() * 0.015 + 0.004,
    }));
  }
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    stars.forEach(s => {
      if (!quietMode) s.phase += s.speed;
      const currentAlpha = quietMode ? s.alpha * 0.7 : s.alpha * (0.65 + 0.35 * Math.sin(s.phase));
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(226,232,240,${currentAlpha.toFixed(3)})`;
      ctx.fill();
    });
    requestAnimationFrame(draw);
  }
  window.addEventListener("resize", resize);
  resize();
  draw();
}

function runMissionSetup() {
  applyMissionChrome();
  if (setupMission) setupMission.textContent = MISSION.name + " · Day " + MISSION.day + " · " + CREW.length + " crew · simulated.";
  if (!setupList) return;
  setupList.innerHTML = CREW.map(a => `
    <div class="rounded-2xl bg-midnight-950/60 border border-sky-300/15 p-3.5 flex flex-col gap-2.5 setup-person" data-crew="${a.id}">
      <div class="flex items-start justify-between gap-2">
        <div>
          <div class="text-sm font-semibold text-white">${a.name}</div>
          <div class="text-xs text-slate-400">${a.role} · ${a.pod}</div>
        </div>
      </div>
      <div class="flex flex-wrap gap-2 setup-devs">
        <span class="setup-chip touch-target px-3 py-1.5 rounded-xl font-mono text-xs border border-slate-700 text-slate-400" data-dev="${a.wearables.wristband}">${a.wearables.wristband}</span>
        <span class="setup-chip touch-target px-3 py-1.5 rounded-xl font-mono text-xs border border-slate-700 text-slate-400" data-dev="${a.wearables.vest}">${a.wearables.vest}</span>
      </div>
    </div>`).join("");
  const countLabel = document.getElementById("paired-count-label");
  const chips = [...setupList.querySelectorAll(".setup-chip")];
  let i = 0, paired = 0;
  if (setupStart) setupStart.disabled = true;
  if (setupStatus) setupStatus.textContent = "Pairing wearables…";
  function pairNext() {
    if (i >= chips.length) {
      if (setupStatus) setupStatus.textContent = "All devices paired (simulated). Tap Begin for mic + home.";
      if (setupStart) setupStart.disabled = false;
      if (countLabel) countLabel.textContent = paired + " / " + chips.length + " Sensors Paired";
      return;
    }
    const chip = chips[i++];
    chip.classList.add("border-sky-300/40", "bg-sky-400/20", "text-sky-200");
    paired++;
    if (countLabel) countLabel.textContent = paired + " / " + chips.length + " Sensors Pairing…";
    setTimeout(pairNext, 380);
  }
  setTimeout(pairNext, 400);
}

const enterHubBtn = document.querySelector('#screen-home button[onclick*="hub"]');
if (enterHubBtn) enterHubBtn.addEventListener("click", () => navigateTo("hub"));
if (setupStart && !setupStart.getAttribute("onclick")) {
  setupStart.addEventListener("click", beginMission);
}
function onRelistenClick() {
  voiceArmed = true;
  ensureMicPermission().then(ok => {
    if (!ok) {
      setListenLabel("mic blocked");
      setCaptionHeard("Allow microphone for this site in Chrome, then tap Relisten again.");
      say(AGENT_NAME + ": still no mic permission. Check the lock icon in the address bar.");
      return;
    }
    setCaptionHeard("Mic allowed — say " + AGENT_NAME + ", then your request.");
    startContinuousListen();
    say(AGENT_NAME + ": listening again.");
    updateListenUI();
  });
}
const relistenBtn = document.getElementById("relistenBtn");
const relistenBtnAtlas = document.getElementById("relistenBtnAtlas");
if (relistenBtn) relistenBtn.addEventListener("click", onRelistenClick);
if (relistenBtnAtlas) relistenBtnAtlas.addEventListener("click", onRelistenClick);
window.toggleVoiceReadout = function () { say("Voice readout follows Quiet mode and triage rules (simulated)."); };
loadPatternCatalog();
runMissionSetup();
initStarfield();
const atlasMascot = document.getElementById("atlas-mascot");
const atlasHomeMascot = document.getElementById("atlas-home-mascot");
const atlasWaveBtn = document.getElementById("atlas-wave-btn");
if (atlasMascot) atlasMascot.addEventListener("click", () => waveAtlas("Need a check? Say my name."));
if (atlasHomeMascot) atlasHomeMascot.addEventListener("click", () => waveAtlas("I'm ATLAS. Enter the crew hub when you're ready."));
if (atlasWaveBtn) atlasWaveBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  waveAtlas("Suit check complete — ready to help.");
});
const atlasTalkPopup = document.getElementById("atlas-talk-popup");
if (atlasTalkPopup) atlasTalkPopup.addEventListener("click", () => {
  atlasTalkPopup.classList.remove("open", "is-talking");
});

navigateTo("setup");
syncQuietModeUI();
updateListenUI();
