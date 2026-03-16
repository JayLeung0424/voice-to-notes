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
  const waveformCanvas    = document.getElementById('waveformCanvas');
  const toastEl           = document.getElementById('toast');
  const browserWarn       = document.getElementById('browserWarn');
  const navbar            = document.getElementById('navbar');

  /* ── AI Analysis DOM refs ── */
  const analyzeBtn        = document.getElementById('analyzeBtn');
  const aiPanel           = document.getElementById('aiPanel');
  const aiPanelBody       = document.getElementById('aiPanelBody');
  const aiReanalyzeBtn    = document.getElementById('aiReanalyzeBtn');
  const aiCloseBtn        = document.getElementById('aiCloseBtn');

  /* ── Audio Upload DOM refs ── */
  const audioUploadInput   = document.getElementById('audioUploadInput');
  const uploadBtn          = document.getElementById('uploadBtn');
  const uploadDropZone     = document.getElementById('uploadDropZone');
  const uploadStatus       = document.getElementById('uploadStatus');
  const uploadStatusText   = document.getElementById('uploadStatusText');
  const uploadProgressFill = document.getElementById('uploadProgressFill');
  const transcribingBar    = document.getElementById('transcribingBar');

  /* ── State ── */
  let isRecording         = false;
  let isTranscribing      = false;
  let finalTranscript     = '';
  let timerInterval       = null;
  let secondsElapsed      = 0;
  let audioContext        = null;
  let analyser            = null;
  let micSource           = null;
  let animFrameId         = null;
  let mediaStream         = null;
  let mediaRecorder       = null;
  let audioChunks         = [];
  let lastTranscriptId    = null;

  /* ── Navbar scroll ── */
  window.addEventListener('scroll', () => {
    navbar.classList.toggle('scrolled', window.scrollY > 20);
  });

  /* ── Browser support check ── */
  if (!window.MediaRecorder) {
    browserWarn.classList.remove('hidden');
    toggleBtn.disabled = true;
    toggleBtn.style.opacity = '0.4';
    toggleBtn.style.cursor = 'not-allowed';
    console.warn('MediaRecorder not supported.');
  }

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

  function startAudioVisualizer(stream) {
    try {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      micSource = audioContext.createMediaStreamSource(stream);
      micSource.connect(analyser);
      waveformCanvas.classList.add('active');
      drawWaveform();
    } catch (err) {
      console.warn('Visualizer setup failed:', err);
    }
  }

  function stopAudioVisualizer() {
    if (animFrameId) cancelAnimationFrame(animFrameId);
    if (micSource)   micSource.disconnect();
    if (audioContext && audioContext.state !== 'closed') audioContext.close();
    analyser     = null;
    audioContext = null;
    micSource    = null;
    waveformCanvas.classList.remove('active');
    drawFlatLine();
  }

  /* ── AssemblyAI API helpers ── */
  const ASSEMBLYAI_BASE = 'https://api.assemblyai.com';

  const MAX_UPLOAD_BYTES = 500 * 1024 * 1024; // 500 MB (AssemblyAI limit)

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function assemblyUpload(blob, apiKey) {
    const res = await fetch(`${ASSEMBLYAI_BASE}/v2/upload`, {
      method: 'POST',
      headers: { 'Authorization': apiKey, 'Content-Type': 'application/octet-stream' },
      body: blob,
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e?.error || `上傳失敗 HTTP ${res.status}`);
    }
    return (await res.json()).upload_url;
  }

  async function assemblyCreateTranscript(audioUrl, apiKey) {
    const body = {
      audio_url: audioUrl,
      speech_models: ['universal'],
      language_detection: true,
    };
    const res = await fetch(`${ASSEMBLYAI_BASE}/v2/transcript`, {
      method: 'POST',
      headers: { 'Authorization': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e?.error || `建立轉錄失敗 HTTP ${res.status}`);
    }
    const data = await res.json();
    lastTranscriptId = data.id;
    return data.id;
  }

  async function assemblyPollTranscript(id, apiKey) {
    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
      await sleep(2500);
      const res = await fetch(`${ASSEMBLYAI_BASE}/v2/transcript/${id}`, {
        headers: { 'Authorization': apiKey },
      });
      if (!res.ok) throw new Error(`查詢失敗 HTTP ${res.status}`);
      const data = await res.json();
      if (data.status === 'completed') return data.text || '';
      if (data.status === 'error')     throw new Error(data.error || '轉錄失敗');
    }
    throw new Error('轉錄逾時（超過 5 分鐘），請重試');
  }

  async function assemblyTranscribeBlob(blob, apiKey) {
    const uploadUrl = await assemblyUpload(blob, apiKey);
    const id = await assemblyCreateTranscript(uploadUrl, apiKey);
    return await assemblyPollTranscript(id, apiKey);
  }

  function scrollTranscriptToBottom() {
    const box = document.querySelector('.transcript-content');
    box.scrollTop = box.scrollHeight;
  }

  /* ── MediaRecorder recording ── */
  async function startRecording() {
    if (isRecording || isTranscribing) return;
    if (!getApiKey()) {
      showToast('API 金鑰尚未設定，請聯絡管理員', 'error');
      return;
    }
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      if (err.name === 'NotAllowedError') {
        showToast('麥克風權限被拒絕，請在瀏覽器設定中允許', 'error');
      } else {
        showToast('無法存取麥克風，請重試', 'error');
      }
      return;
    }
    audioChunks = [];
    mediaRecorder = new MediaRecorder(mediaStream);
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };
    mediaRecorder.onstop = () => handleRecordingStop();
    mediaRecorder.start(1000);
    startAudioVisualizer(mediaStream);
    isRecording = true;
    startTimer();
    setUIRecording(true);
    showToast('🎙 錄音已開始', 'success');
  }

  function stopRecording() {
    if (!isRecording) return;
    isRecording = false;
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
    stopAudioVisualizer();
    stopTimer();
    setUIRecording(false);
    interimText.textContent = '';
  }

  async function handleRecordingStop() {
    /* Release microphone immediately */
    if (mediaStream) {
      mediaStream.getTracks().forEach(t => t.stop());
      mediaStream = null;
    }
    if (audioChunks.length === 0) return;
    const blob   = new Blob(audioChunks, { type: 'audio/webm' });
    audioChunks  = [];
    const apiKey = getApiKey();
    if (!apiKey) return;
    isTranscribing = true;
    setUITranscribing(true);
    try {
      const text = await assemblyTranscribeBlob(blob, apiKey);
      if (!text) throw new Error('轉錄結果為空，請確認錄音包含語音內容');
      finalTranscript = text;
      transcriptText.textContent = text;
      transcriptPlaceholder.style.display = 'none';
      updateWordCount();
      scrollTranscriptToBottom();
      showToast('✓ 錄音轉錄完成，正在分析重點…', 'success');
      aiPanel.classList.remove('hidden');
      runAnalysis();
    } catch (err) {
      showToast(`轉錄失敗：${err.message}`, 'error');
    } finally {
      isTranscribing = false;
      setUITranscribing(false);
    }
  }

  /* ── UI transcribing state ── */
  function setUITranscribing(active) {
    if (active) {
      toggleBtn.disabled = true;
      toggleBtnLabel.textContent = '轉錄中…';
      statusDot.classList.add('transcribing');
      statusText.textContent = '正在透過 AssemblyAI 轉錄…';
      transcribingBar.classList.remove('hidden');
    } else {
      toggleBtn.disabled = false;
      toggleBtnLabel.textContent = '點擊開始錄音';
      statusDot.classList.remove('transcribing');
      statusText.textContent = '準備就緒';
      transcribingBar.classList.add('hidden');
    }
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
    if (isTranscribing) return;
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
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

  /* ── Auto-load API key from config.js ── */
  if (window.ASSEMBLYAI_KEY && window.ASSEMBLYAI_KEY.trim()) {
    setApiKey(window.ASSEMBLYAI_KEY.trim());
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
  function getApiKey()   { return localStorage.getItem('vn_assemblyai_key') || ''; }
  function setApiKey(k)  { localStorage.setItem('vn_assemblyai_key', k); }

  aiCloseBtn.addEventListener('click', () => aiPanel.classList.add('hidden'));
  aiReanalyzeBtn.addEventListener('click', runAnalysis);

  analyzeBtn.addEventListener('click', () => {
    const text = getFullTranscript();
    if (!text) { showToast('請先取得轉錄文字後再進行 AI 分析', 'error'); return; }
    aiPanel.classList.remove('hidden');
    runAnalysis();
  });

  async function runAnalysis() {
    const text = getFullTranscript();
    if (!text) { showToast('沒有文字可分析', 'error'); return; }
    const apiKey = getApiKey();
    if (!apiKey) { showToast('API 金鑰尚未設定，請聯絡管理員', 'error'); return; }

    aiPanel.classList.remove('hidden');
    aiPanelBody.innerHTML = `
      <div class="ai-loading">
        <div class="ai-spinner"></div>
        <span>正在透過 AssemblyAI LeMUR 分析內容，請稍候…</span>
      </div>`;

    const prompt = `你是語音記錄分析助手。以下是一段語音轉錄文字（可能包含廣東話、英文或普通話）。請分析內容並以繁體中文回覆，必須使用以下 JSON 格式，不得有其他文字：
{
  "summary": "一至兩句話的內容摘要",
  "keyPoints": ["重點1", "重點2"],
  "actionItems": ["待辦事項1"]
}
如無待辦事項 actionItems 回傳空陣列 []。`;

    const body = {
      prompt,
      final_model: 'anthropic/claude-3-5-sonnet',
      max_output_size: 2000,
      temperature: 0.2,
    };

    if (lastTranscriptId) {
      body.transcript_ids = [lastTranscriptId];
    } else {
      body.input_text = text;
    }

    try {
      const res = await fetch('/api/lemur', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData?.error || `HTTP ${res.status}`);
      }

      const data = await res.json();
      const raw  = (data.response || '').trim();
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('AI 回應格式錯誤，請重試');
      const parsed = JSON.parse(jsonMatch[0]);
      renderAnalysisResult(parsed);

    } catch (err) {
      aiPanelBody.innerHTML = `
        <div class="ai-error-box">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" style="flex-shrink:0;margin-top:2px"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
          <span><strong>分析失敗：</strong>${escHtml(err.message)}<br><span style="font-size:0.8rem;opacity:0.8">請確認 AssemblyAI API 金鑰正確，或點擊「API 設定」更新金鑰。</span></span>
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

  /* ── Audio File Upload & AssemblyAI Transcription ── */

  function setUploadStatus(visible, text = '', progress = null) {
    if (visible) {
      uploadStatus.classList.remove('hidden');
      uploadDropZone.classList.add('hidden');
      uploadStatusText.textContent = text;
      if (progress !== null) {
        uploadProgressFill.style.width = `${Math.min(100, progress)}%`;
      }
    } else {
      uploadStatus.classList.add('hidden');
      uploadDropZone.classList.remove('hidden');
      uploadProgressFill.style.width = '0%';
    }
  }

  async function transcribeAudioFile(file) {
    const apiKey = getApiKey();
    if (!apiKey) {
      showToast('API 金鑰尚未設定，請聯絡管理員', 'error');
      return;
    }

    if (file.size > MAX_UPLOAD_BYTES) {
      showToast('檔案過大，請選擇較小的檔案', 'error');
      return;
    }

    setUploadStatus(true, '正在上傳音訊至 AssemblyAI…', 10);

    let fakeProgress = 10;
    let progressInterval = null;
    let pollProgressInterval = null;

    progressInterval = setInterval(() => {
      fakeProgress = Math.min(fakeProgress + 2, 40);
      uploadProgressFill.style.width = `${fakeProgress}%`;
    }, 500);

    try {
      const uploadUrl = await assemblyUpload(file, apiKey);
      clearInterval(progressInterval);
      setUploadStatus(true, '正在建立轉錄任務…', 45);

      const transcriptId = await assemblyCreateTranscript(uploadUrl, apiKey);
      setUploadStatus(true, '正在轉錄中，請稍候…', 50);

      let pollProgress = 50;
      pollProgressInterval = setInterval(() => {
        pollProgress = Math.min(pollProgress + 1.5, 90);
        uploadProgressFill.style.width = `${pollProgress}%`;
      }, 1000);

      const text = await assemblyPollTranscript(transcriptId, apiKey);
      clearInterval(pollProgressInterval);

      if (!text) throw new Error('轉錄結果為空，請確認音訊檔案包含語音內容');

      setUploadStatus(true, '✓ 轉錄完成！', 100);

      finalTranscript = text;
      transcriptText.textContent = text;
      interimText.textContent = '';
      transcriptPlaceholder.style.display = 'none';
      updateWordCount();
      scrollTranscriptToBottom();

      setTimeout(() => {
        setUploadStatus(false);
        showToast(`✓ 音訊轉錄完成（${file.name}）`, 'success');
        aiPanel.classList.remove('hidden');
        runAnalysis();
      }, 800);

    } catch (err) {
      clearInterval(progressInterval);
      clearInterval(pollProgressInterval);
      setUploadStatus(false);
      showToast(`轉錄失敗：${err.message}`, 'error');
    }
  }

  /* Upload button click */
  uploadBtn.addEventListener('click', () => {
    if (!getApiKey()) {
      showToast('API 金鑰尚未設定，請聯絡管理員', 'error');
      return;
    }
    audioUploadInput.value = '';
    audioUploadInput.click();
  });

  audioUploadInput.addEventListener('change', () => {
    const file = audioUploadInput.files[0];
    if (file) transcribeAudioFile(file);
  });

  /* Drag-and-drop */
  uploadDropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadDropZone.classList.add('drag-over');
  });

  uploadDropZone.addEventListener('dragleave', () => {
    uploadDropZone.classList.remove('drag-over');
  });

  uploadDropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadDropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (!file) return;
    if (!file.type.startsWith('audio/') && !file.type.startsWith('video/')) {
      showToast('請上傳音訊或影片檔案', 'error');
      return;
    }
    transcribeAudioFile(file);
  });

  console.info(
    '%cVoiceNotes 🎙',
    'color:#6C63FF;font-size:16px;font-weight:bold;',
    '\nPowered by AssemblyAI — Transcription & LeMUR Analysis\nPress SPACE to toggle recording.'
  );
})();
