# Focus Day / FocusFlow

A planning app I built for myself to manage tasks around ADHD/distractibility.
Instead of an endless backlog, it keeps a small, prioritized week in front of me —
tasks ranked by priority, drag-and-drop scheduling, a focus timer, XP/streaks for
momentum, and a calm interface designed to reduce overwhelm.

## Why
I get distracted easily, and traditional to-do apps made it worse — long lists,
notifications, and guilt. FocusFlow keeps only what matters in view, color-codes
tasks by priority, and lets me plan by talking instead of typing.

## 🎤 Voice add (new)
Tap **🎤 Voice** and just talk: *"Finish my CSC 480 report by Wednesday, it's urgent,
go to the gym tomorrow for an hour, and buy groceries whenever."* The app will:

1. **Transcribe** your speech with the browser's Web Speech API (no install, no key).
2. **Parse** the transcript into individual tasks, inferring for each one:
   - the **day** to place it (today, tomorrow, "on Friday", …),
   - a **due date** ("by Wednesday", "due Friday"),
   - a **priority** (urgent/important → high, whenever/no rush → low),
   - a **time estimate** ("for an hour", "30 minutes", "an hour and a half").
3. Let you **review and edit** the parsed tasks, then drops them onto the right days.

You can also just type into the box if you'd rather not talk.

### Parsing engines
- **On-device (default):** a heuristic natural-language parser in
  [`organize/voice-parser.js`](organize/voice-parser.js). Works fully offline, no API key.
- **LLM (optional):** click **⚙ LLM** in the voice modal to point it at any
  OpenAI-compatible `/chat/completions` endpoint with your own key (stored only in
  your browser's `localStorage`). The app sends the transcript with a structured
  prompt and falls back to the on-device parser if the request fails.

### Browser support
Speech-to-text needs a browser that implements the Web Speech API
(Chrome, Edge, Safari). Everywhere else, the type-to-parse path still works.

## Files
- `organize/` — the current app
  - `index.html` — markup
  - `app.js` — planner logic (tasks, week/day views, timer, XP, drag & drop)
  - `voice-parser.js` — speech-transcript → structured tasks (on-device + LLM)
  - `voice.js` — mic capture + review UI
  - `styles.css` — styling
- `focus-day.html`, `adhd-todo.html` — earlier single-file prototypes

## Run
```bash
cd organize
python3 -m http.server 8080
# open http://localhost:8080
```
