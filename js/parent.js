import { h, mount, modal, toast, confirmBox, fmtDate } from './ui.js';
import {
  db, uid, listBooks, saveBook, deleteBook, putImage, getImageBlob, imageURL, forgetImageURL,
  getSettings, saveSettings, exportAll, importAll,
} from './db.js';
import { normalizeImage, rotateImage } from './image.js';
import { linesToSentences, splitSentences, bookTextHash, bookSentences } from './text.js';
import { ocrPage, generateQuiz, testConnection } from './claude.js';
import * as speech from './speech.js';
import { go } from './main.js';

const MODELS = [
  ['claude-sonnet-5-5', 'Sonnet 5.5 (권장)'],
  ['claude-haiku-5-5', 'Haiku 5.5 (저렴, 빠름)'],
  ['claude-opus-5-5', 'Opus 5.5 (가장 정확)'],
];

function shell(root, active, ...content) {
  const tab = (href, label, key) => h('a', { href, class: `tab ${active === key ? 'on' : ''}` }, label);
  mount(root,
    h('header', { class: 'topbar parent' },
      h('h1', {}, '👩‍👧 부모 모드'),
      h('nav', { class: 'tabs' },
        tab('#/parent', '📚 책 관리', 'books'),
        tab('#/parent/records', '📊 학습 기록', 'records'),
        tab('#/parent/settings', '⚙️ 설정', 'settings')),
      h('button', { class: 'btn ghost', onclick: () => go('#/', { lock: true }) }, '아이 모드로 ▶'),
    ),
    h('main', { class: 'parent-main' }, content),
  );
}

// =============== 책 목록 ===============
export async function renderBooks(root) {
  // 만들다 만 빈 책(사진·표지 없음)은 정리
  for (const b of await listBooks()) {
    if (!b.pages.length && !b.coverImageId && b.title === '새 책') await deleteBook(b);
  }
  const books = await listBooks();
  const s = await getSettings();
  const rows = await Promise.all(books.map(async (b) => {
    const src = await imageURL(b.coverImageId || b.pages[0]?.imageId);
    const withText = b.pages.filter((p) => (p.sentences || []).length).length;
    const quizOk = b.quiz && b.quiz.textHash === bookTextHash(b);
    return h('div', { class: 'book-row' },
      h('div', { class: 'thumb' }, src ? h('img', { src, alt: '' }) : '📖'),
      h('div', { class: 'grow' },
        h('div', { class: 'title' }, b.title),
        h('div', { class: 'small muted' },
          `${b.pages.length}페이지 · 글자 ${withText}/${b.pages.length} · `,
          quizOk ? `퀴즈 ${b.quiz.questions.length}문제` : '퀴즈 없음',
          ` · ${fmtDate(b.updatedAt)}`)),
      h('button', { class: 'btn ghost', onclick: () => go(`#/parent/book/${b.id}`) }, '편집'),
      h('button', { class: 'btn ghost danger-text', onclick: async () => {
        if (await confirmBox(`"${b.title}"을(를) 삭제할까요? 사진과 학습 기록도 함께 지워져요.`, '삭제', true)) {
          await deleteBook(b); renderBooks(root);
        }
      } }, '삭제'),
    );
  }));
  shell(root, 'books',
    !s.apiKey ? h('div', { class: 'notice' }, '⚠️ 글자 추출과 퀴즈 만들기에는 Claude API 키가 필요해요. ',
      h('a', { href: '#/parent/settings' }, '설정에서 입력하기')) : null,
    h('div', { class: 'row between' },
      h('h2', {}, '책 목록'),
      h('button', { class: 'btn primary', onclick: () => go('#/parent/book/new') }, '＋ 새 책 만들기')),
    rows.length ? rows : h('p', { class: 'muted' }, '아직 책이 없어요. "새 책 만들기"로 시작하세요.'),
  );
}

