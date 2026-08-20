/* ============================================================
  MicroPlastic AI — Plain JS (all page logic)
  ============================================================ */

/* ============ CHATBOT (shared across all pages) ============ */

/* ============ CHATBOT (LLM CONNECTED) ============ */

var chatMessages = [];
var chatTyping = false;

var greetingMsg = {
  id: 0,
  role: 'assistant',
  text: "Hello. I'm your MicroPlastic AI Research Assistant. Ask me anything about microplastics, contamination levels, or detection methods.",
  time: formatTime()
};

function formatTime() {
  var d = new Date();
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function renderChatMessages() {
  var container = document.getElementById('chatMessages');
  if (!container) return;

  var html = '';
  chatMessages.forEach(function (msg) {
    html += '<div class="chat-msg ' + msg.role + '">';
    html += '<div class="bubble">' + escapeHtml(msg.text) + '</div>';
    html += '<span class="time">' + msg.time + '</span>';
    html += '</div>';
  });

  if (chatTyping) {
    html += '<div class="typing-indicator"><div class="bubble">Thinking...</div></div>';
  }

  container.innerHTML = html;
  container.scrollTop = container.scrollHeight;
}

function escapeHtml(str) {
  var div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function sendMessage() {
  var input = document.getElementById('chatInput');
  if (!input || !input.value.trim()) return;

  var text = input.value.trim();

  chatMessages.push({
    id: Date.now(),
    role: 'user',
    text: text,
    time: formatTime()
  });

  input.value = '';
  chatTyping = true;
  renderChatMessages();

  fetch(BACKEND_URL + '/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: text })
  })
    .then(function (res) { return res.json(); })
    .then(function (data) {

      chatTyping = false;

      chatMessages.push({
        id: Date.now() + 1,
        role: 'assistant',
        text: data.response || "No response from LLM.",
        time: formatTime()
      });

      renderChatMessages();
    })
    .catch(function (err) {
      chatTyping = false;

      chatMessages.push({
        id: Date.now() + 1,
        role: 'assistant',
        text: "Server connection failed.",
        time: formatTime()
      });

      renderChatMessages();
    });
}

function initChatbot() {
  chatMessages = [greetingMsg];
  renderChatMessages();
}

// Toggle chat panel (used by chatbot button onclick)
function toggleChat() {
  var panel = document.getElementById('chatPanel');
  var btn = document.getElementById('chatbotBtn');
  var icon = document.getElementById('chatbotIcon');
  if (!panel) return;
  // Use computed style to determine visibility reliably
  var isVisible = window.getComputedStyle(panel).display !== 'none';
  if (isVisible) {
    panel.style.display = 'none';
    if (btn) btn.className = 'chatbot-btn closed';
    if (icon) {
      icon.style.color = '#fff';
      icon.innerHTML = '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>';
    }
  } else {
    // show panel as block to make it measurable across browsers
    panel.style.display = 'block';
    if (btn) btn.className = 'chatbot-btn open';
    if (icon) {
      icon.style.color = 'var(--primary)';
      icon.innerHTML = '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>';
    }
    renderChatMessages();
  }
}
/* ============ LIVE DETECTION PANEL — real camera + YOLO backend ============ */

var BACKEND_URL = 'http://localhost:5000';
var contamination = 0;
var confidence = 0;
var particleCount = 0;
var alertThreshold = 60;
var sparkData = [];
var animFrameId = 0;
var dataInterval = null;

// Camera state
var cameraStream = null;
var cameraRunning = false;
var detectLoopId = null;
var sessionStartTime = null;
var timerIntervalId = null;
var autoSaveIntervalId = null;
var frameCount = 0;
var totalDetections = 0;
var highConfCount = 0;
var alertCount = 0;
var recentDetectionsList = [];   // for live.html sidebar

/* ---- Helpers ---- */

function getSeverity(v) {
  if (v < 25) return { label: 'Low', cls: 'badge-low' };
  if (v < 50) return { label: 'Moderate', cls: 'badge-moderate' };
  if (v < 75) return { label: 'High', cls: 'badge-high' };
  return { label: 'Critical', cls: 'badge-critical' };
}

function formatElapsed(sec) {
  var m = Math.floor(sec / 60);
  var s = sec % 60;
  return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
}

/* ---- Camera start / stop ---- */

function startCamera() {
  if (cameraRunning) return;
  var video = document.getElementById('cameraVideo');
  if (!video) return;

  navigator.mediaDevices.getUserMedia({ video: true })
    .then(function (stream) {
      cameraStream = stream;
      video.srcObject = stream;
      video.style.display = '';
      var overlay = document.getElementById('overlayCanvas');
      if (overlay) overlay.style.display = '';
      var ph = document.getElementById('cameraPlaceholder');
      if (ph) ph.style.display = 'none';
      var badge = document.getElementById('liveBadge');
      if (badge) badge.style.display = '';
      var tag = document.getElementById('inferenceTag');
      if (tag) tag.style.display = '';

      // Mirror feed into dashboard video element
      var dashVideo = document.getElementById('dashCamVideo');
      if (dashVideo) {
        dashVideo.srcObject = stream;
        dashVideo.style.display = '';
      }
      var dashOverlay = document.getElementById('dashOverlayCanvas');
      if (dashOverlay) dashOverlay.style.display = '';
      var dashLiveBadge = document.getElementById('dashLiveBadge');
      if (dashLiveBadge) dashLiveBadge.style.display = '';
      var dashIdle = document.getElementById('dashCamIdle');
      if (dashIdle) dashIdle.style.display = 'none';

      // Buttons
      var startBtn = document.getElementById('startCameraBtn');
      var stopBtn = document.getElementById('stopCameraBtn');
      if (startBtn) { startBtn.disabled = true; startBtn.style.opacity = '0.5'; }
      if (stopBtn) { stopBtn.disabled = false; stopBtn.style.opacity = ''; }

      cameraRunning = true;
      updateDashCamStatus();
      frameCount = 0;
      totalDetections = 0;
      highConfCount = 0;
      alertCount = 0;
      recentDetectionsList = [];
      sparkData = [];
      sessionStartTime = Date.now();

      // Start timer
      updateTimerDisplay();
      timerIntervalId = setInterval(updateTimerDisplay, 1000);

      // Auto-save session snapshot every 10s so analytics has live data
      autoSaveIntervalId = setInterval(autoSaveLiveSession, 10000);

      // Start detection loop (wait a moment for video to load)
      setTimeout(function () { detectLoop(); }, 600);
    })
    .catch(function (err) {
      console.error('Camera error:', err);
      var msg = 'Could not access camera: ' + err.message;
      if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
        msg = 'No camera found. Please connect a camera and try again.';
      } else if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        msg = 'Camera permission denied. Please allow camera access in your browser settings.';
      }
      alert(msg);
    });
}

function stopCamera() {
  // Clear auto-save interval and live session key
  if (autoSaveIntervalId) { clearInterval(autoSaveIntervalId); autoSaveIntervalId = null; }
  try { localStorage.removeItem('mp_live_session'); } catch (e) { }

  // Save final session to localStorage
  if (sessionStartTime) {
    saveDetectionSession();
  }
  cameraRunning = false;
  updateDashCamStatus();
  // Remove cam-keep class from live view since camera is stopped
  var liveView = document.getElementById('view-live');
  if (liveView) liveView.classList.remove('cam-keep');
  if (cameraStream) {
    cameraStream.getTracks().forEach(function (t) { t.stop(); });
    cameraStream = null;
  }
  var video = document.getElementById('cameraVideo');
  if (video) { video.srcObject = null; video.style.display = 'none'; }
  var overlay = document.getElementById('overlayCanvas');
  if (overlay) { overlay.style.display = 'none'; var ctx = overlay.getContext('2d'); ctx.clearRect(0, 0, overlay.width, overlay.height); }
  var ph = document.getElementById('cameraPlaceholder');
  if (ph) ph.style.display = '';
  var badge = document.getElementById('liveBadge');
  if (badge) badge.style.display = 'none';
  var tag = document.getElementById('inferenceTag');
  if (tag) tag.style.display = 'none';

  if (timerIntervalId) { clearInterval(timerIntervalId); timerIntervalId = null; }

  var startBtn = document.getElementById('startCameraBtn');
  var stopBtn = document.getElementById('stopCameraBtn');
  if (startBtn) { startBtn.disabled = false; startBtn.style.opacity = ''; }
  if (stopBtn) { stopBtn.disabled = true; stopBtn.style.opacity = '0.5'; }
}

/* ---- Persist detection data to localStorage ---- */

function saveDetectionSession() {
  var elapsed = sessionStartTime ? Math.floor((Date.now() - sessionStartTime) / 1000) : 0;
  var session = {
    id: 'sess_' + Date.now(),
    timestamp: Date.now(),
    date: new Date().toISOString(),
    durationSec: elapsed,
    totalDetections: totalDetections,
    highConfCount: highConfCount,
    alertCount: alertCount,
    framesProcessed: frameCount,
    avgContamination: sparkData.length > 0 ? Math.round(sparkData.reduce(function (a, b) { return a + b; }, 0) / sparkData.length) : 0,
    peakContamination: sparkData.length > 0 ? Math.max.apply(null, sparkData) : 0,
    avgConfidence: totalDetections > 0 ? Math.round((highConfCount / totalDetections) * 100) : 0,
    contaminationHistory: sparkData.slice(-30)
  };
  try {
    var sessions = JSON.parse(localStorage.getItem('mp_sessions') || '[]');
    sessions.push(session);
    // Keep last 50 sessions
    if (sessions.length > 50) sessions = sessions.slice(-50);
    localStorage.setItem('mp_sessions', JSON.stringify(sessions));
    if (typeof fbSaveSession === 'function') fbSaveSession(session);
  } catch (e) { console.warn('Could not save session:', e); }
}

