/* ─────────────────────────────────────────────────────────────
   VoiceNotes — app.js
   Speech recognition with Web Speech API
   Supports: zh-HK (Cantonese+English), zh-CN, en-US
───────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  /* ── DOM refs ── */
  const toggleBtn         = document.getElementById('toggleBtn');
  const btnIdle           = toggleBtn.querySelector('.btn-idle');
  const btnRecording      = toggleBtn.querySelector('.btn-recording');
  const toggleBtnLabel    = document.getElementById('toggleBtnLabel');
  const micRing           = document.getElementById('micRing');
  const statusDot         = document.getElementById('statusDot');
  const statusText        = document.getElementById('statusText');
  const timerEl           = document.getElementById('timer');
  const transcriptText    = document.getElementById('transcriptText');
  const interimText       = document.getElementById('interimText');
  const transcriptPlaceholder = document.getElementById('transcriptPlaceholder');
  const wordCountEl       = document.getElementById('wordCount');
  const copyBtn           = document.getElementById('copyBtn');
  const downloadBtn       = document.getElementById('downloadBtn');
  const clearBtn          = document.getElementById('clearBtn');
  const langPills         = document.getElementById('langPills');
  const langHint          = document.getElementById('langHint');
  const waveformCanvas    = document.getElementById('waveformCanvas');
  const toastEl           = document.getElementById('toast');
  const browserWarn       = document.getElementById('browserWarn');
  const navbar            = document.getElementById('navbar');

  /* ── AI Analysis DOM refs ── */
  const analyzeBtn        = document.getElementById('analyzeBtn');
  const aiPanel           = document.getElementById('aiPanel');
  const aiPanelBody       = document.getElementById('aiPanelBody');
  const aiSettingsBtn     = document.getElementById('aiSettingsBtn');
  const aiReanalyzeBtn    = document.getElementById('aiReanalyzeBtn');
  const aiCloseBtn        = document.getElementById('aiCloseBtn');
  const apiKeyModal       = document.getElementById('apiKeyModal');
  const apiKeyInput       = document.getElementById('apiKeyInput');
  const aiModelSelect     = document.getElementById('aiModelSelect');
  const apiKeyToggleVis   = document.getElementById('apiKeyToggleVis');
  const apiKeyModalClose  = document.getElementById('apiKeyModalClose');
  const apiKeyModalCancel = document.getElementById('apiKeyModalCancel');
  const apiKeyModalSave   = document.getElementById('apiKeyModalSave');

  /* ── State ── */
  let recognition         = null;
  let isRecording         = false;
  let shouldStop          = false;   // hard-stop flag — prevents onend auto-restart
  let finalTranscript     = '';
  let timerInterval       = null;
  let secondsElapsed      = 0;
  let selectedLang        = 'zh-HK';
  let selectedLangName    = '廣東話（混合英文）';
  let audioContext        = null;
  let analyser            = null;
  let micSource           = null;
  let animFrameId         = null;
  let mediaStream         = null;

  /* ── Navbar scroll ── */
  window.addEventListener('scroll', () => {
    navbar.classList.toggle('scrolled', window.scrollY > 20);
  });

  /* ── Browser support check ── */
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    browserWarn.classList.remove('hidden');
    toggleBtn.disabled = true;
    toggleBtn.style.opacity = '0.4';
    toggleBtn.style.cursor = 'not-allowed';
    console.warn('Web Speech API not supported.');
  }

  /* ── Language pill selection ── */
  const LANG_HINTS = {
    'zh-HK':        '目前：廣東話（混合英文）— 支援廣東話夾英文夾普通話混合語音',
    'zh-CN':        '目前：普通話（混合英文）— 支援普通話夾英文語音',
    'en-US':        'Current: English (US) — Supports English speech',
    'yue-Hant-HK':  '目前：廣東話書面語 — 廣東話語音轉換為書面語文字',
  };

  langPills.querySelectorAll('.lang-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      langPills.querySelectorAll('.lang-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      selectedLang     = pill.dataset.lang;
      selectedLangName = pill.dataset.name;
      langHint.textContent = LANG_HINTS[selectedLang] || '';

      /* Restart recognition if active */
      if (isRecording) {
        stopRecognition();
        setTimeout(startRecognition, 300);  // startRecognition resets shouldStop
      }
    });
  });

  /* ── Timer helpers ── */
  function formatTime(s) {
    const m = Math.floor(s / 60).toString().padStart(2, '0');
    const sec = (s % 60).toString().padStart(2, '0');
    return `${m}:${sec}`;
  }

  function startTimer() {
    secondsElapsed = 0;
    timerEl.textContent = '00:00';
    timerInterval = setInterval(() => {
      secondsElapsed++;
      timerEl.textContent = formatTime(secondsElapsed);
    }, 1000);
  }

  function stopTimer() {
    clearInterval(timerInterval);
    timerInterval = null;
  }

  /* ── Word count ── */
  function updateWordCount() {
    const text = finalTranscript.trim();
    if (!text) {
      wordCountEl.textContent = '0 字';
      return;
    }
    /* Count CJK chars + English words */
    const cjkCount     = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
    const englishWords = text.replace(/[\u4e00-\u9fff\u3400-\u4dbf]/g, ' ')
                             .trim().split(/\s+/).filter(w => w.length > 0).length;
    const total = cjkCount + englishWords;
    wordCountEl.textContent = `${total} 字`;
  }

  /* ── Canvas Waveform Visualizer ── */
  const canvasCtx = waveformCanvas.getContext('2d');

  function drawWaveform() {
    if (!analyser) return;
    animFrameId = requestAnimationFrame(drawWaveform);

    const bufferLength = analyser.frequencyBinCount;
    const dataArray    = new Uint8Array(bufferLength);
    analyser.getByteTimeDomainData(dataArray);

    const W = waveformCanvas.clientWidth  * window.devicePixelRatio;
    const H = waveformCanvas.clientHeight * window.devicePixelRatio;
    waveformCanvas.width  = W;
    waveformCanvas.height = H;

    canvasCtx.clearRect(0, 0, W, H);

    /* Gradient stroke */
    const grad = canvasCtx.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0,   '#6C63FF');
    grad.addColorStop(0.5, '#3ECFCF');
    grad.addColorStop(1,   '#6C63FF');

    canvasCtx.lineWidth   = 2.5 * window.devicePixelRatio;
    canvasCtx.strokeStyle = grad;
    canvasCtx.beginPath();

    const sliceWidth = W / bufferLength;
    let x = 0;

    for (let i = 0; i < bufferLength; i++) {
      const v = dataArray[i] / 128.0;
      const y = (v * H) / 2;
      if (i === 0) canvasCtx.moveTo(x, y);
      else         canvasCtx.lineTo(x, y);
      x += sliceWidth;
    }
    canvasCtx.lineTo(W, H / 2);
    canvasCtx.stroke();
  }

  function drawFlatLine() {
    const W = waveformCanvas.clientWidth  * window.devicePixelRatio;
    const H = waveformCanvas.clientHeight * window.devicePixelRatio;
    waveformCanvas.width  = W;
    waveformCanvas.height = H;
    canvasCtx.clearRect(0, 0, W, H);
    canvasCtx.lineWidth   = 1.5 * window.devicePixelRatio;
    canvasCtx.strokeStyle = 'rgba(108,99,255,0.25)';
    canvasCtx.beginPath();
    canvasCtx.moveTo(0, H / 2);
    canvasCtx.lineTo(W, H / 2);
    canvasCtx.stroke();
  }

  async function startAudioVisualizer() {
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      micSource = audioContext.createMediaStreamSource(mediaStream);
      micSource.connect(analyser);
      waveformCanvas.classList.add('active');
      drawWaveform();
    } catch (err) {
      console.warn('Microphone access for visualizer failed:', err);
    }
  }

  function stopAudioVisualizer() {
    if (animFrameId) cancelAnimationFrame(animFrameId);
    if (micSource)   micSource.disconnect();
    if (audioContext && audioContext.state !== 'closed') audioContext.close();
    if (mediaStream) mediaStream.getTracks().forEach(t => t.stop());
    analyser     = null;
    audioContext = null;
    micSource    = null;
    mediaStream  = null;
    waveformCanvas.classList.remove('active');
    drawFlatLine();
  }

  /* ── Speech Recognition setup ── */
  function buildRecognition() {
    const rec = new SpeechRecognition();
    rec.lang        = selectedLang;
    rec.continuous  = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      // isRecording is already set synchronously in startRecognition();
      // this is just a safety net in case of delayed start
      if (!shouldStop) setUIRecording(true);
    };

    rec.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          finalTranscript += result[0].transcript;
          punctuateAndAppend(result[0].transcript);
        } else {
          interim += result[0].transcript;
        }
      }
      interimText.textContent = interim;
      transcriptPlaceholder.style.display = finalTranscript ? 'none' : 'flex';
      updateWordCount();
      scrollTranscriptToBottom();
    };

    rec.onerror = (event) => {
      if (event.error === 'no-speech') {
        /* Normal idle, keep running */
        return;
      }
      if (event.error === 'not-allowed') {
        showToast('麥克風權限被拒絕，請在瀏覽器設定中允許', 'error');
        stopRecognitionFull();
        return;
      }
      if (event.error === 'network') {
        showToast('網絡錯誤，請檢查網絡連接', 'error');
        return;
      }
      console.warn('Speech recognition error:', event.error);
    };

    rec.onend = () => {
      /* Auto-restart if still recording (continuous mode workaround) */
      /* shouldStop is checked FIRST to prevent restart after user clicks stop */
      if (!shouldStop && isRecording) {
        try { rec.start(); } catch (_) {}
      } else {
        isRecording = false;
        setUIRecording(false);
      }
    };

    return rec;
  }

  /* ── Append text with smart punctuation ── */
  function punctuateAndAppend(text) {
    if (!text) return;
    const trimmed = text.trim();
    if (!trimmed) return;

    /* Add newline before if previous text ended with sentence-ending punctuation */
    const prevText = transcriptText.textContent;
    const endsWithBreak = /[。！？!?\n]$/.test(prevText);

    if (prevText && !endsWithBreak) {
      transcriptText.textContent += ' ' + trimmed;
    } else {
      transcriptText.textContent += trimmed;
    }
  }

  function scrollTranscriptToBottom() {
    const box = document.querySelector('.transcript-content');
    box.scrollTop = box.scrollHeight;
  }

  /* ── Start recording ── */
  async function startRecognition() {
    if (!SpeechRecognition) return;
    if (isRecording) return;          // guard against double-start
    shouldStop      = false;
    isRecording     = true;           // set IMMEDIATELY (sync) before any async
    finalTranscript = '';
    setUIRecording(true);             // update UI right away
    recognition = buildRecognition();

    try {
      recognition.start();
      await startAudioVisualizer();
      startTimer();
      showToast('🎙 錄音已開始', 'success');
    } catch (err) {
      // rollback if start failed
      isRecording = false;
      shouldStop  = true;
      setUIRecording(false);
      recognition = null;
      console.error('Failed to start recognition:', err);
      showToast('啟動錄音失敗，請重試', 'error');
    }
  }

  function stopRecognition() {
    shouldStop  = true;   // block onend from restarting
    isRecording = false;
    if (recognition) {
      try { recognition.abort(); } catch (_) {}
      recognition = null;
    }
    stopAudioVisualizer();
    stopTimer();
  }

  function stopRecognitionFull() {
    stopRecognition();
    setUIRecording(false);
    interimText.textContent = '';
    showToast('錄音已停止', '');
  }

  /* ── UI state ── */
  function setUIRecording(active) {
    if (active) {
      // Switch button to 「停止」 state
      toggleBtn.classList.add('recording');
      btnIdle.classList.add('hidden');
      btnRecording.classList.remove('hidden');
      toggleBtnLabel.textContent = '點擊停止錄音';
      toggleBtnLabel.classList.add('recording');
      micRing.classList.add('active');
      statusDot.classList.add('recording');
      statusText.textContent = '正在錄音中…';
      timerEl.style.color = '#FF6B6B';
    } else {
      // Switch button back to 「開始」 state
      toggleBtn.classList.remove('recording');
      btnIdle.classList.remove('hidden');
      btnRecording.classList.add('hidden');
      toggleBtnLabel.textContent = '點擊開始錄音';
      toggleBtnLabel.classList.remove('recording');
      micRing.classList.remove('active');
      statusDot.classList.remove('recording');
      statusText.textContent = '準備就緒';
      timerEl.style.color = '';
    }
  }

  /* ── Toggle button — one button, two states ── */
  toggleBtn.addEventListener('click', () => {
    if (isRecording) {
      stopRecognitionFull();
    } else {
      startRecognition();
    }
  });

  /* ── Copy ── */
  copyBtn.addEventListener('click', () => {
    const text = getFullTranscript();
    if (!text) { showToast('沒有文字可複製', 'error'); return; }
    navigator.clipboard.writeText(text)
      .then(() => showToast('✓ 已複製到剪貼簿', 'success'))
      .catch(() => {
        /* Fallback */
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        showToast('✓ 已複製到剪貼簿', 'success');
      });
  });

  /* ── Download ── */
  downloadBtn.addEventListener('click', () => {
    const text = getFullTranscript();
    if (!text) { showToast('沒有文字可下載', 'error'); return; }
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const filename  = `voicenotes-${timestamp}.txt`;
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
    showToast('✓ 已下載 ' + filename, 'success');
  });

  /* ── Clear ── */
  clearBtn.addEventListener('click', () => {
    if (!getFullTranscript()) return;
    if (!confirm('確定清除所有文字？')) return;
    finalTranscript = '';
    transcriptText.textContent = '';
    interimText.textContent = '';
    transcriptPlaceholder.style.display = 'flex';
    updateWordCount();
    showToast('已清除文字', '');
  });

  function getFullTranscript() {
    return transcriptText.textContent.trim();
  }

  /* ── Toast ── */
  let toastTimer = null;
  function showToast(message, type = '') {
    toastEl.textContent = message;
    toastEl.className   = 'toast';
    if (type) toastEl.classList.add(type);
    toastEl.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.classList.remove('show');
    }, 2800);
  }

  /* ── Initial flat waveform ── */
  drawFlatLine();

  /* ── Demo card animation — cycling phrases ── */
  const DEMO_PHRASES = [
    [
      '今日', '嘅', ' meeting', ' 好', ' productive，',
      '我哋', '決定', ' launch', ' 新', ' feature…'
    ],
    [
      '呢份', ' project', ' proposal', ' 要', ' present',
      '俾', ' client，', '最好', ' Monday', ' 之前搞掂。'
    ],
    [
      '記得', ' book', ' 星期五', '嘅', ' 機票，',
      '我哋', '一齊', ' 去', ' conference', '！'
    ],
    [
      '今晚', '食', ' Korean BBQ', '定係', ' 去',
      ' Tsim Sha Tsui', '嗰間', '日本', '餐廳？'
    ],
  ];

  let phraseIndex = 0;
  const demoTextEl = document.getElementById('demoText');

  function runDemoAnimation() {
    const words = DEMO_PHRASES[phraseIndex];
    phraseIndex = (phraseIndex + 1) % DEMO_PHRASES.length;

    /* Clear existing words except typed-cursor */
    demoTextEl.innerHTML = '';
    const cursor = document.createElement('span');
    cursor.className = 'typed-cursor demo-word';
    cursor.textContent = '…';

    words.forEach((word, i) => {
      setTimeout(() => {
        const span = document.createElement('span');
        span.className = 'demo-word';
        span.textContent = word;
        span.style.animationDelay = '0s';
        demoTextEl.insertBefore(span, cursor);
        if (i === 0) demoTextEl.appendChild(cursor);
      }, i * 180);
    });
  }

  /* Initial run */
  setTimeout(runDemoAnimation, 800);
  setInterval(runDemoAnimation, 6000);

  /* ── Keyboard shortcut: Space to toggle ── */
  document.addEventListener('keydown', (e) => {
    /* Only when not focused on an input */
    if (e.code === 'Space' && document.activeElement === document.body) {
      e.preventDefault();
      toggleBtn.click();
    }
  });

  /* ── AI Analysis ── */

  /* localStorage helpers */
  function getApiKey()   { return localStorage.getItem('vn_openai_key') || ''; }
  function setApiKey(k)  { localStorage.setItem('vn_openai_key', k); }
  function getAiModel()  { return localStorage.getItem('vn_ai_model') || 'gpt-4o-mini'; }
  function setAiModel(m) { localStorage.setItem('vn_ai_model', m); }

  let pendingAnalyzeAfterSave = false;

  function openApiKeyModal(runAfterSave = false) {
    pendingAnalyzeAfterSave = runAfterSave;
    apiKeyInput.value   = getApiKey();
    aiModelSelect.value = getAiModel();
    apiKeyModal.classList.remove('hidden');
    setTimeout(() => apiKeyInput.focus(), 80);
  }

  function closeApiKeyModal() {
    apiKeyModal.classList.add('hidden');
  }

  /* Toggle password visibility */
  apiKeyToggleVis.addEventListener('click', () => {
    const isPwd = apiKeyInput.type === 'password';
    apiKeyInput.type = isPwd ? 'text' : 'password';
    apiKeyToggleVis.querySelector('svg').innerHTML = isPwd
      ? '<path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>'
      : '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
  });

  apiKeyModalClose.addEventListener('click',  closeApiKeyModal);
  apiKeyModalCancel.addEventListener('click', closeApiKeyModal);
  apiKeyModal.addEventListener('click', (e) => { if (e.target === apiKeyModal) closeApiKeyModal(); });

  apiKeyModalSave.addEventListener('click', () => {
    const key   = apiKeyInput.value.trim();
    const model = aiModelSelect.value;
    if (!key) { showToast('請輸入 OpenAI API 金鑰', 'error'); apiKeyInput.focus(); return; }
    setApiKey(key);
    setAiModel(model);
    closeApiKeyModal();
    showToast('✓ API 設定已儲存', 'success');
    if (pendingAnalyzeAfterSave) {
      pendingAnalyzeAfterSave = false;
      runAnalysis();
    }
  });

  aiSettingsBtn.addEventListener('click', () => openApiKeyModal(false));
  aiCloseBtn.addEventListener('click',    () => aiPanel.classList.add('hidden'));
  aiReanalyzeBtn.addEventListener('click', runAnalysis);

  analyzeBtn.addEventListener('click', () => {
    const text = getFullTranscript();
    if (!text) { showToast('請先錄音取得文字後再 AI 分析', 'error'); return; }
    if (!getApiKey()) { openApiKeyModal(true); return; }
    aiPanel.classList.remove('hidden');
    runAnalysis();
  });

  async function runAnalysis() {
    const text = getFullTranscript();
    if (!text) { showToast('沒有文字可分析', 'error'); return; }
    const apiKey = getApiKey();
    if (!apiKey) { openApiKeyModal(true); return; }
    const model = getAiModel();

    aiPanel.classList.remove('hidden');
    aiPanelBody.innerHTML = `
      <div class="ai-loading">
        <div class="ai-spinner"></div>
        <span>正在透過 AI 分析語音內容，請稍候…</span>
      </div>`;

    const prompt = `你是一個語音記錄分析助手。以下是一段語音轉錄文字（可能包含廣東話、英文或普通話）。請分析內容，以繁體中文回覆，使用 JSON 格式：
{
  "summary": "一至兩句話的內容摘要",
  "keyPoints": ["重點1", "重點2", "（共3至7點）"],
  "actionItems": ["待辦事項1", "（如無則為空陣列 []）"]
}

語音轉錄內容：
${text}`;

    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.4,
          response_format: { type: 'json_object' },
        }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        const errMsg  = errData?.error?.message || `HTTP ${res.status}`;
        throw new Error(errMsg);
      }

      const data    = await res.json();
      const content = data.choices?.[0]?.message?.content || '';
      let parsed;
      try { parsed = JSON.parse(content); } catch (_) { throw new Error('AI 回應格式錯誤，請重試'); }
      renderAnalysisResult(parsed);

    } catch (err) {
      aiPanelBody.innerHTML = `
        <div class="ai-error-box">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" style="flex-shrink:0;margin-top:2px"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
          <span><strong>分析失敗：</strong>${escHtml(err.message)}<br><span style="font-size:0.8rem;opacity:0.8">請確認 API 金鑰正確，或點擊「API 設定」更新金鑰。</span></span>
        </div>`;
    }
  }

  function renderAnalysisResult(data) {
    const summary     = data.summary     || '';
    const keyPoints   = Array.isArray(data.keyPoints)   ? data.keyPoints   : [];
    const actionItems = Array.isArray(data.actionItems) ? data.actionItems : [];

    let html = '';

    if (summary) {
      html += `
        <div class="ai-result-section">
          <div class="ai-result-label">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            摘要
          </div>
          <div class="ai-summary-box">${escHtml(summary)}</div>
        </div>`;
    }

    if (keyPoints.length) {
      const items = keyPoints.map(p => `<li>${escHtml(p)}</li>`).join('');
      html += `
        <div class="ai-result-section">
          <div class="ai-result-label">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z"/></svg>
            重點
          </div>
          <ul class="ai-key-points">${items}</ul>
        </div>`;
    }

    if (actionItems.length) {
      const items = actionItems.map(p => `<li>${escHtml(p)}</li>`).join('');
      html += `
        <div class="ai-result-section">
          <div class="ai-result-label">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>
            行動項目
          </div>
          <ul class="ai-action-items">${items}</ul>
        </div>`;
    }

    aiPanelBody.innerHTML = html || '<p style="color:var(--text-muted);font-size:0.875rem">沒有分析結果。</p>';
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  console.info(
    '%cVoiceNotes 🎙',
    'color:#6C63FF;font-size:16px;font-weight:bold;',
    '\nSupports: zh-HK (Cantonese+English+Mandarin), zh-CN, en-US\nPress SPACE to toggle recording.'
  );
})();
