/* ============================================================
   voice-parser.js — turn a spoken sentence into structured tasks.

   parseTasksLocal(text) runs fully offline (no API key) using
   heuristics for day, due date, priority, and time estimate.

   parseTasksLLM(text, cfg) optionally calls an OpenAI-compatible
   chat endpoint for higher-quality parsing when the user has
   configured a key. Both return the SAME shape:

     [{ name, dayIndex, dueDate|null, priority, estHours, estMinutes }]

   dayIndex: 0=Mon … 6=Sun (matches app.js DAYS).
   ============================================================ */

const WEEKDAYS = {
  monday: 0, mon: 0, tuesday: 1, tue: 1, tues: 1, wednesday: 2, wed: 2,
  thursday: 3, thu: 3, thurs: 3, friday: 4, fri: 4, saturday: 5, sat: 5,
  sunday: 6, sun: 6,
};

// --- date helpers (prefer app.js globals if present) ---
function vpTodayIndex() {
  if (typeof getTodayIndex === 'function') return getTodayIndex();
  const d = new Date().getDay();
  return (d + 6) % 7;
}
function vpWeekDate(index) {
  if (typeof weekDates !== 'undefined' && weekDates[index]) return weekDates[index];
  const now = new Date();
  const day = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((day + 6) % 7));
  const d = new Date(monday);
  d.setDate(monday.getDate() + index);
  return d;
}
function vpDateStr(index) {
  const d = vpWeekDate(index);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Resolve a day phrase → weekday index (0-6) or null.
function resolveDay(phrase) {
  const p = phrase.toLowerCase();
  if (/\btoday\b/.test(p)) return vpTodayIndex();
  if (/\btomorrow\b/.test(p)) return Math.min(6, vpTodayIndex() + 1);
  if (/\btonight\b/.test(p)) return vpTodayIndex();
  for (const [word, idx] of Object.entries(WEEKDAYS)) {
    if (new RegExp('\\b' + word + '\\b').test(p)) return idx;
  }
  return null;
}

function detectPriority(text) {
  const t = text.toLowerCase();
  if (/\b(urgent|asap|important|critical|high[\s-]?priority|deadline|must|right away|top priority)\b/.test(t)) return 'high';
  if (/\b(low[\s-]?priority|whenever|sometime|eventually|no rush|not urgent|someday)\b/.test(t)) return 'low';
  return 'medium';
}

// Convert spoken durations to explicit "N minutes" BEFORE splitting,
// so phrases like "an hour and a half" aren't torn apart on " and ".
function normalizeDurations(text) {
  return text
    .replace(/\b(an?|one|1)\s+hours?\s+and\s+a\s+half\b/gi, '90 minutes')
    .replace(/\b(an?|one|1)\s+hours?\s+and\s+a\s+quarter\b/gi, '75 minutes')
    .replace(/\bhalf an hour\b|\bhalf hour\b/gi, '30 minutes')
    .replace(/\bquarter of an hour\b/gi, '15 minutes')
    .replace(/\ba couple of hours\b|\ba couple hours\b/gi, '120 minutes')
    .replace(/\ba few hours\b/gi, '180 minutes')
    .replace(/\b(an|one)\s+hours?\b/gi, '60 minutes');
}

// Return { estHours, estMinutes } parsed from explicit numeric phrases.
function detectEstimate(text) {
  const t = text.toLowerCase();
  let h = 0, m = 0;
  const hMatch = t.match(/(\d+(?:\.\d+)?)\s*(hours?|hrs?|h)\b/);
  if (hMatch) { const v = parseFloat(hMatch[1]); h = Math.floor(v); m += Math.round((v - h) * 60); }
  const mMatch = t.match(/(\d+)\s*(minutes?|mins?|m)\b/);
  if (mMatch) m += parseInt(mMatch[1], 10);
  if (m >= 60) { h += Math.floor(m / 60); m = m % 60; }
  return { estHours: h, estMinutes: m };
}

// A segment is "junk" (a trailing modifier, not its own task) when nothing
// meaningful survives name-cleaning — e.g. "its urgent", "them", "a half".
const JUNK_NAMES = new Set(['it', 'its', "it's", 'them', 'that', 'this', 'those', 'these', 'too', 'as well', 'a half', 'a quarter']);
function isJunkSegment(name) {
  const n = name.toLowerCase().trim();
  if (n.replace(/[^a-z]/g, '').length < 2) return true;
  return JUNK_NAMES.has(n);
}

// Strip filler + parsed metadata from a segment to get a clean task name.
function cleanName(seg) {
  let s = seg.trim();
  s = s.replace(/^(and|then|also|i (need|have|want|gotta|got) to|i need to|remember to|make sure to|don'?t forget to|please|can you|i should|i'?ll|let'?s)\s+/i, '');
  // strip leading "it's / that's / this is + (really|very|…)" filler modifiers
  s = s.replace(/^(it'?s|it is|that'?s|this is|they'?re|its)\s+(really|very|so|pretty|quite|super|extremely)?\s*/i, '');
  s = s.replace(/^(it )?(takes?|will take|should take|about|around|roughly|approximately|maybe)\s+(about|around)?\s*/i, '');
  s = s.replace(/^(to|the)\s+/i, '');
  // remove day / due / time / priority phrases
  s = s.replace(/\b(due|by|on|before|for|this|next|coming)\s+(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thurs|fri|sat|sun)\b/gi, '');
  s = s.replace(/\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi, '');
  s = s.replace(/\b(for\s+)?(\d+(?:\.\d+)?\s*(hours?|hrs?|h)\b)/gi, '');
  s = s.replace(/\b(for\s+)?(\d+\s*(minutes?|mins?|m)\b)/gi, '');
  s = s.replace(/\b(for\s+)?(half an hour|half hour|an? hour|a couple (of )?hours|a few hours)\b/gi, '');
  s = s.replace(/\b(urgent|asap|important|critical|high[\s-]?priority|low[\s-]?priority|whenever|sometime|eventually|no rush|not urgent|someday|top priority|right away|deadline)\b/gi, '');
  s = s.replace(/\s{2,}/g, ' ').replace(/\s+([,.])/g, '$1').replace(/^[\s,.-]+|[\s,.-]+$/g, '');
  // strip trailing orphan filler words left behind after removals (e.g. "…report its")
  let prev;
  do { prev = s; s = s.replace(/\s+(its?|it'?s|that|this|these|those|really|very|so|and|but|for|to|the|a|an|on|by|due|is|are)$/i, '').trim(); } while (s !== prev);
  if (s.length) s = s.charAt(0).toUpperCase() + s.slice(1);
  return s;
}

// Split a transcript into individual task segments.
function splitSegments(text) {
  let t = text.replace(/\s+/g, ' ').trim();
  // primary splitters
  let parts = t.split(/\s*(?:,|;|\.|\band then\b|\bthen\b|\balso\b|\bnext\b(?!\s+(?:week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)))\s*/i);
  // secondary: split remaining " and " when both sides look like clauses (contain a space)
  const out = [];
  parts.forEach(p => {
    p = (p || '').trim();
    if (!p) return;
    const sub = p.split(/\s+and\s+/i);
    if (sub.length > 1 && sub.every(x => x.trim().split(' ').length >= 2)) {
      sub.forEach(x => out.push(x.trim()));
    } else {
      out.push(p);
    }
  });
  // merge fragments shorter than 2 words into the previous segment
  const merged = [];
  out.forEach(seg => {
    if (merged.length && seg.split(' ').length < 2) {
      merged[merged.length - 1] += ' ' + seg;
    } else {
      merged.push(seg);
    }
  });
  return merged.filter(Boolean);
}

function parseTasksLocal(text) {
  if (!text || !text.trim()) return [];
  const segments = splitSegments(normalizeDurations(text));
  const today = vpTodayIndex();
  const tasks = [];

  segments.forEach(seg => {
    const lower = seg.toLowerCase();
    const priority = detectPriority(lower);
    const { estHours, estMinutes } = detectEstimate(lower);
    const name = cleanName(seg);

    // Trailing modifier ("its urgent", "for 30 minutes") → fold into previous task.
    if (isJunkSegment(name)) {
      if (tasks.length) {
        const prev = tasks[tasks.length - 1];
        if (priority !== 'medium') prev.priority = priority;
        if (estHours || estMinutes) { prev.estHours = estHours; prev.estMinutes = estMinutes; }
      }
      return;
    }

    // day + due detection
    const dueMatch = lower.match(/\b(?:due|by|before)\s+(today|tomorrow|tonight|[a-z]+)\b/);
    let dueDate = null;
    let dayIndex = resolveDay(lower);
    if (dueMatch) {
      const dueIdx = resolveDay(dueMatch[1]);
      if (dueIdx !== null) {
        dueDate = vpDateStr(dueIdx);
        if (dayIndex === null) dayIndex = dueIdx;
      }
    }
    if (dayIndex === null) dayIndex = today;

    tasks.push({
      name,
      dayIndex,
      dueDate,
      priority,
      estHours,
      estMinutes: (estHours === 0 && estMinutes === 0) ? 30 : estMinutes,
    });
  });

  return tasks;
}

// Optional LLM parsing via an OpenAI-compatible chat completions endpoint.
async function parseTasksLLM(text, cfg) {
  const today = vpTodayIndex();
  const dayList = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const sys = `You convert a person's spoken brain-dump into a JSON array of tasks for a weekly planner.
Today is ${dayList[today]}. The week runs Monday(0) … Sunday(6).
Return ONLY valid JSON: an array of objects with keys:
  "name" (string, concise, no filler like "I need to"),
  "dayIndex" (int 0-6, the day to place the task; default to today's index ${today} if unspecified),
  "dueDate" (string "YYYY-MM-DD" or null),
  "priority" ("high" | "medium" | "low"),
  "estHours" (int), "estMinutes" (int).
Infer priority from words like urgent/important/asap (high) or whenever/no rush (low).
Split multiple tasks. Do not invent tasks. No prose, no markdown — JSON only.`;

  const res = await fetch(cfg.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model || 'gpt-4o-mini',
      temperature: 0.1,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: text }],
    }),
  });
  if (!res.ok) throw new Error('LLM request failed: ' + res.status);
  const data = await res.json();
  let content = data.choices?.[0]?.message?.content || '[]';
  content = content.replace(/```json|```/g, '').trim();
  const arr = JSON.parse(content);
  // normalize
  return arr.map(t => ({
    name: String(t.name || '').trim(),
    dayIndex: Math.max(0, Math.min(6, parseInt(t.dayIndex, 10) || today)),
    dueDate: t.dueDate || null,
    priority: ['high', 'medium', 'low'].includes(t.priority) ? t.priority : 'medium',
    estHours: parseInt(t.estHours, 10) || 0,
    estMinutes: parseInt(t.estMinutes, 10) || (parseInt(t.estHours, 10) ? 0 : 30),
  })).filter(t => t.name);
}

// expose for browser + tests
if (typeof window !== 'undefined') {
  window.parseTasksLocal = parseTasksLocal;
  window.parseTasksLLM = parseTasksLLM;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseTasksLocal, parseTasksLLM, splitSegments, detectPriority, detectEstimate };
}