function getStoredSessions() {
  try {
    var sessions = JSON.parse(localStorage.getItem('mp_sessions') || '[]');
    // Include the current live session snapshot if camera is running
    var live = localStorage.getItem('mp_live_session');
    if (live) {
      try { sessions.push(JSON.parse(live)); } catch (e) { }
    }
    return sessions;
  } catch (e) { return []; }
}

/* ---- Auto-save current session snapshot while camera runs ---- */
function autoSaveLiveSession() {
  if (!cameraRunning || !sessionStartTime) return;
  var elapsed = Math.floor((Date.now() - sessionStartTime) / 1000);
  var liveSession = {
    id: 'live_' + sessionStartTime,
    timestamp: sessionStartTime,
    date: new Date(sessionStartTime).toISOString(),
    durationSec: elapsed,
    totalDetections: totalDetections,
    highConfCount: highConfCount,
    alertCount: alertCount,
    framesProcessed: frameCount,
    avgContamination: sparkData.length > 0 ? Math.round(sparkData.reduce(function (a, b) { return a + b; }, 0) / sparkData.length) : 0,
    peakContamination: sparkData.length > 0 ? Math.max.apply(null, sparkData) : 0,
    avgConfidence: totalDetections > 0 ? Math.round((highConfCount / totalDetections) * 100) : 0,
    contaminationHistory: sparkData.slice(-30),
    isLive: true
  };
  try { localStorage.setItem('mp_live_session', JSON.stringify(liveSession)); } catch (e) { }
}

function getStoredZones() {
  try { return JSON.parse(localStorage.getItem('mp_zones') || '[]'); } catch (e) { return []; }
}

function updateTimerDisplay() {
  if (!sessionStartTime) return;
  var elapsed = Math.floor((Date.now() - sessionStartTime) / 1000);
  var el = document.getElementById('sessionTimer');
  if (el) el.textContent = formatElapsed(elapsed);
  // Also update sidebar stat if on live page
  var durEl = document.getElementById('statDuration');
  if (durEl) {
    if (elapsed < 60) durEl.textContent = elapsed + 's';
    else if (elapsed < 3600) durEl.textContent = Math.floor(elapsed / 60) + 'm ' + (elapsed % 60) + 's';
    else durEl.textContent = Math.floor(elapsed / 3600) + 'h ' + Math.floor((elapsed % 3600) / 60) + 'm';
  }
}

/* ---- Detection loop: capture frame → send to backend → draw results ---- */

function detectLoop() {
  if (!cameraRunning) return;
  var video = document.getElementById('cameraVideo');
  if (!video || video.readyState < 2) {
    detectLoopId = setTimeout(detectLoop, 300);
    return;
  }

  // Capture frame to a hidden canvas
  var tmpCanvas = document.createElement('canvas');
  // Use natural video dimensions for better quality
  tmpCanvas.width = video.videoWidth;
  tmpCanvas.height = video.videoHeight;
  var tmpCtx = tmpCanvas.getContext('2d');
  tmpCtx.drawImage(video, 0, 0, tmpCanvas.width, tmpCanvas.height);

  // Encode as JPEG base64 with higher quality
  var dataUrl = tmpCanvas.toDataURL('image/jpeg', 0.95);
  var b64 = dataUrl.split(',')[1];

  // Send to backend
  fetch(BACKEND_URL + '/detect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: b64 })
  })
    .then(function (res) { return res.json(); })
    .then(function (data) {
      if (!cameraRunning) return;
      frameCount++;
      processDetectionResult(data);
      // Schedule next frame (adaptive: fast if no detections, wait a bit if many)
      var delay = data.detections.length > 5 ? 400 : 250;
      detectLoopId = setTimeout(detectLoop, delay);
    })
    .catch(function (err) {
      console.error('Detection error:', err);
      if (cameraRunning) detectLoopId = setTimeout(detectLoop, 1000);
    });
}

/* ---- Process result from backend ---- */

function processDetectionResult(data) {
  var dets = data.detections || [];
  var infMs = data.inference_ms || 0;

  // Update inference display
  var msEl = document.getElementById('inferenceMs');
  if (msEl) msEl.textContent = Math.round(infMs);

  // Draw bounding boxes on overlay canvas
  drawOverlayBoxes(dets);

  // Calculate metrics from real detections
  var numParticles = dets.length;
  var avgConf = 0;
  if (numParticles > 0) {
    var sum = 0;
    for (var i = 0; i < dets.length; i++) sum += dets[i].confidence;
    avgConf = (sum / numParticles) * 100;
  }
  // Contamination = particles detected / normalizing factor (scale 0-100)
  // We'll use a rough estimate: each detection adds ~8% contamination, capped at 100
  var contam = Math.min(100, numParticles * 8);

  contamination = contam;
  confidence = avgConf;
  particleCount = numParticles;

  // Accumulate session stats
  totalDetections += numParticles;
  for (var j = 0; j < dets.length; j++) {
    if (dets[j].confidence >= 0.8) highConfCount++;
  }

  // Check alert threshold
  var alertActive = contamination > alertThreshold;
  if (alertActive) alertCount++;

  // Update UI
  updateMetricsUI();
  updateDashboardMetrics();

  // Sparkline
  sparkData.push(contamination);
  if (sparkData.length > 60) sparkData.shift();
  drawSparkline();
  updateTrend();

  // Update recent detections sidebar (live.html)
  updateRecentDetections(dets);

  // Update header stats (live.html)
  var hInf = document.getElementById('headerInference');
  if (hInf) hInf.textContent = Math.round(infMs) + 'ms';
  var hFr = document.getElementById('headerFrames');
  if (hFr) hFr.textContent = frameCount;
  var hSam = document.getElementById('headerSamples');
  if (hSam) hSam.textContent = totalDetections;

  // Session stats sidebar
  var stDet = document.getElementById('statTotalDetections');
  if (stDet) stDet.textContent = totalDetections;
  var stHC = document.getElementById('statHighConf');
  if (stHC) stHC.textContent = highConfCount;
  var stAl = document.getElementById('statAlerts');
  if (stAl) stAl.textContent = alertCount;
}

function updateMetricsUI() {
  var cEl = document.getElementById('contaminationValue');
  if (cEl) cEl.textContent = contamination.toFixed(1) + '%';
  var confEl = document.getElementById('confidenceValue');
  if (confEl) confEl.textContent = confidence.toFixed(1) + '%';
  var pcEl = document.getElementById('particleCountValue');
  if (pcEl) pcEl.textContent = particleCount;

  var sev = getSeverity(contamination);
  var badge = document.getElementById('severityBadge');
  if (badge) badge.className = sev.cls;
  var sevText = document.getElementById('severityText');
  if (sevText) sevText.textContent = cameraRunning ? sev.label : 'Idle';

  var alertActive = contamination > alertThreshold;
  var panel = document.getElementById('livePanel');
  if (panel) {
    if (alertActive) panel.classList.add('alert-glow');
    else panel.classList.remove('alert-glow');
  }
  var ta = document.getElementById('thresholdAlert');
  if (ta) ta.style.display = alertActive ? '' : 'none';
  var ab = document.getElementById('alertBanner');
  if (ab && alertActive) ab.style.display = '';
  var navBar = document.getElementById('navAlertBar');
  if (navBar) {
    if (alertActive) navBar.classList.add('active');
    else navBar.classList.remove('active');
  }
  var bellBtn = document.getElementById('bellBtn');
  if (bellBtn) {
    if (alertActive) bellBtn.classList.add('alert-active');
    else bellBtn.classList.remove('alert-active');
  }
}

/* ---- Draw bounding boxes on overlay canvas ---- */

function drawOverlayBoxes(dets) {
  var overlay = document.getElementById('overlayCanvas');
  var video = document.getElementById('cameraVideo');
  if (!overlay || !video) return;

  var rect = overlay.parentElement.getBoundingClientRect();
  overlay.width = rect.width * 2;
  overlay.height = rect.height * 2;
  var ctx = overlay.getContext('2d');
  ctx.scale(2, 2);
  ctx.clearRect(0, 0, rect.width, rect.height);

  var cw = rect.width, ch = rect.height;
  var vw = video.videoWidth, vh = video.videoHeight;
  var ratio = Math.min(cw / vw, ch / vh);
  var rw = vw * ratio, rh = vh * ratio;
  var rx = (cw - rw) / 2, ry = (ch - rh) / 2;

  dets.forEach(function (d) {
    var x1 = rx + d.x1 * rw;
    var y1 = ry + d.y1 * rh;
    var x2 = rx + d.x2 * rw;
    var y2 = ry + d.y2 * rh;
    var bw = x2 - x1;
    var bh = y2 - y1;

    // Determine color based on confidence
    var color = d.confidence >= 0.8 ? '#0ea5e9' : d.confidence >= 0.5 ? '#d97706' : '#dc2626';

    // Box outline
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x1, y1, bw, bh);

    // Corner brackets
    var cs = Math.min(8, bw * 0.2, bh * 0.2);
    ctx.lineWidth = 2;
    // Top-left
    ctx.beginPath(); ctx.moveTo(x1, y1 + cs); ctx.lineTo(x1, y1); ctx.lineTo(x1 + cs, y1); ctx.stroke();
    // Top-right
    ctx.beginPath(); ctx.moveTo(x2 - cs, y1); ctx.lineTo(x2, y1); ctx.lineTo(x2, y1 + cs); ctx.stroke();
    // Bottom-left
    ctx.beginPath(); ctx.moveTo(x1, y2 - cs); ctx.lineTo(x1, y2); ctx.lineTo(x1 + cs, y2); ctx.stroke();
    // Bottom-right
    ctx.beginPath(); ctx.moveTo(x2 - cs, y2); ctx.lineTo(x2, y2); ctx.lineTo(x2, y2 - cs); ctx.stroke();

    // Label
    var label = d.class_name + ' ' + (d.confidence * 100).toFixed(0) + '%';
    ctx.font = '500 9px Inter, sans-serif';
    var tw = ctx.measureText(label).width + 6;
    var lh = 14;
    var lx = x1;
    var ly = y1 - lh - 2;
    if (ly < 0) ly = y1 + 2;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    // roundRect polyfill
    if (ctx.roundRect) {
      ctx.roundRect(lx, ly, tw, lh, 3);
    } else {
      ctx.rect(lx, ly, tw, lh);
    }
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#fff';
    ctx.fillText(label, lx + 3, ly + 10);
  });

  // Mirror detections onto dashboard overlay canvas
  drawDashOverlayBoxes(dets);
}

