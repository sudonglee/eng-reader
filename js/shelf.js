import { h, mount } from './ui.js';
import { listBooks, imageURL, db } from './db.js';
import { go, requestParent } from './main.js';

export async function renderShelf(root) {
  const books = (await listBooks()).filter((b) => b.pages.some((p) => (p.sentences || []).length));
  const attempts = await db.all('attempts');
  const best = {};
  for (const a of attempts) {
    const r = a.total ? a.score / a.total : 0;
    best[a.bookId] = Math.max(best[a.bookId] || 0, r);
  }

  const cards = await Promise.all(books.map(async (b) => {
    const src = await imageURL(b.coverImageId || b.pages[0]?.imageId);
    const stars = best[b.id] === undefined ? 0 : best[b.id] >= 1 ? 3 : best[b.id] >= 0.6 ? 2 : 1;
    return h('button', { class: 'book-card', onclick: () => go(`#/read/${b.id}/0`), 'aria-label': b.title },
      h('div', { class: 'cover' }, src ? h('img', { src, alt: '' }) : h('span', { class: 'cover-ph' }, '📖')),
      h('div', { class: 'book-title' }, b.title),
      h('div', { class: 'stars', 'aria-label': `별 ${stars}개` },
        [0, 1, 2].map((i) => h('span', { class: i < stars ? 'on' : '' }, '★'))),
    );
  }));

  mount(root,
    h('header', { class: 'topbar kid' },
      h('h1', {}, '📚 결이의 책장'),
      h('button', { class: 'icon-btn', onclick: () => requestParent('#/parent'), 'aria-label': '부모 모드' }, '🔒'),
    ),
    books.length
      ? h('main', { class: 'shelf' }, cards)
      : h('main', { class: 'empty' },
        h('div', { class: 'empty-emoji' }, '📖'),
        h('p', {}, '아직 책이 없어요.'),
        h('p', { class: 'muted' }, '엄마·아빠가 부모 모드에서 책을 만들어 주세요.'),
        h('button', { class: 'btn primary big', onclick: () => requestParent('#/parent/book/new') }, '책 만들기 (부모)'),
      ),
  );
}
