// VideoDubber TR - Content Script for YouTube & Netflix
(function() {
  "use strict";

  // CRITICAL: Strictly execute ONLY in the top-level window, never inside child iframes!
  if (window.self !== window.top) {
    return;
  }

  // Prevent multiple injections in the same tab
  if (window.__videodubber_initialized) {
    return;
  }
  window.__videodubber_initialized = true;

  let isDubbingEnabled = true; // Enabled by default
let currentVoice = "tr-TR-AhmetNeural";
let duckingVolumeRatio = 0.20; // Reduce original audio to 20%
let userOriginalVolume = 1.0;
let isAudioPlaying = false;
let audioPlayer = new Audio();
let serverOnline = false;

let lastProcessedText = "";
let lastEnqueuedText = "";
let lastEnqueuedTime = 0;
let subtitleBuffer = "";
let subtitleTimer = null;
let recentPhrases = []; // Anti-repetition sliding window
let activeObserver = null; // Singleton observer to prevent multiple instances

// Safe settings loader from chrome.storage
if (typeof chrome !== "undefined" && chrome.runtime?.id && chrome.storage?.sync) {
  try {
    chrome.storage.sync.get(["dubbingEnabled", "voice", "duckingRatio"], (res) => {
      if (chrome.runtime.lastError) return;
      if (res && res.dubbingEnabled !== undefined) isDubbingEnabled = res.dubbingEnabled;
      if (res && res.voice) currentVoice = res.voice;
      if (res && res.duckingRatio) duckingVolumeRatio = res.duckingRatio;
      updateToolbarButtonState();
    });
  } catch (e) {}
}

// Check if local neural server is online safely via Background Worker (No mixed content error)
function checkLocalServer() {
  if (typeof chrome === "undefined" || !chrome.runtime?.id) return;
  try {
    chrome.runtime.sendMessage({ action: "checkServer" }, (res) => {
      if (chrome.runtime.lastError) return;
      serverOnline = !!(res && res.online);
      updateServerBadge();
    });
  } catch (e) {
    serverOnline = false;
  }
}
checkLocalServer();
setInterval(checkLocalServer, 5000);

// Audio Ducking and Queue Management
const audioQueue = [];
let isQueuePlaying = false;

function applyDucking(videoElement, enable) {
  if (!videoElement) return;
  if (enable) {
    if (!isAudioPlaying) {
      userOriginalVolume = videoElement.volume || 1.0;
    }
    videoElement.volume = Math.max(0.05, userOriginalVolume * duckingVolumeRatio);
    isAudioPlaying = true;
  } else {
    videoElement.volume = userOriginalVolume;
    isAudioPlaying = false;
  }
}

// Translate text safely via background worker
async function translateText(text) {
  if (!text || !text.trim()) return "";
  if (typeof chrome !== "undefined" && chrome.runtime?.id) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ action: "translate", text: text, targetLang: "tr" }, (res) => {
          if (chrome.runtime.lastError || !res || !res.success) {
            resolve(text);
          } else {
            resolve(res.translatedText || text);
          }
        });
      } catch (e) {
        resolve(text);
      }
    });
  }
  return text;
}

