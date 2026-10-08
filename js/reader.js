import { h, mount, modal, toast, longPress } from './ui.js';
import { db, uid, getSettings, saveSettings, imageURL, saveBook } from './db.js';
import { tokenize, hashText } from './text.js';
import * as speech from './speech.js';
import { lookupWord } from './claude.js';
import { go } from './main.js';

const SPEEDS = [
  { v: 0.5, label: '🐢', name: '아주 천천히' },
  { v: 0.75, label: '🐢', name: '천천히' },
  { v: 1, label: '🙂', name: '보통' },
  { v: 1.25, label: '🐇', name: '빠르게' },
];
const REPEATS = [1, 2, 3, Infinity];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function renderReader(root, bookId, pageIndex) {
  const book = await db.get('books', bookId);
  if (!book) { go('#/'); return; }
  const pages = book.pages.filter((p) => (p.sentences || []).length || p.imageId);
  const total = pages.length;
  let pi = Math.max(0, Math.min(total - 1, Number(pageIndex) || 0));
  const settings = await getSettings();
  await speech.loadVoices();

  let rate = settings.rate || 1;
  let repeat = 1;
  let rangeMode = false;
  let rangeStart = null;
  let playToken = 0;
  let playingPage = false;

  // 읽기 기록 (책을 열 때마다 1건)
  const log = { id: uid(), bookId, date: Date.now(), maxPage: pi, finished: false, tappedWords: [] };
  const saveLog = () => db.put('reads', log).catch(() => {});

  // ---------- 화면 요소 ----------
  const imgEl = h('img', { class: 'page-img', alt: '책 페이지 사진' });
  const imgWrap = h('div', { class: 'page-image', onclick: () => zoomImage(imgEl.src) }, imgEl);
  const textEl = h('div', { class: 'page-text', lang: 'en' });
  const pageNo = h('span', { class: 'page-no' });
  const playBtn = h('button', { class: 'ctl play', onclick: togglePlay, 'aria-label': '읽어 주기' }, '▶');
  const prevBtn = h('button', { class: 'ctl', onclick: () => turn(-1), 'aria-label': '이전 페이지' }, '◀');
  const nextBtn = h('button', { class: 'ctl', onclick: () => turn(1), 'aria-label': '다음 페이지' }, '▶▶');
  const speedBox = h('div', { class: 'seg', role: 'group', 'aria-label': '속도' });
  const repeatBtn = h('button', { class: 'ctl small', onclick: cycleRepeat, 'aria-label': '반복' });
  const rangeBtn = h('button', { class: 'ctl small', onclick: toggleRange, 'aria-label': '구간 선택' }, '✂️ 구간');
  const quizBar = h('div', { class: 'quiz-bar hidden' },
    h('span', {}, '🎉 다 읽었어요!'),
    h('button', { class: 'btn primary big', onclick: () => { stopAll(); go(`#/quiz/${bookId}`); } }, '퀴즈 풀기 ✏️'),
  );
  const hint = h('div', { class: 'hint' });

  function renderSpeed() {
    speedBox.replaceChildren(...SPEEDS.map((s) =>
      h('button', {
        class: `seg-btn ${s.v === rate ? 'on' : ''}`,
        onclick: () => { rate = s.v; saveSettings({ rate }); renderSpeed(); },
        'aria-label': s.name, title: s.name,
      }, s.label, h('small', {}, `${s.v}x`))));
  }
  function renderRepeat() {
    repeatBtn.textContent = repeat === Infinity ? '🔁 계속' : `🔁 ${repeat}번`;
    repeatBtn.classList.toggle('on', repeat !== 1);
  }
  function cycleRepeat() {
    repeat = REPEATS[(REPEATS.indexOf(repeat) + 1) % REPEATS.length];
    renderRepeat();
  }
  function toggleRange() {
    rangeMode = !rangeMode;
    rangeStart = null;
    rangeBtn.classList.toggle('on', rangeMode);
    clearMarks('range');
    hint.textContent = rangeMode ? '듣고 싶은 부분의 첫 단어와 마지막 단어를 눌러요' : '';
  }

  // ---------- 페이지 그리기 ----------
  let sentEls = []; // [{el, words:[{el, ...token}]}]
  async function renderPage(keepPlaying = false) {
    if (!keepPlaying) stopAll();
    const page = pages[pi];
    imgEl.src = await imageURL(page.imageId);
    imgWrap.classList.toggle('hidden', !page.imageId);
    pageNo.textContent = `${pi + 1} / ${total}`;
    prevBtn.disabled = pi === 0;
    nextBtn.disabled = pi === total - 1;
    sentEls = (page.sentences || []).map((s, si) => {
      const words = tokenize(s).map((t, wi) => {
        const el = h('span', { class: 'w' }, t.text);
        longPress(el, () => showMeaning(t.speak || t.text, s), () => onWordTap(si, wi));
        return { ...t, el };
      });
      const parts = [];
      words.forEach((w, i) => { if (i) parts.push(' '); parts.push(w.el); });
      const el = h('p', { class: 'sent' },
        h('button', { class: 'sent-play', onclick: () => playSentence(si), 'aria-label': `${si + 1}번째 문장 듣기` }, '🔊'),
        h('span', { class: 'sent-text' }, parts));
      return { el, words, text: s };
    });
    textEl.replaceChildren(...(sentEls.length ? sentEls.map((x) => x.el) : [h('p', { class: 'muted' }, '(이 페이지에는 글이 없어요)')]));
    textEl.scrollTop = 0;
    if (pi > log.maxPage) log.maxPage = pi;
    const last = pi === total - 1;
    quizBar.classList.toggle('hidden', !last);
    if (last && !log.finished) { log.finished = true; }
    saveLog();
    history.replaceState(null, '', `#/read/${bookId}/${pi}`);
  }

  function clearMarks(cls) {
    textEl.querySelectorAll(`.${cls}`).forEach((e) => e.classList.remove(cls));
  }

  // ---------- 재생 ----------
  async function stopAll() {
    playToken++;
    playingPage = false;
    playBtn.textContent = '▶';
    playBtn.classList.remove('on');
    clearMarks('active');
    clearMarks('reading');
    await speech.stop();
  }

  // words: [{el, start, end}] 기준으로 한 구간을 repeat 횟수만큼 읽기
  async function playSegment(text, words, sentEl, token, times = 1) {
    for (let k = 0; k < times; k++) {
      if (token !== playToken) return 'cancel';
      if (sentEl) sentEl.classList.add('reading');
      const r = await speech.speak({
        text, words, lang: settings.accent, voiceURI: settings.voiceURI, rate,
        onWord: (i) => { clearMarks('active'); words[i]?.el?.classList.add('active'); },
      });
      clearMarks('active');
      if (sentEl) sentEl.classList.remove('reading');
      if (r !== 'end' || token !== playToken) return 'cancel';
      if (k + 1 < times) await sleep(500);
    }
    return 'end';
  }

  async function playSentence(si) {
    await stopAll();
    const token = playToken;
    const s = sentEls[si];
    await playSegment(s.text, s.words, s.el, token, repeat);
  }

  async function onWordTap(si, wi) {
    const word = sentEls[si].words[wi];
    log.tappedWords.push(word.speak.toLowerCase());
    saveLog();
    if (rangeMode) {
      if (!rangeStart) {
        rangeStart = { si, wi };
        clearMarks('range');
        word.el.classList.add('range');
        hint.textContent = '이제 마지막 단어를 눌러요';
        return;
      }
      let a = rangeStart; let b = { si, wi };
      if (b.si < a.si || (b.si === a.si && b.wi < a.wi)) [a, b] = [b, a];
      rangeStart = null;
      const picked = [];
      for (let s = a.si; s <= b.si; s++) {
        const ws = sentEls[s].words;
        const from = s === a.si ? a.wi : 0;
        const to = s === b.si ? b.wi : ws.length - 1;
        for (let w = from; w <= to; w++) picked.push(ws[w]);
      }
      clearMarks('range');
      picked.forEach((w) => w.el.classList.add('range'));
      hint.textContent = '구간을 다시 고르려면 첫 단어를 눌러요';
      await playRange(picked);
      return;
    }
    await stopAll();
    const token = playToken;
    word.el.classList.add('active');
    await playSegment(word.speak || word.text, [{ ...word, start: 0, end: (word.speak || word.text).length }], null, token, repeat);
    word.el.classList.remove('active');
  }

  async function playRange(picked) {
    await stopAll();
    const token = playToken;
    let text = '';
    const words = picked.map((w) => {
      if (text) text += ' ';
      const start = text.length;
      text += w.text;
      return { el: w.el, start, end: text.length };
    });
    await playSegment(text, words, null, token, repeat);
  }

  async function togglePlay() {
    if (playingPage) { await stopAll(); return; }
    await stopAll();
    const token = playToken;
    playingPage = true;
    playBtn.textContent = '⏸';
    playBtn.classList.add('on');
    for (;;) {
      for (let si = 0; si < sentEls.length; si++) {
        const s = sentEls[si];
        s.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        const r = await playSegment(s.text, s.words, s.el, token, 1);
        if (r !== 'end') return;
        await sleep(350);
      }
      if (token !== playToken) return;
      if (!(settings.autoPageTurn && pi < total - 1)) break;
      pi++;
      await renderPage(true); // 재생 상태 유지한 채 다음 페이지
      await sleep(600);
      if (token !== playToken) return;
    }
    if (token === playToken) await stopAll();
  }

  async function turn(d) {
    const n = pi + d;
    if (n < 0 || n >= total) return;
    pi = n;
    if (rangeMode) toggleRange();
    await renderPage();
  }

  // ---------- 단어 뜻 ----------
  async function showMeaning(word, sentence) {
    if (!word) return;
    stopAll();
    const key = `${word.toLowerCase()}|${hashText(sentence)}`;
    const body = h('div', { class: 'meaning-body' }, h('p', { class: 'muted' }, '뜻을 찾고 있어요…'));
    const sayWord = () => speech.speak({ text: word, lang: settings.accent, voiceURI: settings.voiceURI, rate });
    modal(h('div', { class: 'meaning' },
      h('div', { class: 'meaning-word', lang: 'en' }, word,
        h('button', { class: 'icon-btn', onclick: sayWord, 'aria-label': '단어 듣기' }, '🔊')),
      body,
    ));
    sayWord();
    try {
      book.glossary = book.glossary || {};
      let m = book.glossary[key];
      if (!m) {
        m = await lookupWord(word, sentence);
        book.glossary[key] = m;
        saveBook(book).catch(() => {});
      }
      body.replaceChildren(
        h('div', { class: 'meaning-ko' }, m.emoji ? h('span', { class: 'emoji' }, m.emoji) : null, m.meaning_ko),
        h('p', { class: 'meaning-sent', lang: 'en' }, sentence),
        h('p', { class: 'meaning-sent-ko' }, m.sentence_ko),
      );
      speech.speakKo(m.meaning_ko, settings.koVoiceURI);
    } catch (e) {
      body.replaceChildren(h('p', { class: 'muted' }, '지금은 뜻을 불러올 수 없어요.'), h('p', { class: 'small muted' }, e.message));
    }
  }

  function zoomImage(src) {
    if (!src) return;
    modal(h('img', { src, class: 'zoom-img', alt: '' }), { wide: true });
  }

  // ---------- 스와이프로 페이지 넘기기 ----------
  let sx = null; let sy = null;
  const main = h('main', { class: 'reader' }, imgWrap, h('div', { class: 'text-col' }, textEl, hint, quizBar));
  main.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
  main.addEventListener('touchend', (e) => {
    if (sx === null) return;
    const dx = e.changedTouches[0].clientX - sx;
    const dy = e.changedTouches[0].clientY - sy;
    if (Math.abs(dx) > 80 && Math.abs(dx) > Math.abs(dy) * 1.5) turn(dx < 0 ? 1 : -1);
    sx = null;
  });

  renderSpeed();
  renderRepeat();
  mount(root,
    h('header', { class: 'topbar kid' },
      h('button', { class: 'icon-btn', onclick: () => { stopAll(); go('#/'); }, 'aria-label': '책장으로' }, '🏠'),
      h('h1', { class: 'book-h' }, book.title),
      pageNo,
    ),
    main,
    h('footer', { class: 'controls' },
      h('div', { class: 'ctl-group' }, prevBtn, playBtn, nextBtn),
      h('div', { class: 'ctl-group' }, speedBox),
      h('div', { class: 'ctl-group' }, repeatBtn, rangeBtn),
    ),
  );
  await renderPage();

  if (!speech.speechSupported) toast('이 브라우저는 음성 읽기를 지원하지 않아요.', 'error');

  // 화면을 떠날 때 정리
  return () => { stopAll(); saveLog(); };
}