// =============== 책 편집 ===============
export async function renderBookEditor(root, bookId) {
  if (bookId === 'new') {
    const book = { id: uid(), title: '새 책', coverImageId: null, pages: [], createdAt: Date.now() };
    await saveBook(book);
    history.replaceState(null, '', `#/parent/book/${book.id}`);
    bookId = book.id;
  }
  const book = await db.get('books', bookId);
  if (!book) { go('#/parent'); return; }
  let busy = false;

  const save = async () => { await saveBook(book); };

  // ---- 입력 ----
  const titleInput = h('input', { class: 'input big', value: book.title, placeholder: '책 제목', onchange: async () => {
    book.title = titleInput.value.trim() || '제목 없음'; await save();
  } });
  const camInput = h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'hidden', onchange: (e) => addPhotos(e.target.files) });
  const albumInput = h('input', { type: 'file', accept: 'image/*', multiple: true, class: 'hidden', onchange: (e) => addPhotos(e.target.files) });
  const coverInput = h('input', { type: 'file', accept: 'image/*', class: 'hidden', onchange: (e) => setCover(e.target.files[0]) });
  const coverImg = h('div', { class: 'cover-slot', onclick: () => coverInput.click() });
  const pagesBox = h('div', { class: 'pages' });
  const ocrBtn = h('button', { class: 'btn primary', onclick: () => runOcr(book.pages.filter((p) => !(p.sentences || []).length)) });
  const progress = h('div', { class: 'progress-line hidden' });
  const quizBox = h('div', { class: 'quiz-admin' });

  async function renderCover() {
    const src = await imageURL(book.coverImageId);
    coverImg.replaceChildren(src ? h('img', { src, alt: '표지' }) : h('span', {}, '＋ 표지 사진'));
  }

  async function setCover(file) {
    if (!file) return;
    const blob = await normalizeImage(file);
    if (book.coverImageId) { forgetImageURL(book.coverImageId); await db.del('images', book.coverImageId); }
    book.coverImageId = await putImage(blob);
    await save(); renderCover();
    coverInput.value = '';
  }

  async function addPhotos(files) {
    const list = [...(files || [])];
    if (!list.length) return;
    toast(`사진 ${list.length}장을 추가하는 중…`);
    for (const f of list) {
      try {
        const blob = await normalizeImage(f);
        const imageId = await putImage(blob);
        book.pages.push({ id: uid(), imageId, sentences: [], otherText: [], quality: null });
      } catch (e) { toast(e.message, 'error'); }
    }
    camInput.value = ''; albumInput.value = '';
    await save();
    await renderPages();
  }

  function updateOcrBtn() {
    const n = book.pages.filter((p) => !(p.sentences || []).length).length;
    ocrBtn.textContent = n ? `🔤 글자 추출 (${n}페이지)` : '🔤 모두 추출됨';
    ocrBtn.disabled = !n || busy;
  }

  async function runOcr(targets) {
    if (!targets.length || busy) return;
    busy = true; updateOcrBtn();
    progress.classList.remove('hidden');
    let done = 0; let failed = 0;
    const update = () => { progress.textContent = `글자를 읽는 중… ${done}/${targets.length}${failed ? ` (실패 ${failed})` : ''}`; };
    update();
    const queue = [...targets];
    const worker = async () => {
      while (queue.length) {
        const p = queue.shift();
        try {
          const blob = await getImageBlob(p.imageId);
          const r = await ocrPage(blob);
          p.sentences = r.sentences; p.otherText = r.otherText; p.quality = r.quality;
          await save();
        } catch (e) {
          failed++;
          toast(e.message, 'error', 5000);
          if (/API 키|인터넷|모델/.test(e.message)) queue.length = 0;
        }
        done++; update();
      }
    };
    await Promise.all([worker(), worker()]);
    busy = false;
    progress.textContent = failed ? `완료 (실패 ${failed}페이지 — 다시 시도해 주세요)` : '✅ 글자 추출 완료! 아래에서 틀린 글자를 고쳐 주세요.';
    await renderPages();
    renderQuizAdmin();
  }

  async function renderPages() {
    updateOcrBtn();
    const cards = await Promise.all(book.pages.map(async (p, i) => {
      const src = await imageURL(p.imageId);
      const ta = h('textarea', { class: 'page-ta', lang: 'en', rows: Math.max(3, (p.sentences || []).length + 1),
        placeholder: '한 줄에 한 문장씩 입력해요', spellcheck: 'true' });
      ta.value = (p.sentences || []).join('\n');
      ta.addEventListener('change', async () => { p.sentences = linesToSentences(ta.value); await save(); updateOcrBtn(); renderQuizAdmin(); });
      const move = async (d) => {
        const j = i + d; if (j < 0 || j >= book.pages.length) return;
        [book.pages[i], book.pages[j]] = [book.pages[j], book.pages[i]];
        await save(); renderPages(); renderQuizAdmin();
      };
      const warn = p.quality === 'blurry' ? h('div', { class: 'warn' }, '⚠️ 사진이 흐려요. 다시 찍는 걸 권해요.')
        : p.quality === 'no_text' ? h('div', { class: 'small muted' }, '이 페이지에는 글이 없어요.') : null;
      return h('div', { class: 'page-card' },
        h('div', { class: 'page-left' },
          h('div', { class: 'page-num' }, `${i + 1}쪽`),
          h('img', { src, alt: '', class: 'page-thumb', onclick: () => modal(h('img', { src, class: 'zoom-img' }), { wide: true }) }),
          h('div', { class: 'row tight' },
            h('button', { class: 'mini', onclick: () => move(-1), disabled: i === 0, 'aria-label': '앞으로' }, '◀'),
            h('button', { class: 'mini', onclick: () => move(1), disabled: i === book.pages.length - 1, 'aria-label': '뒤로' }, '▶'),
            h('button', { class: 'mini', 'aria-label': '회전', onclick: async () => {
              const blob = await rotateImage(await getImageBlob(p.imageId));
              forgetImageURL(p.imageId); await db.put('images', { id: p.imageId, blob }); renderPages();
            } }, '⟳'),
            h('button', { class: 'mini danger-text', 'aria-label': '페이지 삭제', onclick: async () => {
              if (!(await confirmBox(`${i + 1}쪽을 삭제할까요?`, '삭제', true))) return;
              book.pages.splice(i, 1); forgetImageURL(p.imageId); await db.del('images', p.imageId);
              await save(); renderPages(); renderQuizAdmin();
            } }, '🗑'),
          )),
        h('div', { class: 'page-right' },
          ta,
          warn,
          p.otherText?.length ? h('div', { class: 'small muted' }, `제외한 글자: ${p.otherText.join(' · ')}`) : null,
          h('div', { class: 'row tight' },
            h('button', { class: 'btn ghost small', onclick: () => runOcr([p]) }, '🔤 다시 추출'),
            h('button', { class: 'btn ghost small', onclick: async () => {
              ta.value = splitSentences(ta.value).join('\n');
              p.sentences = linesToSentences(ta.value); await save(); updateOcrBtn();
            } }, '✂️ 문장 나누기'),
            h('button', { class: 'btn ghost small', onclick: () => {
              const sents = linesToSentences(ta.value);
              if (sents.length) speech.speak({ text: sents.join(' '), lang: 'en-US' });
            } }, '🔊 들어보기')),
        ),
      );
    }));
    pagesBox.replaceChildren(...(cards.length ? cards : [h('p', { class: 'muted' }, '아직 페이지가 없어요. 위의 버튼으로 책 페이지를 찍어 주세요.')]));
  }

  function renderQuizAdmin() {
    const hasText = bookSentences(book).length > 0;
    const fresh = book.quiz && book.quiz.textHash === bookTextHash(book);
    const sentMap = Object.fromEntries(bookSentences(book).map((s) => [s.id, s]));
    const genBtn = h('button', { class: 'btn primary', disabled: !hasText || busy, onclick: async () => {
      busy = true; genBtn.disabled = true; genBtn.textContent = '퀴즈 만드는 중…';
      try {
        const questions = await generateQuiz(book);
        book.quiz = { questions, textHash: bookTextHash(book), createdAt: Date.now() };
        await save(); toast('퀴즈를 만들었어요!', 'good');
      } catch (e) { toast(e.message, 'error', 5000); }
      busy = false; renderQuizAdmin(); renderPages();
    } }, book.quiz ? '🔄 퀴즈 다시 만들기' : '✏️ 퀴즈 만들기');

    const list = fresh ? book.quiz.questions.map((q, i) => h('div', { class: 'qa' },
      h('div', { class: 'row between' },
        h('b', { lang: 'en' }, `${i + 1}. ${q.question_en}`),
        h('button', { class: 'mini danger-text', 'aria-label': '문제 삭제', onclick: async () => {
          book.quiz.questions.splice(i, 1);
          book.quiz.questions.forEach((x, k) => { x.id = `q${k + 1}`; });
          await save(); renderQuizAdmin();
        } }, '🗑')),
      h('div', { class: 'small muted' }, q.question_ko),
      h('ol', { class: 'qa-opts', type: 'A' }, q.options.map((o, k) => h('li', { class: k === q.answer_index ? 'answer' : '' }, o, k === q.answer_index ? ' ✔' : ''))),
      h('div', { class: 'small' }, '💬 ', q.explanation_ko),
      h('div', { class: 'small muted', lang: 'en' }, '📖 ', q.evidence_sentence_ids.map((id) => sentMap[id] ? `(${sentMap[id].page + 1}쪽) ${sentMap[id].text}` : id).join(' / ')),
    )) : [];

    mount(quizBox, 
      h('div', { class: 'row between' }, h('h2', {}, '퀴즈'), genBtn),
      !hasText ? h('p', { class: 'muted' }, '먼저 글자를 추출해 주세요.')
        : book.quiz && !fresh ? h('p', { class: 'warn' }, '책 글자가 바뀌었어요. 퀴즈를 다시 만들어 주세요. (아이가 퀴즈를 열면 자동으로 다시 만들어요)')
          : !book.quiz ? h('p', { class: 'muted' }, '퀴즈를 미리 만들어 두면 아이가 기다리지 않아요.') : null,
      list,
    );
  }

  await renderCover();
  shell(root, 'books',
    h('div', { class: 'row between' },
      h('button', { class: 'btn ghost', onclick: () => go('#/parent') }, '◀ 책 목록'),
      h('button', { class: 'btn ghost', onclick: () => go(`#/read/${book.id}/0`) }, '아이 화면에서 보기 ▶')),
    h('div', { class: 'editor-head' },
      coverImg, coverInput,
      h('div', { class: 'grow' },
        h('label', { class: 'small muted' }, '책 제목'), titleInput,
        h('div', { class: 'row wrap' },
          h('button', { class: 'btn primary', onclick: () => camInput.click() }, '📷 카메라로 찍기'),
          h('button', { class: 'btn ghost', onclick: () => albumInput.click() }, '🖼 앨범에서 고르기 (여러 장)'),
          ocrBtn),
        camInput, albumInput,
        progress,
        h('p', { class: 'small muted' }, '팁: 밝은 곳에서 책을 평평하게 펴고, 한 번에 한 페이지씩 찍어 주세요. 페이지 순서는 ◀ ▶로 바꿀 수 있어요.'),
      )),
    h('h2', {}, '페이지'),
    pagesBox,
    quizBox,
  );
  await renderPages();
  renderQuizAdmin();
}

