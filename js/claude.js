// Claude API 호출 (브라우저에서 직접 호출, 키는 iPad 안에만 저장)
import { getSettings } from './db.js';
import { blobToBase64 } from './image.js';
import { bookSentences } from './text.js';

const API_URL = 'https://api.anthropic.com/v1/messages';

export class ClaudeError extends Error {}

async function callTool({ system, content, tool, maxTokens = 4096 }) {
  const s = await getSettings();
  if (!s.apiKey) throw new ClaudeError('설정에서 Claude API 키를 먼저 입력해 주세요.');
  if (!navigator.onLine) throw new ClaudeError('인터넷에 연결되어 있지 않아요.');
  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': s.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: s.model,
        max_tokens: maxTokens,
        system,
        tools: [tool],
        tool_choice: { type: 'tool', name: tool.name },
        messages: [{ role: 'user', content }],
      }),
    });
  } catch (e) {
    throw new ClaudeError('Claude 서버에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || res.statusText;
    if (res.status === 401) throw new ClaudeError('API 키가 올바르지 않아요. 설정에서 다시 확인해 주세요.');
    if (res.status === 404) throw new ClaudeError(`모델(${s.model})을 찾을 수 없어요. 설정에서 모델을 바꿔 주세요.`);
    if (res.status === 429) throw new ClaudeError('요청이 너무 많아요. 잠시 후 다시 시도해 주세요.');
    throw new ClaudeError(`Claude 오류 (${res.status}): ${msg}`);
  }
  const block = (data.content || []).find((b) => b.type === 'tool_use');
  if (!block) throw new ClaudeError('Claude 응답 형식이 예상과 달라요. 다시 시도해 주세요.');
  return block.input;
}

// ---------- 연결 확인 ----------
export async function testConnection() {
  const out = await callTool({
    system: 'Reply using the tool.',
    content: 'Say hello.',
    tool: {
      name: 'reply',
      description: 'Reply',
      input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
    maxTokens: 50,
  });
  return out.text;
}

// ---------- OCR ----------
const OCR_TOOL = {
  name: 'save_page_text',
  description: 'Save the English text read from one page of a children\'s picture book.',
  input_schema: {
    type: 'object',
    properties: {
      sentences: {
        type: 'array',
        items: { type: 'string' },
        description: 'Main story text, in reading order, one complete sentence per item.',
      },
      other_text: {
        type: 'array',
        items: { type: 'string' },
        description: 'Non-story text: sound effects, signs, labels, page numbers, publisher info.',
      },
      quality: { type: 'string', enum: ['good', 'blurry', 'no_text'] },
    },
    required: ['sentences', 'other_text', 'quality'],
  },
};

const OCR_SYSTEM = `You transcribe English children's picture books from photos.
Rules:
- Copy the story text EXACTLY as printed (spelling, capitalization, punctuation). Do not correct grammar or rewrite.
- Follow the natural reading order of the page (top-to-bottom, left-to-right, including speech bubbles that are part of the story).
- Join words broken across lines; remove hyphenation caused by line breaks.
- Split into complete sentences, one per item. Keep quotation marks with the sentence they belong to.
- Put text that is not part of the story (sound effects drawn as art, signs in pictures, page numbers, copyright lines) in other_text.
- If the photo is too blurry to read, set quality to "blurry". If there is no text, return empty arrays with quality "no_text".`;

export async function ocrPage(imageBlob) {
  const b64 = await blobToBase64(imageBlob);
  const out = await callTool({
    system: OCR_SYSTEM,
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
      { type: 'text', text: 'Transcribe this page.' },
    ],
    tool: OCR_TOOL,
  });
  return {
    sentences: (out.sentences || []).map((s) => String(s).trim()).filter(Boolean),
    otherText: (out.other_text || []).map(String),
    quality: out.quality || 'good',
  };
}

// ---------- 퀴즈 ----------
const QUIZ_TOOL = {
  name: 'save_quiz',
  description: 'Save a reading comprehension quiz for a young child.',
  input_schema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['multiple_choice', 'true_false', 'fill_blank'] },
            question_en: { type: 'string', description: 'Short English question (max ~10 words). For fill_blank use ___ for the blank.' },
            question_ko: { type: 'string', description: 'Natural Korean translation of the question, for a hint.' },
            options: {
              type: 'array', items: { type: 'string' },
              description: '3 short options for multiple_choice/fill_blank. For true_false use exactly ["True","False"].',
            },
            answer_index: { type: 'integer', description: '0-based index of the correct option.' },
            evidence_sentence_ids: {
              type: 'array', items: { type: 'string' },
              description: 'IDs of the book sentences that prove the answer, e.g. "p2_s1".',
            },
            explanation_ko: { type: 'string', description: 'Korean explanation for the child, 2-3 short sentences.' },
          },
          required: ['type', 'question_en', 'question_ko', 'options', 'answer_index', 'evidence_sentence_ids', 'explanation_ko'],
        },
      },
    },
    required: ['questions'],
  },
};

