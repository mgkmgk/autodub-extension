// Background Service Worker
// Handles translation and cross-origin checks

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "translate") {
    const text = request.text;
    const targetLang = request.targetLang || "tr";
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`;

    fetch(url)
      .then((res) => res.json())
      .then((data) => {
        let translatedText = "";
        if (data && data[0]) {
          translatedText = data[0].map((item) => item[0]).filter(Boolean).join(" ");
        }
        sendResponse({ success: true, translatedText: translatedText.trim() });
      })
      .catch((err) => {
        console.error("Translation error:", err);
        sendResponse({ success: false, error: err.message });
      });

    return true; // Keep message channel open for async response
  }

  if (request.action === "checkServer") {
    fetch("http://127.0.0.1:5000/health", { method: "GET" })
      .then((res) => res.json())
      .then((data) => {
        sendResponse({ online: true, data });
      })
      .catch(() => {
        sendResponse({ online: false });
      });

    return true;
  }

  // Safely fetch audio through background service worker to prevent HTTPS/HTTP mixed content errors
  if (request.action === "getDubAudio") {
    const url = `http://127.0.0.1:5000/dub?text=${encodeURIComponent(request.text)}&voice=${encodeURIComponent(request.voice || "tr-TR-AhmetNeural")}`;
    fetch(url)
      .then(async (res) => {
        if (!res.ok) throw new Error("HTTP " + res.status);
        const buffer = await res.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = "";
        const len = bytes.byteLength;
        for (let i = 0; i < len; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const base64 = btoa(binary);
        sendResponse({ success: true, audioDataUrl: "data:audio/mpeg;base64," + base64 });
      })
      .catch((err) => {
        sendResponse({ success: false, error: err.message });
      });

    return true;
  }
});
