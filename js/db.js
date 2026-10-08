// IndexedDB 저장소: books, images, attempts, reads, kv
const DB_NAME = 'gyeol-reader';
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('images')) db.createObjectStore('images', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('attempts')) {
        const s = db.createObjectStore('attempts', { keyPath: 'id' });
        s.createIndex('bookId', 'bookId');
      }
      if (!db.objectStoreNames.contains('reads')) {
        const s = db.createObjectStore('reads', { keyPath: 'id' });
        s.createIndex('bookId', 'bookId');
      }
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name, mode = 'readonly') {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

export const uid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export const db = {
  async get(name, key) { return wrap((await store(name)).get(key)); },
  async all(name) { return wrap((await store(name)).getAll()); },
  async put(name, value, key) {
    const s = await store(name, 'readwrite');
    return wrap(key === undefined ? s.put(value) : s.put(value, key));
  },
  async del(name, key) { return wrap((await store(name, 'readwrite')).delete(key)); },
  async byIndex(name, index, value) {
    return wrap((await store(name)).index(index).getAll(value));
  },
  async clear(name) { return wrap((await store(name, 'readwrite')).clear()); },
};

// ---- 설정 ----
export const DEFAULT_SETTINGS = {
  apiKey: '',
  model: 'claude-sonnet-5-5',
  accent: 'en-US',
  voiceURI: '',
  koVoiceURI: '',
  rate: 1,
  tone: 'banmal', // banmal | jondaetmal
  difficulty: 'easy', // easy | normal
  questionCount: 'auto', // auto | 3 | 5
  autoPageTurn: false,
};

let settingsCache = null;
export async function getSettings() {
  if (settingsCache) return settingsCache;
  const saved = (await db.get('kv', 'settings')) || {};
  settingsCache = { ...DEFAULT_SETTINGS, ...saved };
  return settingsCache;
}
export async function saveSettings(patch) {
  const s = { ...(await getSettings()), ...patch };
  settingsCache = s;
  await db.put('kv', s, 'settings');
  return s;
}

// ---- 책 ----
export async function listBooks() {
  const books = await db.all('books');
  return books.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}
export async function saveBook(book) {
  book.updatedAt = Date.now();
  await db.put('books', book);
  return book;
}
export async function deleteBook(book) {
  const ids = [book.coverImageId, ...book.pages.map((p) => p.imageId)].filter(Boolean);
  for (const id of ids) await db.del('images', id);
  for (const a of await db.byIndex('attempts', 'bookId', book.id)) await db.del('attempts', a.id);
  for (const r of await db.byIndex('reads', 'bookId', book.id)) await db.del('reads', r.id);
  await db.del('books', book.id);
}

// ---- 이미지 ----
const urlCache = new Map();
export async function putImage(blob) {
  const id = uid();
  await db.put('images', { id, blob });
  return id;
}
export async function getImageBlob(id) {
  const rec = id && (await db.get('images', id));
  return rec ? rec.blob : null;
}
export async function imageURL(id) {
  if (!id) return '';
  if (urlCache.has(id)) return urlCache.get(id);
  const blob = await getImageBlob(id);
  if (!blob) return '';
  const url = URL.createObjectURL(blob);
  urlCache.set(id, url);
  return url;
}
export function forgetImageURL(id) {
  if (urlCache.has(id)) { URL.revokeObjectURL(urlCache.get(id)); urlCache.delete(id); }
}

// ---- 백업 ----
function blobToDataURL(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}
export async function exportAll() {
  const images = [];
  for (const rec of await db.all('images')) images.push({ id: rec.id, data: await blobToDataURL(rec.blob) });
  const s = { ...(await getSettings()), apiKey: '' };
  return {
    app: 'gyeol-reader', version: 1, exportedAt: new Date().toISOString(),
    books: await db.all('books'), attempts: await db.all('attempts'), reads: await db.all('reads'),
    settings: s, images,
  };
}
export async function importAll(data) {
  if (!data || data.app !== 'gyeol-reader') throw new Error('결이 리더 백업 파일이 아니에요.');
  for (const img of data.images || []) {
    const blob = await (await fetch(img.data)).blob();
    await db.put('images', { id: img.id, blob });
  }
  for (const b of data.books || []) await db.put('books', b);
  for (const a of data.attempts || []) await db.put('attempts', a);
  for (const r of data.reads || []) await db.put('reads', r);
}
