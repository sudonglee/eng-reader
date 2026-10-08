// iPad 내장 음성(Web Speech API) 래퍼
// - 단어 하이라이트: boundary 이벤트(charIndex) 사용, 이벤트가 없으면 시간 추정으로 대체
// - 속도: utterance.rate (음성을 다시 합성하므로 음높이 유지)

const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
let voices = [];
let current = null; // { id, resolve, timer, watchdog }
let seq = 0;
const keepAlive = new Set(); // iOS에서 utterance가 GC되어 onend가 안 오는 문제 방지

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const speechSupported = !!synth;

export function loadVoices() {
  return new Promise((resolve) => {
    if (!synth) return resolve([]);
    const done = () => { voices = synth.getVoices(); resolve(voices); };
    const v = synth.getVoices();
    if (v.length) { voices = v; return resolve(v); }
    synth.addEventListener('voiceschanged', done, { once: true });
    setTimeout(done, 1500);
  });
}

export function voicesFor(langPrefix) {
  return voices
    .filter((v) => v.lang.replace('_', '-').toLowerCase().startsWith(langPrefix.toLowerCase()))
    .sort((a, b) => voiceScore(b) - voiceScore(a));
}

// 고품질 음성 우선 (iPad: "(Premium)", "(Enhanced)" / 향상된 음성)
function voiceScore(v) {
  const n = v.name.toLowerCase();
  let s = 0;
  if (n.includes('premium')) s += 30;
  if (n.includes('enhanced') || n.includes('향상')) s += 20;
  if (/samantha|ava|allison|susan|zoe|karen|serena|daniel|kate|evan|nicky/.test(n)) s += 5;
  if (/albert|bad news|bahh|bells|boing|bubbles|cellos|jester|organ|superstar|trinoids|whisper|wobble|zarvox|good news|fred|junior|ralph|kathy|grandma|grandpa|eddy|flo|reed|rocko|sandy|shelley/.test(n)) s -= 50;
  if (v.localService) s += 2;
  return s;
}

export function pickVoice(lang, uri) {
  if (uri) {
    const v = voices.find((x) => x.voiceURI === uri);
    if (v) return v;
  }
  return voicesFor(lang)[0] || voicesFor(lang.split('-')[0])[0] || null;
}

// iPad Safari: 첫 음성은 사용자 터치 안에서 시작돼야 하므로 첫 터치 때 무음으로 한 번 깨워 둠
let unlocked = false;
export function unlock() {
  if (unlocked || !synth) return;
  unlocked = true;
  try {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    synth.speak(u);
  } catch (_) { /* 무시 */ }
}

export function isSpeaking() {
  return !!current;
}

export async function stop() {
  if (!synth) return;
  const c = current;
  current = null;
  if (c) { clearInterval(c.timer); clearTimeout(c.watchdog); c.resolve('cancel'); }
  if (synth.speaking || synth.pending) {
    synth.cancel();
    await sleep(80); // Safari: cancel 직후 바로 speak하면 무시되는 경우가 있음
  }
}

/**
 * 한 구간 읽기
 * @param {object} o
 *   text: 읽을 문자열
 *   words: [{start,end}] text 안의 단어 위치 (하이라이트용, 선택)
 *   lang, voiceURI, rate
 *   onWord(i): 현재 단어 인덱스
 * @returns Promise<'end'|'cancel'|'error'>
 */
export async function speak({ text, words = [], lang = 'en-US', voiceURI = '', rate = 1, onWord }) {
  if (!synth) return 'error';
  await stop();
  const id = ++seq;
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    const v = pickVoice(lang, voiceURI);
    if (v) u.voice = v;
    u.lang = v ? v.lang : lang;
    u.rate = rate;
    u.pitch = 1;
    keepAlive.add(u);

    let gotBoundary = false;
    let lastWord = -1;
    const emit = (i) => {
      if (i !== lastWord && i >= 0 && i < words.length) { lastWord = i; onWord && onWord(i); }
    };
    const charsPerSec = 14 * rate;
    const estDuration = (text.length / charsPerSec) * 1000;

    const finish = (why) => {
      keepAlive.delete(u);
      if (!current || current.id !== id) return;
      clearInterval(current.timer);
      clearTimeout(current.watchdog);
      current = null;
      resolve(why);
    };

    current = { id, resolve, timer: null, watchdog: null };
    // 음성이 아예 시작되지 않는 경우(음성 없음 등)에도 멈추지 않도록
    current.watchdog = setTimeout(() => finish('error'), estDuration * 3 + 8000);

    u.onstart = () => {
      if (!current || current.id !== id) return;
      clearTimeout(current.watchdog);
      if (words.length) emit(0);
      const t0 = performance.now();
      // boundary 이벤트가 오지 않는 환경을 위한 시간 기반 추정
      current.timer = setInterval(() => {
        if (gotBoundary || !words.length) return;
        const pos = ((performance.now() - t0) / 1000) * charsPerSec;
        let i = 0;
        while (i + 1 < words.length && words[i + 1].start <= pos) i++;
        emit(i);
      }, 60);
      current.watchdog = setTimeout(() => finish('end'), estDuration * 3 + 4000);
    };
    u.onboundary = (e) => {
      if (e.name && e.name !== 'word') return;
      gotBoundary = true;
      const ci = e.charIndex;
      let i = words.findIndex((w) => ci >= w.start && ci < w.end);
      if (i < 0) i = words.findIndex((w) => w.start >= ci);
      if (i >= 0) emit(i);
    };
    u.onend = () => finish('end');
    u.onerror = (e) => finish(e.error === 'interrupted' || e.error === 'canceled' ? 'cancel' : 'error');

    synth.speak(u);
  });
}

export function speakKo(text, voiceURI = '', rate = 1) {
  return speak({ text, lang: 'ko-KR', voiceURI, rate });
}

// 정답/오답 효과음
let audioCtx = null;
export function chime(kind = 'good') {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const notes = kind === 'good' ? [523.25, 659.25, 783.99] : [392, 311.13];
    notes.forEach((f, i) => {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = kind === 'good' ? 'triangle' : 'sine';
      o.frequency.value = f;
      const t = audioCtx.currentTime + i * 0.12;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      o.connect(g).connect(audioCtx.destination);
      o.start(t);
      o.stop(t + 0.32);
    });
  } catch (_) { /* 효과음은 실패해도 무시 */ }
}
