// 문장·단어 처리

// 편집기 텍스트(한 줄 = 한 문장) → 문장 배열
export function linesToSentences(text) {
  return text
    .split(/\n+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

// 문단 텍스트 → 문장 배열 (마침표/물음표/느낌표 + 따옴표 뒤에서 분리)
export function splitSentences(text) {
  const clean = text.replace(/-\n(?=[a-z])/g, '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const re = /[^.!?]+(?:[.!?]+["'”’)]*|$)/g;
  const out = [];
  for (const m of clean.match(re) || []) {
    const s = m.trim();
    if (!s) continue;
    // '"Woof!" said Max.' 처럼 소문자로 이어지면 앞 문장과 합침
    if (out.length && /^[a-z]/.test(s)) out[out.length - 1] += ' ' + s;
    else out.push(s);
  }
  return out;
}

// 문장 → 단어 토큰 [{text, speak, start, end}]
export function tokenize(sentence) {
  const out = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(sentence))) {
    const raw = m[0];
    out.push({ text: raw, speak: cleanWord(raw), start: m.index, end: m.index + raw.length });
  }
  return out;
}

export function cleanWord(w) {
  return w
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/[^A-Za-z0-9]+$/, '');
}

export function hashText(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

// 책 전체 문장에 ID 부여: p{페이지}_s{문장} (1부터)
export function bookSentences(book) {
  const out = [];
  book.pages.forEach((p, pi) => {
    (p.sentences || []).forEach((s, si) => {
      out.push({ id: `p${pi + 1}_s${si + 1}`, page: pi, index: si, text: s });
    });
  });
  return out;
}

export function bookTextHash(book) {
  return hashText(bookSentences(book).map((s) => s.text).join('\n'));
}