/* ---- Mirror detection boxes onto dashboard overlay canvas ---- */
function drawDashOverlayBoxes(dets) {
  var dashOverlay = document.getElementById('dashOverlayCanvas');
  if (!dashOverlay) return;
  var container = document.getElementById('dashCamFeedContainer');
  if (!container) return;

  var rect = container.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;

  dashOverlay.width = rect.width * 2;
  dashOverlay.height = rect.height * 2;
  var ctx = dashOverlay.getContext('2d');
  ctx.scale(2, 2);
  ctx.clearRect(0, 0, rect.width, rect.height);

  var cw = rect.width, ch = rect.height;
  var videoRef = document.getElementById('cameraVideo');
  if (!videoRef || !videoRef.videoWidth) return;

  var vw = videoRef.videoWidth, vh = videoRef.videoHeight;
  var ratio = Math.min(cw / vw, ch / vh);
  var rw = vw * ratio, rh = vh * ratio;
  var rx = (cw - rw) / 2, ry = (ch - rh) / 2;

  dets.forEach(function (d) {
    var x1 = rx + d.x1 * rw;
    var y1 = ry + d.y1 * rh;
    var x2 = rx + d.x2 * rw;
    var y2 = ry + d.y2 * rh;
    var bw = x2 - x1;
    var bh = y2 - y1;
    var color = d.confidence >= 0.8 ? '#0ea5e9' : d.confidence >= 0.5 ? '#d97706' : '#dc2626';

    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x1, y1, bw, bh);

    var cs = Math.min(8, bw * 0.2, bh * 0.2);
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x1, y1 + cs); ctx.lineTo(x1, y1); ctx.lineTo(x1 + cs, y1); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x2 - cs, y1); ctx.lineTo(x2, y1); ctx.lineTo(x2, y1 + cs); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x1, y2 - cs); ctx.lineTo(x1, y2); ctx.lineTo(x1 + cs, y2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x2 - cs, y2); ctx.lineTo(x2, y2); ctx.lineTo(x2, y2 - cs); ctx.stroke();

    var label = d.class_name + ' ' + (d.confidence * 100).toFixed(0) + '%';
    ctx.font = '500 9px Inter, sans-serif';
    var tw = ctx.measureText(label).width + 6;
    var lh = 14;
    var lx = x1;
    var ly = y1 - lh - 2;
    if (ly < 0) ly = y1 + 2;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    if (ctx.roundRect) { ctx.roundRect(lx, ly, tw, lh, 3); } else { ctx.rect(lx, ly, tw, lh); }
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#fff';
    ctx.fillText(label, lx + 3, ly + 10);
  });
}

/* ---- Recent Detections sidebar (live.html) ---- */

function updateRecentDetections(dets) {
  var container = document.getElementById('recentDetections');
  if (!container) return;
  var now = Date.now();
  // Add new detections to front
  for (var i = 0; i < dets.length; i++) {
    recentDetectionsList.unshift({
      type: dets[i].class_name,
      conf: Math.round(dets[i].confidence * 100),
      time: now
    });
  }
  // Keep last 20
  if (recentDetectionsList.length > 20) recentDetectionsList.length = 20;

  var html = '';
  recentDetectionsList.forEach(function (d) {
    var ago = Math.floor((now - d.time) / 1000);
    var agoStr = ago < 60 ? ago + 's ago' : Math.floor(ago / 60) + 'm ago';
    var dotColor = d.conf >= 80 ? '#0ea5e9' : d.conf >= 50 ? '#d97706' : '#dc2626';
    html += '<div class="detection-log-item">';
    html += '<span style="width:6px;height:6px;border-radius:9999px;flex-shrink:0;background:' + dotColor + '"></span>';
    html += '<div style="flex:1;min-width:0;"><p style="font-size:0.75rem;font-weight:500;color:var(--foreground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHtml(d.type) + '</p>';
    html += '<p style="font-size:10px;color:var(--muted-foreground)">' + agoStr + '</p></div>';
    html += '<span style="font-size:0.75rem;font-weight:600;color:var(--primary)">' + d.conf + '%</span>';
    html += '</div>';
  });
  container.innerHTML = html;
}

/* ---- Sparkline (shared) ---- */

function drawSparkline() {
  _drawSparklineOn('sparklineCanvas');
  _drawSparklineOn('dashSparkline');
}

function _drawSparklineOn(canvasId) {
  var canvas = document.getElementById(canvasId);
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  var w = canvas.offsetWidth;
  var h = canvas.offsetHeight;
  if (w === 0 || h === 0) return;
  canvas.width = w * 2;
  canvas.height = h * 2;
  ctx.scale(2, 2);
  ctx.clearRect(0, 0, w, h);

  if (sparkData.length < 2) return;
  var max = Math.max.apply(null, sparkData);
  var min = Math.min.apply(null, sparkData);
  var range = max - min || 1;

  ctx.beginPath();
  ctx.strokeStyle = '#0ea5e9';
  ctx.lineWidth = 1.5;
  for (var i = 0; i < sparkData.length; i++) {
    var x = (i / (sparkData.length - 1)) * w;
    var y = h - ((sparkData[i] - min) / range) * (h - 4) - 2;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function updateTrend() {
  var len = sparkData.length;
  if (len < 4) return;
  var diff = sparkData[len - 1] - sparkData[len - 4];
  var icon = document.getElementById('trendIcon');
  var text = document.getElementById('trendText');
  if (!icon || !text) return;
  var stable = Math.abs(diff) < 2;
  if (stable) {
    icon.innerHTML = '<line x1="5" y1="12" x2="19" y2="12"/>';
    text.textContent = 'Stable';
    text.style.color = 'var(--muted-foreground)';
  } else if (diff > 0) {
    icon.innerHTML = '<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>';
    text.textContent = 'Increasing';
    text.style.color = 'var(--destructive)';
  } else {
    icon.innerHTML = '<polyline points="22 17 13.5 8.5 8.5 13.5 2 7"/><polyline points="16 17 22 17 22 11"/>';
    text.textContent = 'Decreasing';
    text.style.color = 'var(--success)';
  }
}

function handleCapture() {
  var btn = document.getElementById('captureText');
  if (!btn) return;
  btn.textContent = 'Capturing…';
  var captureBtn = document.getElementById('captureBtn');
  if (captureBtn) captureBtn.style.opacity = '0.6';
  setTimeout(function () {
    btn.textContent = 'Capture';
    if (captureBtn) captureBtn.style.opacity = '';
  }, 1000);
}

function toggleThresholdModal() {
  var modal = document.getElementById('thresholdModal');
  if (!modal) return;
  modal.style.display = modal.style.display === 'none' ? '' : 'none';
}

function applyThreshold() {
  var slider = document.getElementById('thresholdSlider');
  if (slider) alertThreshold = parseInt(slider.value);
  toggleThresholdModal();
}

function dismissAlert() {
  var ab = document.getElementById('alertBanner');
  if (ab) ab.style.display = 'none';
}

/* ============ MAP PANEL – Leaflet (index only) ============ */

var leafletMap = null;
var mapMarkers = [];                // L.marker references
var mapZones = [];                  // { id, name, lat, lng, risk, level, ts }
var zoneIdCounter = 0;

var RISK_META = {
  low: { color: '#16a34a', label: 'Low', fill: 'rgba(22,163,74,0.25)' },
  moderate: { color: '#d97706', label: 'Moderate', fill: 'rgba(217,119,6,0.25)' },
  high: { color: '#ea580c', label: 'High', fill: 'rgba(234,88,12,0.25)' },
  critical: { color: '#dc2626', label: 'Critical', fill: 'rgba(220,38,38,0.25)' }
};

function riskFromLevel(level) {
  if (level < 30) return 'low';
  if (level < 55) return 'moderate';
  if (level < 75) return 'high';
  return 'critical';
}

function getLevelColor(level) {
  var r = riskFromLevel(level);
  return { ring: RISK_META[r].color, fill: RISK_META[r].fill, text: 'color:' + RISK_META[r].color };
}

function getBarColor(level) {
  return RISK_META[riskFromLevel(level)].color;
}

/* --- localStorage persistence --- */
function saveZones() {
  try { localStorage.setItem('mp_zones', JSON.stringify(mapZones)); } catch (e) { }
  if (typeof fbSaveZones === 'function') fbSaveZones(mapZones);
}
function loadZones() {
  try {
    var raw = localStorage.getItem('mp_zones');
    if (raw) {
      mapZones = JSON.parse(raw);
      zoneIdCounter = mapZones.reduce(function (mx, z) { return Math.max(mx, z.id); }, 0);
    }
  } catch (e) { }
}

/* --- Leaflet initialisation --- */
function initLeafletMap() {
  var container = document.getElementById('leafletMap');
  if (!container || typeof L === 'undefined') return;

  leafletMap = L.map('leafletMap', {
    center: [20, 0],
    zoom: 2,
    minZoom: 2,
    maxZoom: 18,
    zoomControl: true,
    attributionControl: false
  });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap'
  }).addTo(leafletMap);

  // Custom legend control
  var legend = L.control({ position: 'bottomleft' });
  legend.onAdd = function () {
    var div = L.DomUtil.create('div', 'leaflet-legend');
    var labels = ['Low', 'Moderate', 'High', 'Critical'];
    var colors = ['#16a34a', '#d97706', '#ea580c', '#dc2626'];
    var html = '';
    for (var i = 0; i < labels.length; i++) {
      html += '<div style="display:flex;align-items:center;gap:6px;"><span style="width:8px;height:8px;border-radius:50%;background:' + colors[i] + ';display:inline-block;"></span><span style="font-size:10px;color:#475569;">' + labels[i] + '</span></div>';
    }
    div.innerHTML = html;
    return div;
  };
  legend.addTo(leafletMap);

  // Re-render saved zones
  loadZones();
  mapZones.forEach(function (zone) { addMapMarker(zone); });
  updateAreaComparison();

  // Fit map to markers if any
  if (mapMarkers.length > 0) {
    var group = L.featureGroup(mapMarkers);
    leafletMap.fitBounds(group.getBounds().pad(0.3));
  }

  // Click on map to fill lat/lng
  leafletMap.on('click', function (e) {
    var latIn = document.getElementById('zfLat');
    var lngIn = document.getElementById('zfLng');
    if (latIn && lngIn) {
      latIn.value = e.latlng.lat.toFixed(6);
      lngIn.value = e.latlng.lng.toFixed(6);
    }
  });
}

