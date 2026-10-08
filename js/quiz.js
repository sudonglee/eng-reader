import { h, mount } from './ui.js';
import { db, uid, getSettings, saveBook } from './db.js';
import { bookSentences, bookTextHash } from './text.js';
import { generateQuiz } from './claude.js';
import * as speech from './speech.js';
import { go } from './main.js';

const PRAISE_EN = ['Great job!', 'Awesome!', 'You got it!', 'Wonderful!', 'Super!'];
const TRY_EN = ['Nice try!', "That's okay!", 'Good try!'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];

export async function ensureQuiz(book) {
  const hash = bookTextHash(book);
  if (book.quiz && book.quiz.textHash === hash && book.quiz.questions?.length) return book.quiz;
  const questions = await generateQuiz(book);
  book.quiz = { questions, textHash: hash, createdAt: Date.now() };
  await saveBook(book);
  return book.quiz;
}

export async function renderQuiz(root, bookId) {
  const book = await db.get('books', bookId);
  if (!book) { go('#/'); return; }
  const settings = await getSettings();
  await speech.loadVoices();
  const sentMap = Object.fromEntries(bookSentences(book).map((s) => [s.id, s]));
  const polite = settings.tone === 'jondaetmal';

  const header = h('header', { class: 'topbar kid' },
    h('button', { class: 'icon-btn', onclick: () => { speech.stop(); go('#/'); }, 'aria-label': '책장으로' }, '🏠'),
    h('h1', { class: 'book-h' }, `✏️ ${book.title}`),
    h('span', {}),
  );
  const main = h('main', { class: 'quiz' });
  mount(root, header, main);

  // 퀴즈 준비
  let quiz;
  try {
    if (!(book.quiz && book.quiz.textHash === bookTextHash(book))) {
      main.replaceChildren(h('div', { class: 'loading' }, h('div', { class: 'spinner' }), h('p', {}, '퀴즈를 만들고 있어요…')));
    }
    quiz = await ensureQuiz(book);
  } catch (e) {
    main.replaceChildren(h('div', { class: 'empty' },
      h('div', { class: 'empty-emoji' }, '🙈'),
      h('p', {}, '퀴즈를 준비하지 못했어요.'),
      h('p', { class: 'muted small' }, e.message),
      h('button', { class: 'btn primary big', onclick: () => go(`#/quiz/${bookId}`) }, '다시 시도'),
      h('button', { class: 'btn ghost', onclick: () => go(`#/read/${bookId}/0`) }, '책으로 돌아가기'),
    ));
    return;
  }

  const sayEn = (text) => speech.speak({ text, lang: settings.accent, voiceURI: settings.voiceURI, rate: Math.min(settings.rate || 1, 1) });
  const sayKo = (text) => speech.speakKo(text, settings.koVoiceURI);
  const spoken = (q) => q.question_en.replace(/_{2,}/g, 'blank');

  function start(questions, mode) {
    let idx = 0;
    const results = []; // {q, chosen, correct}

    async function showQuestion() {
      const q = questions[idx];
      let answered = false;
      const koHint = h('p', { class: 'q-ko hidden' }, q.question_ko);
      const explainBox = h('div', { class: 'explain hidden' });
      const optBtns = q.options.map((opt, i) => {
        const label = q.type === 'true_false'
          ? (i === 0 ? ['⭕ ', h('span', {}, 'True'), h('small', {}, ' 맞아요')] : ['❌ ', h('span', {}, 'False'), h('small', {}, ' 아니에요')])
          : [h('span', { class: 'opt-letter' }, 'ABCD'[i]), h('span', { lang: 'en' }, opt)];
        const btn = h('button', { class: 'opt', onclick: () => choose(i) }, label);
        const say = h('button', { class: 'opt-say', onclick: (e) => { e.stopPropagation(); sayEn(opt); }, 'aria-label': '보기 듣기' }, '🔊');
        return { row: h('div', { class: 'opt-row' }, btn, say), btn };
      });

      async function choose(i) {
        if (answered) return;
        answered = true;
        const correct = i === q.answer_index;
        results.push({ q, chosen: i, correct });
        optBtns.forEach((o, j) => {
          o.btn.disabled = true;
          if (j === q.answer_index) o.btn.classList.add('correct');
          else if (j === i) o.btn.classList.add('wrong');
        });
        speech.chime(correct ? 'good' : 'bad');
        const evid = q.evidence_sentence_ids.map((id) => sentMap[id]).filter(Boolean);
        mount(explainBox, 
          h('div', { class: `verdict ${correct ? 'good' : 'bad'}` },
            correct ? `🎉 ${polite ? '정답이에요!' : '정답이야!'}` : `💪 ${polite ? '아쉬워요! 정답은 초록색이에요.' : '아쉬워! 정답은 초록색이야.'}`),
          h('div', { class: 'explain-ko' },
            h('p', {}, q.explanation_ko),
            h('button', { class: 'btn ghost small', onclick: () => sayKo(q.explanation_ko) }, '🔊 해설 듣기')),
          evid.length ? h('div', { class: 'evidence' },
            h('div', { class: 'small muted' }, `📖 책에서 찾았어요 (${evid.map((e) => `${e.page + 1}쪽`).filter((v, k, a) => a.indexOf(v) === k).join(', ')})`),
            evid.map((e) => h('button', { class: 'evidence-sent', lang: 'en', onclick: () => sayEn(e.text) }, '🔊 ', e.text))) : null,
          h('div', { class: 'row end' },
            h('button', { class: 'btn primary big', onclick: next }, idx + 1 < questions.length ? '다음 문제 ▶' : '결과 보기 🏆')),
        );
        explainBox.classList.remove('hidden');
        explainBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        await sayEn(correct ? pick(PRAISE_EN) : pick(TRY_EN));
        await new Promise((r) => setTimeout(r, 250));
        if (answered && results.length === idx + 1) sayKo(q.explanation_ko);
      }

      function next() {
        speech.stop();
        idx++;
        if (idx < questions.length) showQuestion();
        else showResult();
      }

      main.replaceChildren(
        h('div', { class: 'progress' }, questions.map((_, k) =>
          h('span', { class: `dot ${k < idx ? (results[k]?.correct ? 'good' : 'bad') : k === idx ? 'now' : ''}` }))),
        h('div', { class: 'q-card' },
          h('div', { class: 'q-num' }, `${idx + 1}번 문제${mode === 'retry' ? ' (다시 풀기)' : ''}`),
          h('div', { class: 'q-text', lang: 'en' }, q.question_en),
          h('div', { class: 'row' },
            h('button', { class: 'btn ghost small', onclick: () => sayEn(spoken(q)) }, '🔊 다시 듣기'),
            q.question_ko ? h('button', { class: 'btn ghost small', onclick: () => koHint.classList.toggle('hidden') }, '🇰🇷 한글로 보기') : null),
          koHint,
        ),
        h('div', { class: 'opts' }, optBtns.map((o) => o.row)),
        explainBox,
      );
      main.scrollTop = 0;
      window.scrollTo(0, 0);
      setTimeout(() => sayEn(spoken(q)), 300);
    }

    async function showResult() {
      const score = results.filter((r) => r.correct).length;
      const total = results.length;
      const ratio = total ? score / total : 0;
      const stars = ratio >= 1 ? 3 : ratio >= 0.6 ? 2 : 1;
      await db.put('attempts', {
        id: uid(), bookId, date: Date.now(), mode, score, total,
        answers: results.map((r) => ({ qid: r.q.id, question: r.q.question_en, chosen: r.q.options[r.chosen], answer: r.q.options[r.q.answer_index], correct: r.correct })),
      });
      const wrong = results.filter((r) => !r.correct).map((r) => r.q);
      const msgKo = ratio >= 1
        ? (polite ? '모두 맞혔어요! 정말 대단해요!' : '다 맞혔어! 정말 대단해!')
        : ratio >= 0.6
          ? (polite ? '아주 잘했어요! 틀린 문제도 다시 해 볼까요?' : '아주 잘했어! 틀린 문제도 다시 해 볼까?')
          : (polite ? '잘했어요! 책을 한 번 더 읽고 다시 풀어 봐요.' : '잘했어! 책을 한 번 더 읽고 다시 풀어 보자.');
      main.replaceChildren(h('div', { class: 'result' },
        h('div', { class: 'big-stars' }, [0, 1, 2].map((i) => h('span', { class: i < stars ? 'on' : '' }, '★'))),
        h('div', { class: 'score' }, `${total}문제 중 ${score}개 맞혔어요`),
        h('p', { class: 'result-msg' }, msgKo),
        h('div', { class: 'col' },
          wrong.length ? h('button', { class: 'btn primary big', onclick: () => start(wrong, 'retry') }, `틀린 문제 다시 풀기 (${wrong.length})`) : null,
          h('button', { class: `btn ${wrong.length ? 'ghost' : 'primary'} big`, onclick: () => start(quiz.questions, 'full') }, '처음부터 다시 풀기'),
          h('button', { class: 'btn ghost', onclick: () => go(`#/read/${bookId}/0`) }, '📖 책 다시 읽기'),
          h('button', { class: 'btn ghost', onclick: () => go('#/') }, '🏠 책장으로'),
        ),
      ));
      if (ratio >= 0.6) speech.chime('good');
      await sayEn(ratio >= 1 ? 'Perfect! Amazing!' : ratio >= 0.6 ? 'Great job!' : 'Good try!');
      sayKo(msgKo);
    }

    showQuestion();
  }

  // 시작 화면
  main.replaceChildren(h('div', { class: 'quiz-start' },
    h('div', { class: 'empty-emoji' }, '✏️'),
    h('h2', {}, polite ? '책 내용을 얼마나 기억하는지 알아봐요!' : '책 내용을 얼마나 기억하는지 알아보자!'),
    h('p', { class: 'muted' }, `${quiz.questions.length}문제`),
    h('button', { class: 'btn primary big', onclick: () => start(quiz.questions, 'full') }, '시작하기 ▶'),
  ));

  return () => speech.stop();
}
