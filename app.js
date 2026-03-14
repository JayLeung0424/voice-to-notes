/* ─────────────────────────────────────────────────────────────
   VoiceNotes — app.js
   Speech recognition with Web Speech API
   Supports: zh-HK (Cantonese+English), zh-CN, en-US
───────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  /* ── DOM refs ── */
  const micBtn            = document.getElementById('micBtn');
  const micIcon           = document.getElementById('micIcon');
  const stopIcon          = document.getElementById('stopIcon');
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

  /* ── State ── */
  let recognition         = null;
  let isRecording         = false;
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
    micBtn.disabled = true;
    micBtn.style.opacity = '0.4';
    micBtn.style.cursor = 'not-allowed';
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
        setTimeout(startRecognition, 300);
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
      isRecording = true;
      setUIRecording(true);
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
      if (isRecording) {
        try { rec.start(); } catch (_) {}
      } else {
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
    finalTranscript = '';
    recognition = buildRecognition();

    try {
      recognition.start();
      await startAudioVisualizer();
      startTimer();
      showToast('🎙 錄音已開始', 'success');
    } catch (err) {
      console.error('Failed to start recognition:', err);
      showToast('啟動錄音失敗，請重試', 'error');
    }
  }

  function stopRecognition() {
    if (recognition) {
      isRecording = false;
      recognition.stop();
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
      micBtn.classList.add('recording');
      micIcon.classList.add('hidden');
      stopIcon.classList.remove('hidden');
      micRing.classList.add('active');
      statusDot.classList.add('recording');
      statusText.textContent = '正在錄音中…';
      timerEl.style.color = '#FF6B6B';
    } else {
      micBtn.classList.remove('recording');
      micIcon.classList.remove('hidden');
      stopIcon.classList.add('hidden');
      micRing.classList.remove('active');
      statusDot.classList.remove('recording');
      statusText.textContent = '點擊麥克風開始錄音';
      timerEl.style.color = '';
    }
  }

  /* ── Mic button click ── */
  micBtn.addEventListener('click', () => {
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
      micBtn.click();
    }
  });

  console.info(
    '%cVoiceNotes 🎙',
    'color:#6C63FF;font-size:16px;font-weight:bold;',
    '\nSupports: zh-HK (Cantonese+English+Mandarin), zh-CN, en-US\nPress SPACE to toggle recording.'
  );
})();