/* --- Build a colored pin SVG icon for Leaflet markers --- */
function makePinIcon(color) {
  var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="40" viewBox="0 0 28 40">' +
    '<path d="M14 0C6.27 0 0 6.27 0 14c0 10.5 14 26 14 26s14-15.5 14-26C28 6.27 21.73 0 14 0z" fill="' + color + '" stroke="#fff" stroke-width="1.5"/>' +
    '<circle cx="14" cy="14" r="6" fill="#fff" opacity="0.9"/>' +
    '<circle cx="14" cy="14" r="3" fill="' + color + '"/>' +
    '</svg>';
  return L.divIcon({
    html: svg,
    className: '',
    iconSize: [28, 40],
    iconAnchor: [14, 40],
    popupAnchor: [0, -36]
  });
}

/* --- Add a pin marker + circle to the Leaflet map --- */
function addMapMarker(zone) {
  if (!leafletMap) return;
  var meta = RISK_META[zone.risk] || RISK_META.moderate;

  // Large geographic circle showing contaminated area (radius in meters, scaled by level)
  var areaRadius = Math.max(5000, zone.level * 800);  // 5km – 80km depending on level
  var areaCircle = L.circle([zone.lat, zone.lng], {
    radius: areaRadius,
    color: meta.color,
    fillColor: meta.color,
    fillOpacity: 0.18,
    weight: 1.5,
    dashArray: '6 4'
  }).addTo(leafletMap);
  areaCircle._zoneId = zone.id;

  // Pin marker at center
  var marker = L.marker([zone.lat, zone.lng], {
    icon: makePinIcon(meta.color)
  }).addTo(leafletMap);

  marker.bindPopup(
    '<div style="font-family:Inter,system-ui,sans-serif;min-width:160px;">' +
    '<p style="font-weight:700;font-size:13px;margin:0 0 4px;">' + zone.name + '</p>' +
    '<p style="font-size:11px;color:#64748b;margin:0;">Lat: ' + Number(zone.lat).toFixed(4) + ', Lng: ' + Number(zone.lng).toFixed(4) + '</p>' +
    '<p style="font-size:12px;font-weight:600;color:' + meta.color + ';margin:4px 0 0;">' + meta.label + ' — ' + zone.level + '% contamination</p>' +
    '<button onclick="removeZone(' + zone.id + ')" style="margin-top:6px;font-size:10px;padding:2px 8px;border:1px solid #e2e8f0;border-radius:4px;background:#fff;cursor:pointer;color:#dc2626;">Remove</button>' +
    '</div>'
  );

  marker._zoneId = zone.id;
  marker._areaCircle = areaCircle;
  mapMarkers.push(marker);
}

/* --- Remove zone --- */
function removeZone(id) {
  mapZones = mapZones.filter(function (z) { return z.id !== id; });
  saveZones();
  // Remove marker from map
  mapMarkers = mapMarkers.filter(function (m) {
    if (m._zoneId === id) {
      if (m._areaCircle) leafletMap.removeLayer(m._areaCircle);
      leafletMap.removeLayer(m);
      return false;
    }
    return true;
  });
  updateAreaComparison();
}

/* --- Clear all zones --- */
function clearAllZones() {
  mapZones = [];
  saveZones();
  mapMarkers.forEach(function (m) {
    if (m._areaCircle) leafletMap.removeLayer(m._areaCircle);
    leafletMap.removeLayer(m);
  });
  mapMarkers = [];
  updateAreaComparison();
}

