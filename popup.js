// VideoDubber TR - Popup Script

const dubbingToggle = document.getElementById("dubbingToggle");
const voiceSelect = document.getElementById("voiceSelect");
const volumeRange = document.getElementById("volumeRange");
const volumeValue = document.getElementById("volumeValue");
const serverStatus = document.getElementById("serverStatus");

// Load stored settings
chrome.storage.sync.get(["dubbingEnabled", "voice", "duckingRatio"], (res) => {
  if (res.dubbingEnabled !== undefined) {
    dubbingToggle.checked = res.dubbingEnabled;
  }
  if (res.voice) {
    voiceSelect.value = res.voice;
  }
  if (res.duckingRatio) {
    const pct = Math.round(res.duckingRatio * 100);
    volumeRange.value = pct;
    volumeValue.textContent = `%${pct}`;
  }
});

// Save settings on changes
dubbingToggle.addEventListener("change", () => {
  chrome.storage.sync.set({ dubbingEnabled: dubbingToggle.checked });
});

voiceSelect.addEventListener("change", () => {
  chrome.storage.sync.set({ voice: voiceSelect.value });
});

volumeRange.addEventListener("input", () => {
  const pct = volumeRange.value;
  volumeValue.textContent = `%${pct}`;
  chrome.storage.sync.set({ duckingRatio: pct / 100 });
});

// Check Server Status
function checkStatus() {
  chrome.runtime.sendMessage({ action: "checkServer" }, (res) => {
    if (res && res.online) {
      serverStatus.textContent = "● Ultra-HD Neural Aktif";
      serverStatus.className = "status-badge online";
    } else {
      serverStatus.textContent = "● Tarayıcı Sesi Modu";
      serverStatus.className = "status-badge offline";
    }
  });
}

checkStatus();
