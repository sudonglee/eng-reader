// 작은 DOM 헬퍼
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function mount(root, ...children) {
  root.replaceChildren();
  append(root, children);
}

export function toast(msg, kind = 'info', ms = 3200) {
  let box = document.getElementById('toasts');
  if (!box) { box = h('div', { id: 'toasts' }); document.body.append(box); }
  const t = h('div', { class: `toast ${kind}`, role: 'status' }, msg);
  box.append(t);
  setTimeout(() => t.classList.add('out'), ms);
  setTimeout(() => t.remove(), ms + 400);
}

export function modal(content, { onClose, wide = false } = {}) {
  const close = () => { back.remove(); onClose && onClose(); };
  const panel = h('div', { class: `modal ${wide ? 'wide' : ''}`, role: 'dialog' }, content);
  const back = h('div', { class: 'modal-back', onclick: (e) => { if (e.target === back) close(); } }, panel);
  document.body.append(back);
  return { close, panel };
}

// 브라우저 confirm()은 PWA 전체 화면에서 어색하므로 직접 만든 확인 창 사용
export function confirmBox(message, okLabel = '확인', danger = false) {
  return new Promise((resolve) => {
    let m;
    const done = (v) => { m.close(); resolve(v); };
    m = modal(h('div', {},
      h('p', { class: 'confirm-msg' }, message),
      h('div', { class: 'row end' },
        h('button', { class: 'btn ghost', onclick: () => done(false) }, '취소'),
        h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => done(true) }, okLabel),
      ),
    ), { onClose: () => resolve(false) });
  });
}

export function longPress(el, onLong, onTap, ms = 500) {
  let timer = null; let fired = false; let sx = 0; let sy = 0;
  el.addEventListener('pointerdown', (e) => {
    fired = false; sx = e.clientX; sy = e.clientY;
    timer = setTimeout(() => { fired = true; onLong(e); }, ms);
  });
  const cancel = () => { clearTimeout(timer); timer = null; };
  el.addEventListener('pointermove', (e) => {
    if (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10) cancel();
  });
  el.addEventListener('pointerup', (e) => {
    const wasPending = timer !== null;
    cancel();
    if (!fired && wasPending) onTap(e);
  });
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}

export const fmtDate = (t) => {
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