/* --- Geolocation button --- */
function handleGeolocate() {
  var btn = document.getElementById('btnGeolocate');
  if (!navigator.geolocation) { alert('Geolocation not supported'); return; }
  if (btn) btn.classList.add('geo-loading');
  navigator.geolocation.getCurrentPosition(
    function (pos) {
      var latIn = document.getElementById('zfLat');
      var lngIn = document.getElementById('zfLng');
      if (latIn) latIn.value = pos.coords.latitude.toFixed(6);
      if (lngIn) lngIn.value = pos.coords.longitude.toFixed(6);
      if (leafletMap) leafletMap.setView([pos.coords.latitude, pos.coords.longitude], 12);
      if (btn) btn.classList.remove('geo-loading');
    },
    function (err) {
      alert('Location error: ' + err.message);
      if (btn) btn.classList.remove('geo-loading');
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

/* --- Zone form submission --- */
function handleZoneFormSubmit(e) {
  e.preventDefault();
  var name = document.getElementById('zfName').value.trim();
  var lat = parseFloat(document.getElementById('zfLat').value);
  var lng = parseFloat(document.getElementById('zfLng').value);
  var risk = document.getElementById('zfRisk').value;
  var level = parseInt(document.getElementById('zfPercent').value, 10);

  if (!name || isNaN(lat) || isNaN(lng) || !risk || isNaN(level)) return;
  if (level < 0) level = 0;
  if (level > 100) level = 100;

  zoneIdCounter++;
  var zone = { id: zoneIdCounter, name: name, lat: lat, lng: lng, risk: risk, level: level, ts: Date.now() };
  mapZones.push(zone);
  saveZones();
  addMapMarker(zone);

  // Pan map to new marker
  if (leafletMap) leafletMap.setView([lat, lng], Math.max(leafletMap.getZoom(), 6));

  updateAreaComparison();

  // Reset form
  e.target.reset();
}

/* ============ AREA COMPARISON – dynamic (index only) ============ */

function updateAreaComparison() {
  var count = mapZones.length;

  // Zone count badges
  var mapCountEl = document.getElementById('mapZoneCount');
  var activeEl = document.getElementById('activeZoneCount');
  if (mapCountEl) mapCountEl.textContent = count + ' zone' + (count !== 1 ? 's' : '');
  if (activeEl) activeEl.textContent = count;

  // Critical count
  var criticals = mapZones.filter(function (z) { return z.risk === 'critical'; }).length;
  var ccEl = document.getElementById('criticalCount');
  var czEl = document.getElementById('criticalZones');
  if (ccEl) ccEl.textContent = criticals;
  if (czEl) czEl.textContent = criticals;

  // Highest risk zone
  var hrName = document.getElementById('highestRiskName');
  var hrVal = document.getElementById('highestRiskValue');
  if (count === 0) {
    if (hrName) hrName.textContent = '—';
    if (hrVal) hrVal.textContent = '0%';
  } else {
    var sorted = mapZones.slice().sort(function (a, b) { return b.level - a.level; });
    if (hrName) hrName.textContent = sorted[0].name;
    if (hrVal) hrVal.textContent = sorted[0].level + '%';
  }

  // Average
  var avgEl = document.getElementById('avgLevel');
  if (count === 0) {
    if (avgEl) avgEl.textContent = '0%';
  } else {
    var sum = mapZones.reduce(function (s, z) { return s + z.level; }, 0);
    if (avgEl) avgEl.textContent = Math.round(sum / count) + '%';
  }

  // Clear button visibility
  var clearBtn = document.getElementById('btnClearZones');
  if (clearBtn) clearBtn.style.display = count > 0 ? '' : 'none';

  renderAreaBarChart();
  renderZoneTrendList();
}

function renderAreaBarChart() {
  var canvas = document.getElementById('areaBarChart');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  var dpr = window.devicePixelRatio || 1;
  var w = 300;
  var h = 120;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = '100%';
  canvas.style.height = h + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  if (mapZones.length === 0) {
    ctx.fillStyle = '#94a3b8';
    ctx.font = '11px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No data — add zones on the map', w / 2, h / 2);
    return;
  }

  var displayZones = mapZones.slice().sort(function (a, b) { return b.level - a.level; }).slice(0, 8);
  var barW = w / displayZones.length;
  var padding = barW * 0.25;

  displayZones.forEach(function (z, i) {
    var barH = (z.level / 100) * (h - 28);
    var x = i * barW + padding / 2;
    var y = h - barH - 18;
    ctx.fillStyle = getBarColor(z.level);
    ctx.beginPath();
    var r = 3;
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + barW - padding - r, y);
    ctx.quadraticCurveTo(x + barW - padding, y, x + barW - padding, y + r);
    ctx.lineTo(x + barW - padding, h - 18);
    ctx.lineTo(x, h - 18);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.fill();

    // Value on top
    ctx.fillStyle = getBarColor(z.level);
    ctx.font = 'bold 9px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(z.level + '%', x + (barW - padding) / 2, y - 3);

    // Label below
    ctx.fillStyle = '#475569';
    ctx.font = '8px Inter, system-ui, sans-serif';
    var shortName = z.name.length > 10 ? z.name.substring(0, 9) + '…' : z.name;
    ctx.fillText(shortName, x + (barW - padding) / 2, h - 4);
  });
}

function renderZoneTrendList() {
  var container = document.getElementById('zoneTrendList');
  if (!container) return;
  if (mapZones.length === 0) {
    container.innerHTML = '<p style="font-size:10px;color:var(--muted-foreground);text-align:center;padding:1rem 0;">No zones added yet. Use the form to add contamination zones.</p>';
    return;
  }

  var html = '';
  var sorted = mapZones.slice().sort(function (a, b) { return b.level - a.level; });
  sorted.forEach(function (zone) {
    var meta = RISK_META[zone.risk] || RISK_META.moderate;
    html += '<div class="zone-list-item" onclick="flyToZone(' + zone.id + ')">';
    html += '<span style="width:6px;height:6px;border-radius:9999px;flex-shrink:0;background:' + meta.color + '"></span>';
    html += '<span class="zone-list-name">' + zone.name + '</span>';
    html += '<span style="font-size:9px;padding:1px 5px;border-radius:4px;background:' + meta.fill + ';color:' + meta.color + ';font-weight:600;">' + meta.label + '</span>';
    html += '<span style="font-size:10px;font-weight:600;color:var(--foreground);min-width:28px;text-align:right;">' + zone.level + '%</span>';
    html += '<button class="zone-remove-btn" onclick="event.stopPropagation();removeZone(' + zone.id + ')" title="Remove">&times;</button>';
    html += '</div>';
  });
  container.innerHTML = html;
}

function flyToZone(id) {
  var zone = mapZones.find(function (z) { return z.id === id; });
  if (zone && leafletMap) {
    leafletMap.setView([zone.lat, zone.lng], 10);
    // Open popup
    mapMarkers.forEach(function (m) {
      if (m._zoneId === id) m.openPopup();
    });
  }
}

/* ============ DASHBOARD INIT ============ */

function initDashboard() {
  // DateTime
  var dtEl = document.getElementById('datetimeText');
  if (dtEl) {
    var now = new Date();
    var timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    var dateStr = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    dtEl.textContent = timeStr + ' · ' + dateStr;
  }

  // Threshold slider
  var slider = document.getElementById('thresholdSlider');
  var display = document.getElementById('thresholdDisplay');
  if (slider && display) {
    slider.addEventListener('input', function () {
      display.textContent = slider.value + '%';
    });
  }

  // Init Leaflet map
  initLeafletMap();

  // Zone form
  var zoneForm = document.getElementById('zoneForm');
  if (zoneForm) zoneForm.addEventListener('submit', handleZoneFormSubmit);

  // Geolocation button
  var geoBtn = document.getElementById('btnGeolocate');
  if (geoBtn) geoBtn.addEventListener('click', handleGeolocate);

  // Clear all button
  var clearBtn = document.getElementById('btnClearZones');
  if (clearBtn) clearBtn.addEventListener('click', clearAllZones);
}

/* ============ LIVE DETECTION PAGE INIT ============ */

function initLiveDetection() {
  // Threshold slider
  var slider = document.getElementById('thresholdSlider');
  var display = document.getElementById('thresholdDisplay');
  if (slider && display) {
    slider.addEventListener('input', function () {
      display.textContent = slider.value + '%';
    });
  }

  // Fetch real model info from backend and populate sidebar
  fetchModelInfo();
}

function fetchModelInfo() {
  fetch(BACKEND_URL + '/model-info')
    .then(function (res) { return res.json(); })
    .then(function (data) {
      // Update Model Details sidebar with real values using specific IDs
      var classesEl = document.getElementById('sidebarClasses');
      var infEl = document.getElementById('sidebarInference');
      var upEl = document.getElementById('sidebarUpdate');

      var classNames = data.classes || data.class_names || {};
      var numClasses = Object.keys(classNames).length;
      var classList = Object.values(classNames).join(', ');

      if (classesEl) classesEl.textContent = numClasses + ' (' + classList + ')';
      if (infEl) infEl.textContent = 'Real-time — ~' + (data.avg_inference_ms || 35) + 'ms/frame';
      if (upEl) upEl.textContent = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

      // Also update dashboard cam details
      var dashModel = document.getElementById('dashModelInfo');
      if (dashModel) dashModel.textContent = 'YOLOv8 (' + classList + ')';
    })
    .catch(function (err) {
      console.warn('Could not fetch model info:', err);
    });
}

/* ============ UPLOAD PAGE ============ */

var uploadFile = null;
var uploadResult = null;

function initUpload() {
  var dropzone = document.getElementById('dropzone');
  if (dropzone) {
    dropzone.addEventListener('dragover', function (e) {
      e.preventDefault();
      dropzone.classList.add('dragging');
    });
    dropzone.addEventListener('dragleave', function () {
      dropzone.classList.remove('dragging');
    });
    dropzone.addEventListener('drop', function (e) {
      e.preventDefault();
      dropzone.classList.remove('dragging');
      var f = e.dataTransfer.files[0];
      if (f) processUploadFile(f);
    });
  }
}

function handleFileSelect(event) {
  var f = event.target.files[0];
  if (f) processUploadFile(f);
}

function processUploadFile(f) {
  if (!f.type.startsWith('image/')) return;
  uploadFile = f;
  uploadResult = null;
  var reader = new FileReader();
  reader.onload = function (e) {
    document.getElementById('dropzone').style.display = 'none';
    document.getElementById('previewCard').style.display = '';
    document.getElementById('previewImg').src = e.target.result;
    document.getElementById('fileName').textContent = f.name;
    document.getElementById('previewOverlay').style.display = '';
    document.getElementById('analyzeBtn').style.display = '';
    document.getElementById('analyzeProgress').style.display = 'none';
    document.getElementById('uploadDetectionBoxes').innerHTML = '';
    document.getElementById('noResultsCard').style.display = '';
    document.getElementById('resultsCard').style.display = 'none';
  };
  reader.readAsDataURL(f);
}

function clearUpload() {
  uploadFile = null;
  uploadResult = null;
  document.getElementById('dropzone').style.display = '';
  document.getElementById('previewCard').style.display = 'none';
  document.getElementById('noResultsCard').style.display = '';
  document.getElementById('resultsCard').style.display = 'none';
  document.getElementById('fileInput').value = '';
}


function runAnalysis() {
  if (!uploadFile) return;
  document.getElementById('analyzeBtn').style.display = 'none';
  document.getElementById('analyzeProgress').style.display = '';
  document.getElementById('previewOverlay').style.display = 'none';
  var progress = 0;
  var fillEl = document.getElementById('progressFill');
  var pctEl = document.getElementById('progressPercent');
  var progressInterval = setInterval(function () {
    progress += Math.random() * 8;
    if (progress > 85) { progress = 85; }
    fillEl.style.width = progress + '%';
    pctEl.textContent = Math.round(progress) + '%';
  }, 200);

  // Read file as base64 and send to backend
  var reader = new FileReader();
  reader.onload = function (e) {
    var dataUrl = e.target.result;
    var b64 = dataUrl.split(',')[1];
    fetch(BACKEND_URL + '/detect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: b64 })
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        clearInterval(progressInterval);
        fillEl.style.width = '100%';
        pctEl.textContent = '100%';
        var dets = data.detections || [];
        var numP = dets.length;
        var avgConf = 0;
        if (numP > 0) {
          var sum = 0;
          for (var i = 0; i < dets.length; i++) sum += dets[i].confidence;
          avgConf = (sum / numP) * 100;
        }
        uploadResult = {
          contamination: Math.min(100, numP * 8),
          confidence: avgConf,
          particleCount: numP,
          particles: dets.map(function (d) {
            return {
              type: d.class_name,
              confidence: d.confidence,
              x: d.x1 * 100,
              y: d.y1 * 100,
              w: (d.x2 - d.x1) * 100,
              h: (d.y2 - d.y1) * 100
            };
          })
        };
        showUploadResults();
      })
      .catch(function (err) {
        clearInterval(progressInterval);
        fillEl.style.width = '100%';
        pctEl.textContent = 'Error';
        console.error('Upload analysis error:', err);
        alert('Analysis failed: ' + err.message);
        document.getElementById('analyzeBtn').style.display = 'block';
        document.getElementById('analyzeProgress').style.display = 'none';
      });
  };
  reader.readAsDataURL(uploadFile);
}