// =============== 학습 기록 ===============
export async function renderRecords(root) {
  const books = await listBooks();
  const name = Object.fromEntries(books.map((b) => [b.id, b.title]));
  const attempts = (await db.all('attempts')).sort((a, b) => b.date - a.date);
  const reads = (await db.all('reads')).sort((a, b) => b.date - a.date);

  const perBook = books.map((b) => {
    const r = reads.filter((x) => x.bookId === b.id);
    const a = attempts.filter((x) => x.bookId === b.id && x.mode !== 'retry');
    const best = a.reduce((m, x) => Math.max(m, x.total ? x.score / x.total : 0), -1);
    return { b, reads: r.length, finished: r.filter((x) => x.finished).length, last: r[0]?.date, quizzes: a.length, best };
  }).filter((x) => x.reads || x.quizzes);

  const wordCount = {};
  reads.forEach((r) => (r.tappedWords || []).forEach((w) => { if (w) wordCount[w] = (wordCount[w] || 0) + 1; }));
  const topWords = Object.entries(wordCount).sort((a, b) => b[1] - a[1]).slice(0, 20);

  const wrongCount = {};
  attempts.forEach((a) => a.answers.filter((x) => !x.correct).forEach((x) => {
    const k = `${a.bookId}|${x.question}`;
    wrongCount[k] = wrongCount[k] || { book: name[a.bookId] || '(삭제된 책)', q: x.question, answer: x.answer, n: 0 };
    wrongCount[k].n++;
  }));
  const topWrong = Object.values(wrongCount).sort((a, b) => b.n - a.n).slice(0, 10);

  const days = new Set(reads.filter((r) => Date.now() - r.date < 7 * 864e5).map((r) => new Date(r.date).toDateString()));

  shell(root, 'records',
    h('div', { class: 'stats' },
      h('div', { class: 'stat' }, h('b', {}, String(days.size)), h('span', {}, '최근 7일 중 읽은 날')),
      h('div', { class: 'stat' }, h('b', {}, String(reads.filter((r) => r.finished).length)), h('span', {}, '끝까지 읽은 횟수')),
      h('div', { class: 'stat' }, h('b', {}, String(attempts.length)), h('span', {}, '퀴즈 푼 횟수')),
    ),
    h('h2', {}, '책별 기록'),
    perBook.length ? h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, ['책', '읽은 횟수', '끝까지', '마지막', '퀴즈', '최고 점수'].map((t) => h('th', {}, t)))),
      h('tbody', {}, perBook.map((x) => h('tr', {},
        h('td', {}, x.b.title), h('td', {}, x.reads), h('td', {}, x.finished),
        h('td', {}, x.last ? fmtDate(x.last) : '-'), h('td', {}, x.quizzes),
        h('td', {}, x.best >= 0 ? `${Math.round(x.best * 100)}%` : '-'))))) : h('p', { class: 'muted' }, '아직 기록이 없어요.'),
    h('h2', {}, '최근 퀴즈'),
    attempts.length ? attempts.slice(0, 15).map((a) => h('details', { class: 'attempt' },
      h('summary', {}, `${fmtDate(a.date)} · ${name[a.bookId] || '(삭제된 책)'} · ${a.score}/${a.total}${a.mode === 'retry' ? ' (오답 다시 풀기)' : ''}`),
      h('ul', {}, a.answers.map((x) => h('li', { class: x.correct ? 'ok' : 'ng' },
        x.correct ? '⭕ ' : '❌ ', h('span', { lang: 'en' }, x.question), x.correct ? '' : ` — 고른 답: ${x.chosen} / 정답: ${x.answer}`))),
    )) : h('p', { class: 'muted' }, '아직 푼 퀴즈가 없어요.'),
    h('h2', {}, '자주 틀린 문제'),
    topWrong.length ? h('ul', {}, topWrong.map((w) => h('li', {}, `${w.n}회 · ${w.book} · `, h('span', { lang: 'en' }, w.q), ` (정답: ${w.answer})`))) : h('p', { class: 'muted' }, '없어요 👍'),
    h('h2', {}, '많이 눌러 본 단어'),
    topWords.length ? h('div', { class: 'chips' }, topWords.map(([w, n]) => h('button', { class: 'chip', lang: 'en', onclick: () => speech.speak({ text: w }) }, `${w} `, h('small', {}, n)))) : h('p', { class: 'muted' }, '아직 없어요.'),
  );
}