export function questionCountFor(book, setting) {
  if (setting && setting !== 'auto') return Number(setting);
  const n = bookSentences(book).length;
  if (n < 12) return 3;
  if (n < 30) return 4;
  return 5;
}

export async function generateQuiz(book) {
  const s = await getSettings();
  const sentences = bookSentences(book);
  if (sentences.length === 0) throw new ClaudeError('책 텍스트가 없어서 퀴즈를 만들 수 없어요.');
  const count = questionCountFor(book, s.questionCount);
  const tone = s.tone === 'jondaetmal'
    ? '존댓말(~했어요, ~이에요)'
    : '다정한 반말(~했어, ~이야)';
  const level = s.difficulty === 'normal'
    ? 'Mostly literal questions plus 1-2 simple inference questions (why / how did they feel).'
    : 'Literal recall questions only (who / what / where / what color / how many), plus at most 1 very easy feeling question.';

  const system = `You write reading comprehension quizzes for a Korean child aged 5-6 who is learning English with picture books.
Rules:
- Write exactly ${count} questions. Mix types: mostly multiple_choice, 1 true_false, and fill_blank only if natural.
- Every answer MUST be directly supported by the book text. List the supporting sentence IDs in evidence_sentence_ids.
- Use only words that appear in the book or are extremely common (a, the, is, who, what, where).
- Questions max ~10 words. Options are 1-4 words each, exactly 3 options (true_false: ["True","False"]).
- Wrong options must be plausible but clearly wrong according to the book. Vary the position of the correct answer.
- Ask about different parts of the story, in story order.
- ${level}
- explanation_ko: 아이 눈높이의 쉬운 한국어 ${tone}로 2~3문장. 정답이 왜 맞는지 책 내용을 들어 설명하고, 근거 영어 문장을 짧게 인용해도 좋음.
- question_ko: 질문의 자연스러운 한국어 번역 (${tone}).`;

  const bookText = sentences.map((x) => `[${x.id}] ${x.text}`).join('\n');
  const out = await callTool({
    system,
    content: `Book title: ${book.title}\n\nBook text (sentence IDs in brackets):\n${bookText}`,
    tool: QUIZ_TOOL,
    maxTokens: 4096,
  });
  const valid = validateQuiz(out.questions, sentences.map((x) => x.id));
  if (valid.length < Math.min(2, count)) throw new ClaudeError('퀴즈를 제대로 만들지 못했어요. 다시 시도해 주세요.');
  return valid;
}

// LLM 출력 검증: 형식이 틀리거나 근거 문장이 없는 문항은 버림
export function validateQuiz(questions, sentenceIds) {
  const idSet = new Set(sentenceIds);
  const out = [];
  (Array.isArray(questions) ? questions : []).forEach((q, i) => {
    if (!q || typeof q.question_en !== 'string' || !q.question_en.trim()) return;
    let options = Array.isArray(q.options) ? q.options.map((o) => String(o).trim()).filter(Boolean) : [];
    const type = ['multiple_choice', 'true_false', 'fill_blank'].includes(q.type) ? q.type : 'multiple_choice';
    if (type === 'true_false') options = ['True', 'False'];
    if (options.length < 2 || options.length > 4) return;
    const ai = Number(q.answer_index);
    if (!Number.isInteger(ai) || ai < 0 || ai >= options.length) return;
    if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) return;
    const evidence = (q.evidence_sentence_ids || []).filter((id) => idSet.has(id));
    if (evidence.length === 0) return;
    out.push({
      id: `q${out.length + 1}`,
      type,
      question_en: q.question_en.trim(),
      question_ko: String(q.question_ko || '').trim(),
      options,
      answer_index: ai,
      evidence_sentence_ids: evidence,
      explanation_ko: String(q.explanation_ko || '').trim(),
    });
  });
  return out;
}

// ---------- 단어 뜻 ----------
const WORD_TOOL = {
  name: 'save_meaning',
  description: 'Save a child-friendly Korean meaning of an English word.',
  input_schema: {
    type: 'object',
    properties: {
      meaning_ko: { type: 'string', description: '아이용 쉬운 한국어 뜻, 1~6단어 (예: "배고픈")' },
      emoji: { type: 'string', description: 'One emoji that pictures the word, or empty string.' },
      sentence_ko: { type: 'string', description: 'Korean translation of the given sentence, short and natural.' },
    },
    required: ['meaning_ko', 'emoji', 'sentence_ko'],
  },
};

export async function lookupWord(word, sentence) {
  return callTool({
    system: 'You help a Korean 5-6 year old understand English words in a picture book. Give the meaning that fits the sentence.',
    content: `Word: "${word}"\nSentence: "${sentence}"`,
    tool: WORD_TOOL,
    maxTokens: 300,
  });
}