function showUploadResults() {
  document.getElementById('analyzeProgress').style.display = 'none';
  document.getElementById('noResultsCard').style.display = 'none';
  document.getElementById('resultsCard').style.display = '';

  var r = uploadResult;
  document.getElementById('resultContamination').textContent = r.contamination.toFixed(1) + '%';
  document.getElementById('resultConfidence').textContent = r.confidence.toFixed(1) + '%';
  document.getElementById('resultParticles').textContent = r.particleCount;

  // Badge
  var sev = getSeverity(r.contamination);
  document.getElementById('resultBadge').className = sev.cls;
  document.getElementById('resultBadgeText').textContent = sev.label;

  // Particle list
  var listHtml = '';
  r.particles.forEach(function (p) {
    listHtml += '<div style="display:flex;align-items:center;gap:0.5rem;padding:0.5rem;border-radius:var(--radius);font-size:0.75rem;border:1px solid var(--border);background:var(--secondary);">';
    listHtml += '<span style="width:6px;height:6px;border-radius:9999px;background:var(--primary);flex-shrink:0;"></span>';
    listHtml += '<span style="flex:1;color:var(--foreground);">' + p.type + '</span>';
    listHtml += '<span style="font-weight:600;color:var(--primary);">' + (p.confidence * 100).toFixed(0) + '%</span>';
    listHtml += '</div>';
  });
  document.getElementById('particleList').innerHTML = listHtml;

  // Detection boxes on image
  var boxHtml = '';
  r.particles.forEach(function (p) {
    boxHtml += '<div class="detection-box" style="left:' + p.x + '%;top:' + p.y + '%;width:' + p.w + '%;height:' + p.h + '%;">';
    boxHtml += '<div style="position:absolute;top:-20px;left:0;font-size:9px;font-weight:500;padding:1px 4px;border-radius:4px;white-space:nowrap;background:rgba(14,165,233,0.12);color:#0284c7;">';
    boxHtml += p.type + ' ' + (p.confidence * 100).toFixed(0) + '%</div></div>';
  });
  document.getElementById('uploadDetectionBoxes').innerHTML = boxHtml;
}

/* ============ ANALYTICS PAGE ============ */

var _chartMonthly = null, _chartPie = null, _chartZone = null, _chartParticle = null;

function initAnalytics() {
  var sessions = getStoredSessions();
  var zones = getStoredZones();
  var hasData = sessions.length > 0 || zones.length > 0;

  // Show / hide no-data banner
  var banner = document.getElementById('noDataBanner');
  if (banner) banner.style.display = hasData ? 'none' : '';

  // --- KPI values ---
  var avgContam = 0, totalDet = 0, peakContam = 0;
  if (sessions.length) {
    var sumContam = 0;
    sessions.forEach(function (s) {
      sumContam += (s.avgContamination || 0);
      totalDet += (s.totalDetections || 0);
      if ((s.peakContamination || 0) > peakContam) peakContam = s.peakContamination;
    });
    avgContam = sumContam / sessions.length;
  }
  var el;
  el = document.getElementById('kpiAvgContam'); if (el) el.textContent = avgContam.toFixed(1) + '%';
  el = document.getElementById('kpiTotalDet'); if (el) el.textContent = totalDet;
  el = document.getElementById('kpiPeakContam'); if (el) el.textContent = peakContam.toFixed(1) + '%';
  el = document.getElementById('kpiZones'); if (el) el.textContent = zones.length;

  // --- KPI sub-labels ---
  el = document.getElementById('kpiAvgSub');
  if (el) el.textContent = sessions.length ? 'across ' + sessions.length + ' session' + (sessions.length > 1 ? 's' : '') : 'no sessions yet';
  el = document.getElementById('kpiTotalSub');
  if (el) el.textContent = sessions.length ? sessions.length + ' session' + (sessions.length > 1 ? 's' : '') + ' recorded' : 'no sessions yet';
  el = document.getElementById('kpiPeakSub');
  if (el) el.textContent = peakContam > 0 ? 'highest single session' : 'no sessions yet';
  el = document.getElementById('kpiZonesSub');
  if (el) el.textContent = zones.length ? zones.length + ' zone' + (zones.length > 1 ? 's' : '') + ' tracked' : 'no zones yet';

  // ---------- Chart defaults ----------
  var chartDefaults = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#fff',
        titleColor: '#0f172a',
        bodyColor: '#475569',
        borderColor: '#e2e8f0',
        borderWidth: 1,
        cornerRadius: 8,
        titleFont: { weight: '600', size: 11 },
        bodyFont: { size: 11 },
        padding: 8
      }
    },
    scales: {
      x: {
        grid: { display: false },
        ticks: { font: { size: 10, family: 'Inter' }, color: '#475569' },
        border: { display: false }
      },
      y: {
        grid: { color: '#e2e8f0', drawBorder: false },
        ticks: { font: { size: 10, family: 'Inter' }, color: '#475569' },
        border: { display: false }
      }
    }
  };

  // ===== Chart 1 — Session Contamination Trend (line / area) =====
  var trendLabels = [], trendData = [];
  sessions.forEach(function (s) {
    var d = new Date(s.timestamp);
    trendLabels.push(d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }));
    trendData.push(parseFloat((s.avgContamination || 0).toFixed(1)));
  });
  if (!trendLabels.length) { trendLabels = ['—']; trendData = [0]; }

  if (_chartMonthly) { _chartMonthly.destroy(); _chartMonthly = null; }
  _chartMonthly = new Chart(document.getElementById('monthlyTrendChart'), {
    type: 'line',
    data: {
      labels: trendLabels,
      datasets: [{
        data: trendData,
        borderColor: '#0ea5e9',
        backgroundColor: 'rgba(14,165,233,0.1)',
        borderWidth: 2,
        fill: true,
        tension: 0.4,
        pointRadius: 3,
        pointBackgroundColor: '#0ea5e9',
        pointBorderWidth: 0
      }]
    },
    options: Object.assign({}, chartDefaults, {
      scales: Object.assign({}, chartDefaults.scales, {
        y: Object.assign({}, chartDefaults.scales.y, {
          beginAtZero: true,
          ticks: Object.assign({}, chartDefaults.scales.y.ticks, {
            callback: function (v) { return v + '%'; }
          })
        })
      })
    })
  });

  // ===== Chart 2 — Zone Risk Distribution (doughnut) =====
  var riskColors = { critical: '#dc2626', high: '#ea580c', moderate: '#d97706', low: '#16a34a' };
  var riskCounts = { critical: 0, high: 0, moderate: 0, low: 0 };
  zones.forEach(function (z) {
    var r = (z.risk || 'low').toLowerCase();
    if (riskCounts.hasOwnProperty(r)) riskCounts[r]++;
  });
  var pieLabels = [], pieData = [], pieColors = [];
  ['critical', 'high', 'moderate', 'low'].forEach(function (k) {
    if (riskCounts[k] > 0) {
      pieLabels.push(k.charAt(0).toUpperCase() + k.slice(1));
      pieData.push(riskCounts[k]);
      pieColors.push(riskColors[k]);
    }
  });
  if (!pieLabels.length) { pieLabels = ['No Zones']; pieData = [1]; pieColors = ['#94a3b8']; }

  if (_chartPie) { _chartPie.destroy(); _chartPie = null; }
  _chartPie = new Chart(document.getElementById('pieChart'), {
    type: 'doughnut',
    data: {
      labels: pieLabels,
      datasets: [{
        data: pieData,
        backgroundColor: pieColors,
        borderWidth: 0,
        spacing: 3
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '60%',
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#fff',
          titleColor: '#0f172a',
          bodyColor: '#475569',
          borderColor: '#e2e8f0',
          borderWidth: 1,
          cornerRadius: 8,
          callbacks: {
            label: function (ctx) { return ctx.label + ': ' + ctx.raw + ' zone' + (ctx.raw > 1 ? 's' : ''); }
          }
        }
      }
    }
  });

  // Pie Legend
  var legendHtml = '';
  for (var li = 0; li < pieLabels.length; li++) {
    legendHtml += '<div style="display:flex;align-items:center;gap:0.5rem;font-size:10px;">';
    legendHtml += '<span style="width:8px;height:8px;border-radius:9999px;flex-shrink:0;background:' + pieColors[li] + '"></span>';
    legendHtml += '<span style="color:var(--muted-foreground);flex:1;">' + pieLabels[li] + '</span>';
    legendHtml += '<span style="font-weight:500;color:var(--foreground)">' + pieData[li] + '</span>';
    legendHtml += '</div>';
  }
  document.getElementById('pieLegend').innerHTML = legendHtml;

  // ===== Chart 3 — Zone Contamination Levels (bar) =====
  var zoneBarLabels = [], zoneBarData = [], zoneBarColors = [];
  zones.forEach(function (z) {
    zoneBarLabels.push(z.name || 'Zone');
    zoneBarData.push(z.level || 0);
    var r = (z.risk || 'low').toLowerCase();
    zoneBarColors.push(riskColors[r] || '#16a34a');
  });
  if (!zoneBarLabels.length) { zoneBarLabels = ['—']; zoneBarData = [0]; zoneBarColors = ['#94a3b8']; }

  if (_chartZone) { _chartZone.destroy(); _chartZone = null; }
  _chartZone = new Chart(document.getElementById('zoneChart'), {
    type: 'bar',
    data: {
      labels: zoneBarLabels,
      datasets: [{
        data: zoneBarData,
        backgroundColor: zoneBarColors.map(function (c) { return c + 'cc'; }),
        borderRadius: 4,
        borderSkipped: false
      }]
    },
    options: Object.assign({}, chartDefaults, {
      indexAxis: 'y',
      scales: {
        x: Object.assign({}, chartDefaults.scales.x, {
          beginAtZero: true,
          ticks: Object.assign({}, chartDefaults.scales.x.ticks, {
            callback: function (v) { return v + '%'; }
          })
        }),
        y: Object.assign({}, chartDefaults.scales.y, {
          grid: { display: false }
        })
      }
    })
  });

  // ===== Chart 4 — Detections Per Session (bar) =====
  var sessBarLabels = [], sessBarData = [];
  sessions.forEach(function (s) {
    var d = new Date(s.timestamp);
    sessBarLabels.push(d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
    sessBarData.push(s.totalDetections || 0);
  });
  if (!sessBarLabels.length) { sessBarLabels = ['—']; sessBarData = [0]; }

  if (_chartParticle) { _chartParticle.destroy(); _chartParticle = null; }
  _chartParticle = new Chart(document.getElementById('particleBarChart'), {
    type: 'bar',
    data: {
      labels: sessBarLabels,
      datasets: [{
        data: sessBarData,
        backgroundColor: 'rgba(14,165,233,0.75)',
        borderRadius: 4,
        borderSkipped: false
      }]
    },
    options: Object.assign({}, chartDefaults, {
      scales: Object.assign({}, chartDefaults.scales, {
        y: Object.assign({}, chartDefaults.scales.y, {
          beginAtZero: true,
          grid: Object.assign({}, chartDefaults.scales.y.grid, { drawBorder: false })
        })
      })
    })
  });
}

