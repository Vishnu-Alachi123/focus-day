/* ============================================================
   voice.js — mic capture + review UI for voice-added tasks.
   Uses the Web Speech API (SpeechRecognition) for speech-to-text,
   then voice-parser.js to convert the transcript into tasks.
   ============================================================ */
(function () {
  const $ = (id) => document.getElementById(id);

  const modal = $('voice-modal');
  const micBtn = $('voice-mic');
  const statusEl = $('voice-status');
  const transcriptEl = $('voice-transcript');
  const reviewEl = $('voice-review');
  const reviewList = $('voice-review-list');
  const parseBtn = $('voice-parse');
  const addBtn = $('voice-add');
  const engineLabel = $('voice-engine-label');

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null;
  let listening = false;
  let finalText = '';

  // ---------- LLM config (localStorage) ----------
  function getLLM() {
    try { return JSON.parse(localStorage.getItem('focusflow_llm') || 'null'); } catch (e) { return null; }
  }
  function refreshEngineLabel() {
    const cfg = getLLM();
    engineLabel.textContent = cfg && cfg.apiKey
      ? `Parser: LLM (${cfg.model || 'gpt-4o-mini'})`
      : 'Parser: on-device (no key needed)';
  }

  // ---------- open / close ----------
  function open() {
    modal.style.display = 'flex';
    finalText = '';
    transcriptEl.textContent = '';
    reviewEl.style.display = 'none';
    reviewList.innerHTML = '';
    addBtn.style.display = 'none';
    parseBtn.style.display = '';
    statusEl.textContent = SR ? 'Tap the mic and start talking' : 'Speech not supported here — type below instead';
    micBtn.style.opacity = SR ? '1' : '0.4';
    refreshEngineLabel();
  }
  function close() {
    stopListening();
    modal.style.display = 'none';
  }

  // ---------- speech recognition ----------
  function startListening() {
    if (!SR) return;
    recognition = new SR();
    recognition.lang = 'en-US';
    recognition.interimResults = true;
    recognition.continuous = true;

    recognition.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const chunk = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += chunk + ' ';
        else interim += chunk;
      }
      transcriptEl.textContent = (finalText + interim).trim();
    };
    recognition.onerror = (e) => {
      statusEl.textContent = e.error === 'not-allowed'
        ? 'Mic blocked — allow microphone access, or type below.'
        : 'Mic error: ' + e.error;
      stopListening();
    };
    recognition.onend = () => { if (listening) { try { recognition.start(); } catch (e) {} } };

    try {
      recognition.start();
      listening = true;
      micBtn.classList.add('recording');
      statusEl.textContent = '● Listening… tap again to stop';
    } catch (e) { /* already started */ }
  }

  function stopListening() {
    listening = false;
    micBtn.classList.remove('recording');
    if (recognition) { try { recognition.stop(); } catch (e) {} recognition = null; }
    if (modal.style.display !== 'none') statusEl.textContent = 'Tap Parse to turn this into tasks';
  }

  function toggleMic() {
    if (listening) stopListening();
    else { finalText = transcriptEl.textContent ? transcriptEl.textContent + ' ' : ''; startListening(); }
  }

  // ---------- parse + review ----------
  async function doParse() {
    const text = (transcriptEl.textContent || '').trim();
    if (!text) { statusEl.textContent = 'Say or type something first.'; return; }
    stopListening();

    let drafts = [];
    const cfg = getLLM();
    parseBtn.disabled = true;
    parseBtn.textContent = 'Parsing…';
    try {
      if (cfg && cfg.apiKey && typeof parseTasksLLM === 'function') {
        statusEl.textContent = 'Asking the LLM…';
        drafts = await parseTasksLLM(text, cfg);
      } else {
        drafts = parseTasksLocal(text);
      }
    } catch (err) {
      statusEl.textContent = 'LLM failed — falling back to on-device parser.';
      drafts = parseTasksLocal(text);
    }
    parseBtn.disabled = false;
    parseBtn.textContent = 'Parse ✨';

    if (!drafts.length) { statusEl.textContent = "Couldn't find any tasks in that. Try rephrasing."; return; }
    renderReview(drafts);
  }

  function renderReview(drafts) {
    reviewList.innerHTML = '';
    drafts.forEach((d, i) => {
      const row = document.createElement('div');
      row.className = 'vr-row';
      const dayOpts = DAYS.map((day, idx) =>
        `<option value="${idx}" ${idx === d.dayIndex ? 'selected' : ''}>${day.slice(0, 3)} ${formatDate(weekDates[idx])}</option>`).join('');
      const prioOpts = ['high', 'medium', 'low'].map(p =>
        `<option value="${p}" ${p === d.priority ? 'selected' : ''}>${p[0].toUpperCase() + p.slice(1)}</option>`).join('');
      const est = ((d.estHours || 0) * 60 + (d.estMinutes || 0)) || 30;
      row.innerHTML = `
        <input class="vr-name" type="text" value="${(d.name || '').replace(/"/g, '&quot;')}" />
        <div class="vr-controls">
          <select class="vr-day">${dayOpts}</select>
          <select class="vr-prio vr-prio-${d.priority}">${prioOpts}</select>
          <span class="vr-est">${est}m${d.dueDate ? ' · due ' + formatDueDateStr(d.dueDate) : ''}</span>
          <button class="vr-del" title="Remove">✕</button>
        </div>`;
      row.dataset.dueDate = d.dueDate || '';
      row.querySelector('.vr-del').addEventListener('click', () => row.remove());
      row.querySelector('.vr-prio').addEventListener('change', (e) => {
        e.target.className = 'vr-prio vr-prio-' + e.target.value;
      });
      reviewList.appendChild(row);
    });
    reviewEl.style.display = 'block';
    parseBtn.style.display = 'none';
    addBtn.style.display = '';
    statusEl.textContent = `Found ${drafts.length} task${drafts.length > 1 ? 's' : ''} — review, then add.`;
  }

  function doAdd() {
    const rows = Array.from(reviewList.querySelectorAll('.vr-row'));
    let count = 0;
    rows.forEach(row => {
      const name = row.querySelector('.vr-name').value.trim();
      if (!name) return;
      const dayIndex = parseInt(row.querySelector('.vr-day').value, 10);
      const priority = row.querySelector('.vr-prio').value;
      const estTotal = parseInt((row.querySelector('.vr-est').textContent.match(/(\d+)m/) || [])[1] || '30', 10);
      addTaskFromDraft({
        name, dayIndex, priority,
        estHours: Math.floor(estTotal / 60),
        estMinutes: estTotal % 60,
        dueDate: row.dataset.dueDate || null,
      });
      count++;
    });
    if (!count) { statusEl.textContent = 'Nothing to add.'; return; }
    close();
    rerender();
    if (typeof showXPToast === 'function') showXPToast(`Added ${count} task${count > 1 ? 's' : ''} by voice! 🎤`);
    if (typeof launchConfetti === 'function') launchConfetti();
  }

  // ---------- LLM settings ----------
  function initSettings() {
    const panel = $('voice-settings');
    $('voice-settings-btn').addEventListener('click', () => {
      const cfg = getLLM() || {};
      $('llm-endpoint').value = cfg.endpoint || 'https://api.openai.com/v1/chat/completions';
      $('llm-model').value = cfg.model || 'gpt-4o-mini';
      $('llm-key').value = cfg.apiKey || '';
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    });
    $('llm-save').addEventListener('click', () => {
      const cfg = {
        endpoint: $('llm-endpoint').value.trim() || 'https://api.openai.com/v1/chat/completions',
        model: $('llm-model').value.trim() || 'gpt-4o-mini',
        apiKey: $('llm-key').value.trim(),
      };
      localStorage.setItem('focusflow_llm', JSON.stringify(cfg));
      panel.style.display = 'none';
      refreshEngineLabel();
    });
    $('llm-clear').addEventListener('click', () => {
      localStorage.removeItem('focusflow_llm');
      panel.style.display = 'none';
      refreshEngineLabel();
    });
  }

  // ---------- wire up ----------
  function initVoice() {
    if (!$('btn-open-voice')) return;
    $('btn-open-voice').addEventListener('click', open);
    $('voice-close').addEventListener('click', close);
    $('voice-cancel').addEventListener('click', close);
    micBtn.addEventListener('click', toggleMic);
    parseBtn.addEventListener('click', doParse);
    addBtn.addEventListener('click', doAdd);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    initSettings();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initVoice);
  else initVoice();
})();
