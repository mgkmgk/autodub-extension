import asyncio
import hashlib
import json
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
import edge_tts

PORT = 5000
AUDIO_CACHE = {}
TRANSLATE_CACHE = {}

AVAILABLE_VOICES = [
    {"id": "tr-TR-AhmetNeural", "name": "Ahmet (Erkek - Doğal)", "lang": "tr-TR"},
    {"id": "tr-TR-EmelNeural", "name": "Emel (Kadın - Doğal)", "lang": "tr-TR"},
    {"id": "en-US-GuyNeural", "name": "Guy (İngilizce - Erkek)", "lang": "en-US"},
    {"id": "en-US-JennyNeural", "name": "Jenny (İngilizce - Kadın)", "lang": "en-US"}
]

def translate_to_turkish(text: str) -> str:
    cleaned = text.strip()
    if not cleaned:
        return ""
    if cleaned in TRANSLATE_CACHE:
        return TRANSLATE_CACHE[cleaned]
    try:
        url = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=tr&dt=t&q=" + urllib.parse.quote(cleaned)
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=4.0) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            translated = "".join([item[0] for item in data[0] if item[0]]).strip()
            if len(TRANSLATE_CACHE) > 500:
                TRANSLATE_CACHE.pop(next(iter(TRANSLATE_CACHE)))
            TRANSLATE_CACHE[cleaned] = translated
            return translated
    except Exception as e:
        print(f"[AutoDub Bridge] Çeviri hatası: {e}")
        return cleaned

async def generate_speech(text: str, voice: str = "tr-TR-AhmetNeural", rate: str = "+0%") -> bytes:
    cache_key = hashlib.md5(f"{text}_{voice}_{rate}".encode("utf-8")).hexdigest()
    if cache_key in AUDIO_CACHE:
        return AUDIO_CACHE[cache_key]

    comm = edge_tts.Communicate(text=text, voice=voice, rate=rate)
    chunks = []
    async for chunk in comm.stream():
        if chunk["type"] == "audio":
            chunks.append(chunk["data"])
    audio_data = b"".join(chunks)

    # Cache up to 200 phrases in memory
    if len(AUDIO_CACHE) > 200:
        AUDIO_CACHE.pop(next(iter(AUDIO_CACHE)))
    AUDIO_CACHE[cache_key] = audio_data
    return audio_data

class AutoDubHandler(BaseHTTPRequestHandler):
    def _send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Range")
        self.send_header("Access-Control-Expose-Headers", "Content-Length, Content-Range")

    def do_OPTIONS(self):
        self.send_response(200)
        self._send_cors_headers()
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        if path == "/health":
            self.send_response(200)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            resp = {
                "status": "ok",
                "service": "AutoDub Ultra-HD Neural TTS Bridge",
                "voices": AVAILABLE_VOICES,
                "cached_items": len(AUDIO_CACHE)
            }
            self.wfile.write(json.dumps(resp, ensure_ascii=False).encode("utf-8"))
            return

        elif path == "/voices":
            self.send_response(200)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps(AVAILABLE_VOICES, ensure_ascii=False).encode("utf-8"))
            return

        elif path == "/dub":
            raw_text = query.get("text", [""])[0]
            voice = query.get("voice", ["tr-TR-AhmetNeural"])[0]
            rate = query.get("rate", ["+0%"])[0]

            if not raw_text.strip():
                self.send_response(400)
                self._send_cors_headers()
                self.end_headers()
                self.wfile.write(b"Parametre eksik: 'text' gerekli.")
                return

            try:
                # 1. Translate to Turkish
                translated_text = translate_to_turkish(raw_text)
                print(f"[AutoDub Bridge] Orijinal: '{raw_text}' -> TR: '{translated_text}'")

                # 2. Generate Audio
                audio_bytes = asyncio.run(generate_speech(translated_text, voice, rate))

                self.send_response(200)
                self._send_cors_headers()
                self.send_header("Content-Type", "audio/mpeg")
                self.send_header("Content-Length", str(len(audio_bytes)))
                self.send_header("X-Translated-Text", urllib.parse.quote(translated_text))
                self.send_header("Cache-Control", "public, max-age=86400")
                self.end_headers()
                self.wfile.write(audio_bytes)
            except Exception as e:
                self.send_response(500)
                self._send_cors_headers()
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode("utf-8"))
            return

        elif path == "/tts":
            text = query.get("text", [""])[0]
            voice = query.get("voice", ["tr-TR-AhmetNeural"])[0]
            rate = query.get("rate", ["+0%"])[0]

            if not text.strip():
                self.send_response(400)
                self._send_cors_headers()
                self.end_headers()
                self.wfile.write(b"Parametre eksik: 'text' gerekli.")
                return

            try:
                # Run async edge-tts in thread loop
                audio_bytes = asyncio.run(generate_speech(text, voice, rate))
                self.send_response(200)
                self._send_cors_headers()
                self.send_header("Content-Type", "audio/mpeg")
                self.send_header("Content-Length", str(len(audio_bytes)))
                self.send_header("Cache-Control", "public, max-age=86400")
                self.end_headers()
                self.wfile.write(audio_bytes)
            except Exception as e:
                self.send_response(500)
                self._send_cors_headers()
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                err_resp = {"error": str(e)}
                self.wfile.write(json.dumps(err_resp).encode("utf-8"))
            return

        else:
            self.send_response(404)
            self._send_cors_headers()
            self.end_headers()
            self.wfile.write(b"404 Not Found")

    def log_message(self, format, *args):
        # Keep console output clean
        print(f"[AutoDub Bridge] {args[0]} - {args[1]} ({args[2]})")

def main():
    server = HTTPServer(("127.0.0.1", PORT), AutoDubHandler)
    print("=" * 60)
    print(f"  AutoDub Ultra-HD Neural TTS Köprüsü Başlatıldı!")
    print(f"  Adres: http://127.0.0.1:{PORT}")
    print(f"  Test:  http://127.0.0.1:{PORT}/health")
    print(f"  Edge TTS sesleri hazır: Ahmet & Emel (Neural TR)")
    print("=" * 60)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nKöprü durduruldu.")
        server.server_close()

if __name__ == "__main__":
    main()