/* ============ REPORTS PAGE ============ */

function initReports() {
  var sessions = getStoredSessions();
  var zones = getStoredZones();
  var hasData = sessions.length > 0 || zones.length > 0;
  var lastSession = sessions.length ? sessions[sessions.length - 1] : null;

  // --- Report header metadata ---
  var el;
  el = document.getElementById('reportDate');
  if (el) {
    if (lastSession) {
      var d = new Date(lastSession.timestamp);
      el.textContent = d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) + ' · ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) + ' UTC';
    } else {
      el.textContent = 'No sessions recorded';
    }
  }

  el = document.getElementById('reportLocation');
  if (el) {
    if (zones.length) {
      // Show highest-risk zone
      var riskOrder = { critical: 4, high: 3, moderate: 2, low: 1 };
      var topZone = zones.reduce(function (best, z) {
        var score = riskOrder[(z.risk || 'low').toLowerCase()] || 0;
        var bestScore = riskOrder[(best.risk || 'low').toLowerCase()] || 0;
        return score > bestScore ? z : best;
      }, zones[0]);
      el.textContent = topZone.name + ' — ' + parseFloat(topZone.lat).toFixed(4) + '°, ' + parseFloat(topZone.lng).toFixed(4) + '°';
    } else {
      el.textContent = 'No zones recorded';
    }
  }

  el = document.getElementById('reportDuration');
  if (el) {
    if (lastSession) {
      var dur = lastSession.durationSec || 0;
      var mm = Math.floor(dur / 60);
      var ss = Math.round(dur % 60);
      var dStr = mm > 0 ? mm + 'm ' + ss + 's' : ss + 's';
      var dDate = new Date(lastSession.timestamp);
      el.textContent = dStr + ' · ' + dDate.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
    } else {
      el.textContent = '—';
    }
  }

  el = document.getElementById('reportOperator');
  if (el) el.textContent = 'System · Auto-generated';

  // --- Primary Detection Results ---
  el = document.getElementById('reportContamLevel');
  if (el) el.textContent = lastSession ? (lastSession.avgContamination || 0).toFixed(1) + '%' : '—';

  var contamPct = lastSession ? (lastSession.avgContamination || 0) : 0;
  var sevLabel, sevCls;
  if (contamPct >= 60) { sevLabel = 'Critical'; sevCls = 'badge-critical'; }
  else if (contamPct >= 40) { sevLabel = 'High'; sevCls = 'badge-high'; }
  else if (contamPct >= 20) { sevLabel = 'Moderate'; sevCls = 'badge-moderate'; }
  else { sevLabel = 'Low'; sevCls = 'badge-low'; }
  el = document.getElementById('reportContamBadge');
  if (el) el.className = lastSession ? sevCls : 'badge-low';
  el = document.getElementById('reportContamLabel');
  if (el) el.textContent = lastSession ? sevLabel : '—';

  el = document.getElementById('reportConfidence');
  if (el) el.textContent = lastSession ? (lastSession.avgConfidence || 0).toFixed(1) + '%' : '—';
  el = document.getElementById('reportParticles');
  if (el) el.textContent = lastSession ? (lastSession.totalDetections || 0) : '—';

  // --- Helper functions ---
  function getSevColor(s) {
    if (s === 'Critical' || s === 'critical') return '#dc2626';
    if (s === 'High' || s === 'high') return '#ea580c';
    if (s === 'Moderate' || s === 'moderate') return '#d97706';
    return '#16a34a';
  }
  function getBarBg(level) {
    if (level >= 75) return '#dc2626';
    if (level >= 55) return '#ea580c';
    if (level >= 35) return '#d97706';
    return '#16a34a';
  }
  function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }

  // --- Zone Analysis ---
  var zaHtml = '';
  if (zones.length) {
    zones.forEach(function (zone) {
      var level = zone.level || 0;
      var status = capitalize(zone.risk || 'low');
      zaHtml += '<div class="zone-bar-row">';
      zaHtml += '<span style="font-size:0.75rem;color:var(--foreground);flex:1;">' + (zone.name || 'Zone') + '</span>';
      zaHtml += '<div class="zone-bar-track"><div class="zone-bar-fill" style="width:' + level + '%;background:' + getBarBg(level) + ';"></div></div>';
      zaHtml += '<span style="font-size:0.75rem;font-weight:600;color:var(--foreground);width:2rem;text-align:right;">' + level + '%</span>';
      zaHtml += '<span style="font-size:0.75rem;font-weight:500;width:4rem;text-align:right;color:' + getSevColor(status) + ';">' + status + '</span>';
      zaHtml += '</div>';
    });
  } else {
    zaHtml = '<p style="font-size:0.8rem;color:var(--muted-foreground);text-align:center;padding:1rem;">No zones added yet. Add contamination zones on the Dashboard map.</p>';
  }
  document.getElementById('zoneAnalysis').innerHTML = zaHtml;

  // --- Session Breakdown (replaces Particle Morphology) ---
  var pbHtml = '';
  if (sessions.length) {
    sessions.slice(-5).forEach(function (s) {
      var dDate = new Date(s.timestamp);
      var label = dDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + dDate.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      pbHtml += '<div style="border-radius:1rem;padding:0.75rem;text-align:center;border:1px solid var(--border);background:var(--secondary);">';
      pbHtml += '<p style="font-size:1.125rem;font-weight:700;color:var(--primary)">' + (s.totalDetections || 0) + '</p>';
      pbHtml += '<p class="metric-label" style="margin-top:0.125rem;line-height:1.25;">' + label + '</p>';
      pbHtml += '<p style="font-size:10px;color:var(--muted-foreground);margin-top:0.25rem;">' + (s.avgContamination || 0).toFixed(1) + '% contam.</p>';
      pbHtml += '</div>';
    });
  } else {
    pbHtml = '<p style="font-size:0.8rem;color:var(--muted-foreground);text-align:center;padding:1rem;grid-column:1/-1;">No detection sessions yet. Run a live detection to generate data.</p>';
  }
  document.getElementById('particleBreakdown').innerHTML = pbHtml;

  // --- Executive Summary ---
  el = document.getElementById('reportSummary');
  if (el) {
    if (hasData) {
      var totalDetAll = 0, totalSessions = sessions.length;
      sessions.forEach(function (s) { totalDetAll += (s.totalDetections || 0); });
      var critZones = zones.filter(function (z) { return (z.risk || '').toLowerCase() === 'critical'; }).length;
      var highZones = zones.filter(function (z) { return (z.risk || '').toLowerCase() === 'high'; }).length;
      var summary = '';
      if (totalSessions > 0) {
        summary += 'Analysis of ' + totalSessions + ' detection session' + (totalSessions > 1 ? 's' : '') + ' reveals a total of ' + totalDetAll + ' microplastic detection' + (totalDetAll !== 1 ? 's' : '') + '. ';
        summary += 'Average contamination across sessions is ' + (totalDetAll > 0 ? (sessions.reduce(function (a, s) { return a + (s.avgContamination || 0); }, 0) / totalSessions).toFixed(1) : '0') + '%, ';
        summary += 'with a peak contamination of ' + (sessions.reduce(function (mx, s) { return Math.max(mx, s.peakContamination || 0); }, 0)).toFixed(1) + '%. ';
      }
      if (zones.length > 0) {
        summary += zones.length + ' monitoring zone' + (zones.length > 1 ? 's are' : ' is') + ' currently tracked. ';
        if (critZones > 0) summary += critZones + ' zone' + (critZones > 1 ? 's' : '') + ' at critical level require' + (critZones === 1 ? 's' : '') + ' immediate attention. ';
        if (highZones > 0) summary += highZones + ' zone' + (highZones > 1 ? 's' : '') + ' at high contamination. ';
      }
      summary += 'Continued monitoring is recommended to track trends and validate mitigation efforts.';
      el.textContent = summary;
    } else {
      el.textContent = 'No detection data available. Run a live detection session or add contamination zones on the dashboard map to generate a real report.';
    }
  }

}