// Play next item in queue without interrupting current speech
async function playNextInQueue() {
  const video = document.querySelector("video");
  if (!video || video.paused || !isDubbingEnabled) {
    isQueuePlaying = false;
    applyDucking(video, false);
    return;
  }

  if (audioQueue.length === 0) {
    isQueuePlaying = false;
    applyDucking(video, false);
    return;
  }

  isQueuePlaying = true;
  const item = audioQueue.shift();

  // Speed up slightly if queued items pile up
  const speed = audioQueue.length > 1 ? 1.25 : 1.12;

  if (serverOnline && typeof chrome !== "undefined" && chrome.runtime?.id) {
    try {
      chrome.runtime.sendMessage(
        { action: "getDubAudio", text: item.text, voice: currentVoice },
        async (res) => {
          if (chrome.runtime.lastError || !res || !res.success || !res.audioDataUrl) {
            const translated = await translateText(item.text);
            fallbackWebSpeech(translated || item.text, video, () => playNextInQueue());
            return;
          }

          audioPlayer.src = res.audioDataUrl;
          audioPlayer.playbackRate = speed;

          audioPlayer.onplay = () => {
            applyDucking(video, true);
            showSubtitleFeedback(item.text);
          };

          audioPlayer.onended = () => {
            playNextInQueue();
          };

          audioPlayer.onerror = async () => {
            const translated = await translateText(item.text);
            fallbackWebSpeech(translated || item.text, video, () => playNextInQueue());
          };

          try {
            await audioPlayer.play();
          } catch (e) {
            playNextInQueue();
          }
        }
      );
    } catch (e) {
      const translated = await translateText(item.text);
      fallbackWebSpeech(translated || item.text, video, () => playNextInQueue());
    }
  } else {
    const translated = await translateText(item.text);
    fallbackWebSpeech(translated || item.text, video, () => playNextInQueue());
  }
}

function fallbackWebSpeech(text, video, onDone) {
  if (!("speechSynthesis" in window)) {
    if (onDone) onDone();
    return;
  }

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "tr-TR";
  utterance.rate = audioQueue.length > 1 ? 1.2 : 1.1;

  const voices = window.speechSynthesis.getVoices();
  const trVoice = voices.find((v) => v.lang.startsWith("tr"));
  if (trVoice) utterance.voice = trVoice;

  utterance.onstart = () => {
    applyDucking(video, true);
    showSubtitleFeedback(text);
  };
  utterance.onend = () => {
    if (onDone) onDone();
  };
  utterance.onerror = () => {
    if (onDone) onDone();
  };

  window.speechSynthesis.speak(utterance);
}

// Queue speech item
function enqueueSpeech(text) {
  if (!text || !text.trim()) return;
  audioQueue.push({ text: text.trim() });
  if (!isQueuePlaying) {
    playNextInQueue();
  }
}

