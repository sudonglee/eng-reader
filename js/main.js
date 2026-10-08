import { h, modal, toast } from './ui.js';
import { renderShelf } from './shelf.js';
import { renderReader } from './reader.js';
import { renderQuiz } from './quiz.js';
import { renderBooks, renderBookEditor, renderRecords, renderSettings } from './parent.js';
import * as speech from './speech.js';

const root = document.getElementById('app');
let parentUnlocked = false;
let cleanup = null;

export function go(hash, { lock = false } = {}) {
  if (lock) parentUnlocked = false;
  if (location.hash === hash) route();
  else location.hash = hash;
}

// 부모 모드 잠금: 아이가 풀기 어려운 곱셈 문제
export function requestParent(target) {
  if (parentUnlocked) { go(target); return; }
  const a = 6 + Math.floor(Math.random() * 4);
  const b = 6 + Math.floor(Math.random() * 4);
  const input = h('input', { class: 'input big center', type: 'text', inputmode: 'numeric', pattern: '[0-9]*', autocomplete: 'off', 'aria-label': '정답' });
  const err = h('p', { class: 'small danger-text' });
  const submit = () => {
    if (Number(input.value) === a * b) { parentUnlocked = true; m.close(); go(target); }
    else { err.textContent = '다시 확인해 주세요.'; input.value = ''; input.focus(); }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  const m = modal(h('div', { class: 'lock' },
    h('h2', {}, '🔒 부모 확인'),
    h('p', {}, `${a} × ${b} = ?`),
    input, err,
    h('div', { class: 'row end' },
      h('button', { class: 'btn ghost', onclick: () => m.close() }, '취소'),
      h('button', { class: 'btn primary', onclick: submit }, '확인')),
  ));
  setTimeout(() => input.focus(), 50);
}

async function route() {
  if (cleanup) { try { cleanup(); } catch (_) {} cleanup = null; }
  speech.stop();
  const parts = (location.hash.replace(/^#\/?/, '') || '').split('/').filter(Boolean);
  window.scrollTo(0, 0);
  try {
    if (parts[0] === 'read') cleanup = await renderReader(root, parts[1], parts[2]);
    else if (parts[0] === 'quiz') cleanup = await renderQuiz(root, parts[1]);
    else if (parts[0] === 'parent') {
      if (!parentUnlocked) { location.hash = '#/'; requestParent('#/' + parts.join('/')); return; }
      if (parts[1] === 'book') await renderBookEditor(root, parts[2]);
      else if (parts[1] === 'records') await renderRecords(root);
      else if (parts[1] === 'settings') await renderSettings(root);
      else await renderBooks(root);
    } else await renderShelf(root);
  } catch (e) {
    console.error(e);
    toast(`문제가 생겼어요: ${e.message}`, 'error', 6000);
  }
  document.body.dataset.mode = parts[0] === 'parent' ? 'parent' : 'kid';
}

window.addEventListener('hashchange', route);
route();
speech.loadVoices();
document.addEventListener('pointerdown', speech.unlock, { once: true, capture: true });

// 오프라인 사용을 위한 서비스 워커 + 저장소 보존 요청
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