function handleExport() {
  var btn = document.getElementById('exportBtn');
  var text = document.getElementById('exportText');
  btn.classList.add('disabled');
  btn.disabled = true;
  text.innerHTML = '<span style="display:flex;align-items:center;gap:0.5rem;"><span style="width:12px;height:12px;border-radius:9999px;border:2px solid rgba(255,255,255,0.3);border-top-color:white;animation:spin 1s linear infinite;display:inline-block;"></span>Generating…</span>';

  var reportDoc = document.querySelector('.report-document');
  if (!reportDoc) {
    btn.classList.remove('disabled');
    btn.disabled = false;
    text.innerHTML = '<svg class="icon icon-md" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Export PDF';
    alert('Report content not found.');
    return;
  }

  // Temporarily make sure report is visible for capture
  var origBg = reportDoc.style.background;
  reportDoc.style.background = '#fff';

  html2canvas(reportDoc, {
    scale: 2,
    useCORS: true,
    backgroundColor: '#ffffff',
    logging: false
  }).then(function (canvas) {
    reportDoc.style.background = origBg;
    var imgData = canvas.toDataURL('image/png');
    var jsPDF = window.jspdf.jsPDF;
    var pdf = new jsPDF('p', 'mm', 'a4');
    var pdfW = pdf.internal.pageSize.getWidth();
    var pdfH = pdf.internal.pageSize.getHeight();
    var imgW = pdfW - 20; // 10mm margins
    var imgH = (canvas.height * imgW) / canvas.width;
    var yPos = 10;

    // If the image is taller than one page, split across pages
    if (imgH <= pdfH - 20) {
      pdf.addImage(imgData, 'PNG', 10, yPos, imgW, imgH);
    } else {
      // Multi-page: use canvas slicing
      var pageCanvas = document.createElement('canvas');
      var pageCtx = pageCanvas.getContext('2d');
      var srcPageH = Math.floor(canvas.width * ((pdfH - 20) / imgW));
      pageCanvas.width = canvas.width;
      var remaining = canvas.height;
      var srcY = 0;
      var pageNum = 0;
      while (remaining > 0) {
        if (pageNum > 0) pdf.addPage();
        var sliceH = Math.min(srcPageH, remaining);
        pageCanvas.height = sliceH;
        pageCtx.clearRect(0, 0, pageCanvas.width, sliceH);
        pageCtx.drawImage(canvas, 0, srcY, canvas.width, sliceH, 0, 0, canvas.width, sliceH);
        var sliceData = pageCanvas.toDataURL('image/png');
        var sliceImgH = (sliceH * imgW) / canvas.width;
        pdf.addImage(sliceData, 'PNG', 10, 10, imgW, sliceImgH);
        srcY += sliceH;
        remaining -= sliceH;
        pageNum++;
      }
    }

    // Generate filename with date
    var now = new Date();
    var fname = 'MicroPlasticAI-Report-' + now.getFullYear() + ('0' + (now.getMonth() + 1)).slice(-2) + ('0' + now.getDate()).slice(-2) + '.pdf';
    pdf.save(fname);

    btn.classList.remove('disabled');
    btn.disabled = false;
    text.innerHTML = '<svg class="icon icon-md" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Export PDF';
    var banner = document.getElementById('generatedBanner');
    if (banner) banner.style.display = '';
  }).catch(function (err) {
    reportDoc.style.background = origBg;
    console.error('PDF generation error:', err);
    btn.classList.remove('disabled');
    btn.disabled = false;
    text.innerHTML = '<svg class="icon icon-md" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Export PDF';
    alert('PDF generation failed: ' + err.message);
  });
}

function handlePrint() {
  var reportDoc = document.querySelector('.report-document');
  if (!reportDoc) { alert('No report content to print.'); return; }

  // Open a new window with just the report content for clean printing
  var printWin = window.open('', '_blank', 'width=900,height=700');
  printWin.document.write('<!DOCTYPE html><html><head><title>MicroPlastic AI Report</title>');
  printWin.document.write('<link rel="stylesheet" href="styles.css">');
  printWin.document.write('<style>body{background:#fff;padding:2rem;} .report-document{box-shadow:none;border:none;} @media print{body{padding:0;margin:0;}}</style>');
  printWin.document.write('</head><body>');
  printWin.document.write(reportDoc.outerHTML);
  printWin.document.write('</body></html>');
  printWin.document.close();

  // Wait for styles to load before printing
  printWin.onload = function () {
    printWin.focus();
    printWin.print();
  };
}

/* ============ SPA ROUTING ============ */

var _dashboardInited = false;
var _liveInited = false;
var _uploadInited = false;

function navigateTo(view) {
  var views = ['dashboard', 'live', 'upload', 'analytics', 'reports'];
  if (views.indexOf(view) === -1) view = 'dashboard';

  // Hide all views — but keep live view in DOM when camera is running
  views.forEach(function (v) {
    var el = document.getElementById('view-' + v);
    if (!el) return;
    el.classList.remove('active');
    // If camera is running, keep live view rendered off-screen instead of display:none
    if (v === 'live' && cameraRunning) {
      el.classList.add('cam-keep');
    } else {
      el.classList.remove('cam-keep');
    }
  });

  // Show target view
  var target = document.getElementById('view-' + view);
  if (target) {
    target.classList.add('active');
    // If this is the live view, remove the offscreen class
    if (view === 'live') target.classList.remove('cam-keep');
    // Page enter animation
    target.classList.remove('page-enter');
    void target.offsetWidth;
    target.classList.add('page-enter');
  }

  // Update nav active state
  document.querySelectorAll('.nav-link').forEach(function (link) {
    link.classList.toggle('active', link.getAttribute('data-view') === view);
  });

  // Update hash without triggering hashchange
  if (window.location.hash.slice(1) !== view) {
    history.replaceState(null, '', '#' + view);
  }

  // Update title
  var titles = { dashboard: 'Dashboard', live: 'Live Detection', upload: 'Upload', analytics: 'Analytics', reports: 'Reports' };
  document.title = 'MicroPlastic AI \u2013 ' + (titles[view] || 'Dashboard');

  // Lazy-init views (dashboard, live, upload init once)
  if (view === 'dashboard' && !_dashboardInited) {
    _dashboardInited = true;
    initDashboard();
  }
  if (view === 'live' && !_liveInited) {
    _liveInited = true;
    initLiveDetection();
  }
  if (view === 'upload' && !_uploadInited) {
    _uploadInited = true;
    initUpload();
  }

  // Analytics & Reports re-init each time to pick up new data
  if (view === 'analytics') {
    // Small delay so canvas is visible for Chart.js
    setTimeout(function () { initAnalytics(); }, 50);
  }
  if (view === 'reports') {
    initReports();
  }

  // Fix Leaflet map sizing when dashboard becomes visible
  if (view === 'dashboard' && leafletMap) {
    setTimeout(function () { leafletMap.invalidateSize(); }, 120);
  }
}

/* Start camera from dashboard — ensures live view is initialized and cam-keep is set */
function dashStartCamera() {
  if (cameraRunning) return;
  // Ensure live view is initialized so camera elements exist and work
  if (!_liveInited) {
    _liveInited = true;
    initLiveDetection();
  }
  // Start the actual camera (uses elements in live view)
  startCamera();
  // Since we're on dashboard, make live view cam-keep so video stays rendered
  var liveView = document.getElementById('view-live');
  if (liveView && !liveView.classList.contains('active')) {
    liveView.classList.add('cam-keep');
  }
}

function updateDashCamStatus() {
  var idle = document.getElementById('dashCamIdle');
  var badge = document.getElementById('dashCamBadge');
  var badgeText = document.getElementById('dashCamBadgeText');
  var dashVideo = document.getElementById('dashCamVideo');
  var dashOverlay = document.getElementById('dashOverlayCanvas');
  var dashLiveBadge = document.getElementById('dashLiveBadge');
  // Dashboard buttons
  var dashStart = document.getElementById('dashStartCameraBtn');
  var dashStop = document.getElementById('dashStopCameraBtn');
  if (cameraRunning) {
    if (idle) idle.style.display = 'none';
    if (dashVideo) dashVideo.style.display = '';
    if (dashOverlay) dashOverlay.style.display = '';
    if (dashLiveBadge) dashLiveBadge.style.display = '';
    if (badge) badge.className = 'badge-low';
    if (badgeText) badgeText.textContent = 'Live';
    if (dashStart) { dashStart.disabled = true; dashStart.style.opacity = '0.5'; }
    if (dashStop) { dashStop.disabled = false; dashStop.style.opacity = ''; }
  } else {
    if (idle) idle.style.display = '';
    if (dashVideo) { dashVideo.style.display = 'none'; dashVideo.srcObject = null; }
    if (dashOverlay) { dashOverlay.style.display = 'none'; var dCtx = dashOverlay.getContext('2d'); dCtx.clearRect(0, 0, dashOverlay.width, dashOverlay.height); }
    if (dashLiveBadge) dashLiveBadge.style.display = 'none';
    if (badge) badge.className = 'badge-low';
    if (badgeText) badgeText.textContent = 'Idle';
    if (dashStart) { dashStart.disabled = false; dashStart.style.opacity = ''; }
    if (dashStop) { dashStop.disabled = true; dashStop.style.opacity = '0.5'; }
  }
}

function updateDashboardMetrics() {
  var dc = document.getElementById('dashContamValue');
  if (dc) dc.textContent = contamination.toFixed(1) + '%';
  var dconf = document.getElementById('dashConfValue');
  if (dconf) dconf.textContent = confidence.toFixed(1) + '%';
  var dp = document.getElementById('dashParticleValue');
  if (dp) dp.textContent = particleCount;
  // Update dashboard cam badge with severity color
  if (cameraRunning) {
    var sev = getSeverity(contamination);
    var badge = document.getElementById('dashCamBadge');
    if (badge) badge.className = sev.cls;
  }
}

function initSPA() {
  // Clear potentially old mock data from localStorage to ensure clean start
  if (!localStorage.getItem('mp_data_cleaned_v2')) {
    localStorage.removeItem('mp_sessions');
    localStorage.removeItem('mp_zones');
    localStorage.removeItem('mp_live_session');
    localStorage.setItem('mp_data_cleaned_v2', 'true');
    console.log('Mock data cleared from localStorage');
  }

  initChatbot();

  // Determine initial view from hash
  var hash = window.location.hash.slice(1) || 'dashboard';
  navigateTo(hash);

  // Listen for hash changes (back/forward navigation)
  window.addEventListener('hashchange', function () {
    var view = window.location.hash.slice(1) || 'dashboard';
    navigateTo(view);
  });
}
document.addEventListener('DOMContentLoaded', function () {
  initSPA();
});