// Clear queue when user pauses or seeks
function clearAudioQueue() {
  audioQueue.length = 0;
  recentPhrases = [];
  lastProcessedText = "";
  isQueuePlaying = false;
  if (audioPlayer) {
    audioPlayer.pause();
    audioPlayer.src = "";
  }
  if ("speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
  const video = document.querySelector("video");
  applyDucking(video, false);
}

// Process Captured Subtitle with Anti-Repetition Filter
function processSubtitleText(rawText) {
  const cleaned = rawText.trim().replace(/\s+/g, " ");
  if (!cleaned || cleaned.length < 3) return;

  // 1. If text is identical to last processed, skip immediately
  if (cleaned === lastProcessedText) return;

  // 2. Incremental text handling:
  // If the new text starts with lastProcessedText (e.g. YouTube appended new words to the line),
  // extract ONLY the new part so we don't repeat the beginning of the sentence!
  let textToSpeak = cleaned;
  if (lastProcessedText && cleaned.startsWith(lastProcessedText)) {
    textToSpeak = cleaned.slice(lastProcessedText.length).trim();
  }

  lastProcessedText = cleaned;

  if (!textToSpeak || textToSpeak.length < 3) return;

  // 3. Time-based debounce:
  // Never enqueue the exact same text within 2 seconds
  const now = Date.now();
  if (textToSpeak === lastEnqueuedText && now - lastEnqueuedTime < 2500) {
    return;
  }

  // 4. Sliding history deduplication:
  const lower = textToSpeak.toLowerCase();
  if (recentPhrases.includes(lower)) {
    return;
  }

  recentPhrases.push(lower);
  if (recentPhrases.length > 15) recentPhrases.shift();

  lastEnqueuedText = textToSpeak;
  lastEnqueuedTime = now;

  console.log("[VideoDubber TR] Yeni konuşma yakalandı:", textToSpeak);
  enqueueSpeech(textToSpeak);
}

// Ensure YouTube CC (Subtitles) is Active
function ensureSubtitlesActive() {
  if (!isDubbingEnabled) return;
  const subBtn = document.querySelector(".ytp-subtitles-button");
  if (subBtn && subBtn.getAttribute("aria-pressed") !== "true") {
    console.log("[VideoDubber TR] YouTube altyazıları otomatik aktifleştiriliyor...");
    subBtn.click();
  }
}

// Platform detection
const isNetflix = window.location.hostname.includes("netflix.com");
const isYouTube = window.location.hostname.includes("youtube.com");

// Live Subtitle Observer (Supports both YouTube & Netflix) - Guaranteed Single Instance
function setupSubtitleObserver() {
  if (activeObserver) return; // Prevent multiple observers from running in parallel!

  activeObserver = new MutationObserver(() => {
    if (!isDubbingEnabled) return;

    let fullText = "";

    if (isNetflix) {
      // Netflix renders text in .player-timedtext-text-container
      // Nested spans inside caused duplicate reading - we read the container directly!
      const textContainers = document.querySelectorAll(".player-timedtext-text-container");
      if (textContainers && textContainers.length > 0) {
        const uniqueLines = [];
        textContainers.forEach((tc) => {
          const line = tc.textContent.trim().replace(/\s+/g, " ");
          if (line && !uniqueLines.includes(line)) {
            uniqueLines.push(line);
          }
        });
        fullText = uniqueLines.join(" ").trim();
      } else {
        const genericContainer = document.querySelector(".player-timedtext, [data-uia='player-timedtext']");
        if (genericContainer) {
          fullText = genericContainer.textContent.trim().replace(/\s+/g, " ");
        }
      }
    } else {
      // YouTube captions
      const segments = document.querySelectorAll(".ytp-caption-segment");
      if (!segments || segments.length === 0) return;

      segments.forEach((seg) => {
        const txt = seg.textContent.trim();
        if (txt) fullText += txt + " ";
      });
      fullText = fullText.trim();
    }

    if (!fullText) return;

    if (fullText !== subtitleBuffer) {
      subtitleBuffer = fullText;
      clearTimeout(subtitleTimer);

      const endsWithSentencePunctuation = /[.!?…]$/.test(fullText);
      const delay = isNetflix ? 250 : (endsWithSentencePunctuation ? 300 : 750);

      subtitleTimer = setTimeout(() => {
        processSubtitleText(subtitleBuffer);
      }, delay);
    }
  });

  activeObserver.observe(document.body, { childList: true, subtree: true, characterData: true });

  const video = document.querySelector("video");
  if (video) {
    video.addEventListener("seeking", clearAudioQueue);
    video.addEventListener("pause", clearAudioQueue);
    if (isYouTube) {
      video.addEventListener("play", ensureSubtitlesActive);
    }
  }
}

// Visual Subtitle Overlay (Floating feedback on player)
function showSubtitleFeedback(text) {
  let badge = document.getElementById("videodubber-preview");
  if (!badge) {
    badge = document.createElement("div");
    badge.id = "videodubber-preview";
    const player = document.querySelector(isNetflix ? ".watch-video, .nf-player-container, #appMountPoint" : "#movie_player") || document.body;
    player.appendChild(badge);
  }
  badge.textContent = `🎙️ ${text}`;
  badge.style.display = "block";
  clearTimeout(badge.fadeTimeout);
  badge.fadeTimeout = setTimeout(() => {
    badge.style.display = "none";
  }, 4000);
}

// Inject Dubbing Button into Player Controls (YouTube & Netflix)
function injectPlayerControls() {
  if (document.getElementById("videodubber-btn") || document.getElementById("videodubber-netflix-pill")) return;

  if (isYouTube) {
    const rightControls = document.querySelector(".ytp-right-controls");
    if (!rightControls) return;

    const btn = document.createElement("button");
    btn.id = "videodubber-btn";
    btn.className = "ytp-button videodubber-btn active";
    btn.title = "Türkçe Dublaj: Açık (Kapatmak için tıkla)";
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" class="videodubber-icon">
        <path fill="currentColor" d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
        <path fill="currentColor" d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
      </svg>
      <span class="videodubber-dot"></span>
    `;

    btn.addEventListener("click", toggleDubbing);
    rightControls.insertBefore(btn, rightControls.firstChild);
    updateToolbarButtonState();
  } else if (isNetflix) {
    // For Netflix, inject a sleek floating pill button in top-right or controls bar
    const netflixPill = document.createElement("div");
    netflixPill.id = "videodubber-netflix-pill";
    netflixPill.className = "videodubber-netflix-pill active";
    netflixPill.innerHTML = `
      <span class="videodubber-netflix-dot online"></span>
      <span class="videodubber-netflix-text">🎙️ Dublaj: Açık</span>
    `;

    netflixPill.addEventListener("click", toggleDubbing);
    document.body.appendChild(netflixPill);
    updateToolbarButtonState();
  }
}

function toggleDubbing() {
  isDubbingEnabled = !isDubbingEnabled;
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.sync) {
    chrome.storage.sync.set({ dubbingEnabled: isDubbingEnabled });
  }
  updateToolbarButtonState();
  
  if (isDubbingEnabled) {
    if (isYouTube) ensureSubtitlesActive();
  } else {
    clearAudioQueue();
  }
}

function updateToolbarButtonState() {
  // YouTube Button Update
  const btn = document.getElementById("videodubber-btn");
  if (btn) {
    if (isDubbingEnabled) {
      btn.classList.add("active");
      btn.title = "Türkçe Dublaj: Açık (Kapatmak için tıkla)";
    } else {
      btn.classList.remove("active");
      btn.title = "Türkçe Dublaj: Kapalı (Açmak için tıkla)";
    }
  }

  // Netflix Pill Update
  const pill = document.getElementById("videodubber-netflix-pill");
  if (pill) {
    const textSpan = pill.querySelector(".videodubber-netflix-text");
    const dot = pill.querySelector(".videodubber-netflix-dot");
    if (isDubbingEnabled) {
      pill.classList.add("active");
      if (textSpan) textSpan.textContent = "🎙️ Dublaj: Açık";
      if (dot) dot.className = "videodubber-netflix-dot " + (serverOnline ? "online" : "offline");
    } else {
      pill.classList.remove("active");
      if (textSpan) textSpan.textContent = "🎙️ Dublaj: Kapalı";
      if (dot) dot.className = "videodubber-netflix-dot disabled";
    }
  }
}

function updateServerBadge() {
  const btn = document.getElementById("videodubber-btn");
  if (btn) {
    const dot = btn.querySelector(".videodubber-dot");
    if (dot) {
      dot.className = "videodubber-dot " + (serverOnline ? "online" : "offline");
      dot.title = serverOnline ? "Ultra-HD Neural Ses Aktif" : "Tarayıcı Sesi Modu (Sunucu kapalı)";
    }
  }
  const pill = document.getElementById("videodubber-netflix-pill");
  if (pill) {
    const dot = pill.querySelector(".videodubber-netflix-dot");
    if (dot && isDubbingEnabled) {
      dot.className = "videodubber-netflix-dot " + (serverOnline ? "online" : "offline");
    }
  }
}

// Initialize on page load and SPA navigations
function init() {
  injectPlayerControls();
  setupSubtitleObserver();
  if (isYouTube) ensureSubtitlesActive();
}

// Watch for SPA navigation changes (YouTube & Netflix)
window.addEventListener("yt-navigate-finish", () => {
  setTimeout(init, 1000);
});

// Periodic check for video player mounting (cleans up immediately once found)
const checkInterval = setInterval(() => {
  const hasControls = isYouTube 
    ? document.querySelector(".ytp-right-controls") 
    : document.querySelector("video");
  if (hasControls) {
    init();
    clearInterval(checkInterval); // Stop looping to prevent duplicate observers!
  }
}, 500);

})();