// =============== 설정 ===============
export async function renderSettings(root) {
  const s = await getSettings();
  await speech.loadVoices();

  const field = (label, control, help) => h('div', { class: 'field' }, h('label', {}, label), control, help ? h('div', { class: 'small muted' }, help) : null);
  const select = (key, options, onChange) => {
    const parse = (v) => (key === 'rate' ? Number(v) : key === 'autoPageTurn' ? v === 'true' : v);
    const el = h('select', { class: 'input', onchange: async () => { await saveSettings({ [key]: parse(el.value) }); onChange && onChange(); } },
      options.map(([v, t]) => h('option', { value: v, selected: String(s[key]) === String(v) }, t)));
    return el;
  };

  const keyInput = h('input', { class: 'input', type: 'password', value: s.apiKey, placeholder: 'sk-ant-…', autocomplete: 'off',
    onchange: () => saveSettings({ apiKey: keyInput.value.trim() }) });
  const keyStatus = h('span', { class: 'small' });
  const testBtn = h('button', { class: 'btn ghost', onclick: async () => {
    await saveSettings({ apiKey: keyInput.value.trim() });
    keyStatus.textContent = '확인 중…';
    try { await testConnection(); keyStatus.textContent = '✅ 연결 성공'; } catch (e) { keyStatus.textContent = `❌ ${e.message}`; }
  } }, '연결 확인');

  const enVoiceBox = h('div');
  const renderEnVoices = async () => {
    const cur = await getSettings();
    const vs = speech.voicesFor(cur.accent);
    const sel = h('select', { class: 'input', onchange: () => saveSettings({ voiceURI: sel.value }) },
      h('option', { value: '' }, '자동 (가장 좋은 음성)'),
      vs.map((v) => h('option', { value: v.voiceURI, selected: v.voiceURI === cur.voiceURI }, `${v.name} (${v.lang})`)));
    enVoiceBox.replaceChildren(h('div', { class: 'row' }, sel,
      h('button', { class: 'btn ghost', onclick: async () => {
        const c = await getSettings();
        speech.speak({ text: 'Once upon a time, there was a little bear who loved honey.', lang: c.accent, voiceURI: c.voiceURI, rate: c.rate });
      } }, '🔊 미리 듣기')));
  };
  const koVs = speech.voicesFor('ko');
  const koSel = h('select', { class: 'input', onchange: () => saveSettings({ koVoiceURI: koSel.value }) },
    h('option', { value: '' }, '자동'),
    koVs.map((v) => h('option', { value: v.voiceURI, selected: v.voiceURI === s.koVoiceURI }, `${v.name}`)));

  const importInput = h('input', { type: 'file', accept: 'application/json,.json', class: 'hidden', onchange: async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { await importAll(JSON.parse(await f.text())); toast('백업을 불러왔어요.', 'good'); } catch (err) { toast(err.message, 'error'); }
    importInput.value = '';
  } });

  shell(root, 'settings',
    h('section', { class: 'card' },
      h('h2', {}, '🤖 Claude API'),
      field('API 키', h('div', { class: 'row' }, keyInput, testBtn), h('span', {}, '글자 추출·퀴즈·단어 뜻에 쓰여요. 키는 이 iPad 안에만 저장돼요. ', keyStatus)),
      field('모델', select('model', MODELS)),
    ),
    h('section', { class: 'card' },
      h('h2', {}, '🔊 읽어 주기'),
      field('영어 억양', select('accent', [['en-US', '미국식'], ['en-GB', '영국식'], ['en-AU', '호주식']], async () => { await saveSettings({ voiceURI: '' }); renderEnVoices(); })),
      field('영어 음성', enVoiceBox, '더 자연스러운 음성: iPad 설정 › 손쉬운 사용 › 읽기 및 말하기 › 음성 › 영어에서 "향상된/프리미엄" 음성을 내려받은 뒤 이 앱을 다시 열어 주세요.'),
      field('한국어 음성 (해설)', koSel),
      field('기본 속도', select('rate', [[0.5, '0.5x 아주 천천히'], [0.75, '0.75x 천천히'], [1, '1.0x 보통'], [1.25, '1.25x 빠르게']])),
      field('자동 페이지 넘김', select('autoPageTurn', [[false, '끄기'], [true, '켜기 (다 읽으면 다음 페이지로)']]),
        '켜면 ▶ 버튼으로 책 전체를 이어서 읽어 줘요.'),
    ),
    h('section', { class: 'card' },
      h('h2', {}, '✏️ 퀴즈'),
      field('해설 말투', select('tone', [['banmal', '반말 (~했어)'], ['jondaetmal', '존댓말 (~했어요)']])),
      field('난이도', select('difficulty', [['easy', '쉬움 (내용 기억)'], ['normal', '보통 (간단한 추론 포함)']])),
      field('문제 수', select('questionCount', [['auto', '책 길이에 맞춰 자동 (3~5)'], ['3', '3문제'], ['5', '5문제']])),
      h('p', { class: 'small muted' }, '말투·난이도를 바꾼 뒤에는 책 편집에서 "퀴즈 다시 만들기"를 눌러 주세요.'),
    ),
    h('section', { class: 'card' },
      h('h2', {}, '💾 백업'),
      h('p', { class: 'small muted' }, '책과 기록은 이 iPad의 앱 저장소에만 있어요. 가끔 백업 파일을 저장해 두세요. (API 키는 백업에 포함되지 않아요)'),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn ghost', onclick: async () => {
          const data = await exportAll();
          const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
          const a = h('a', { href: URL.createObjectURL(blob), download: `gyeol-reader-backup-${new Date().toISOString().slice(0, 10)}.json` });
          document.body.append(a); a.click(); a.remove();
        } }, '⬇️ 백업 파일 저장'),
        h('button', { class: 'btn ghost', onclick: () => importInput.click() }, '⬆️ 백업 불러오기'),
        importInput),
    ),
  );
  renderEnVoices();
}
