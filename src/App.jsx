import React, { useState, useEffect, useRef, useCallback } from 'react';

/*
  日本語 — A complete Japanese learning web app (single-file React artifact).

  Tabs:
    1. CHAT      — speak (mic / SpeechRecognition) + listen (TTS) tutor powered by Claude,
                   replies in Japanese + romaji + English, separate correction box, role-play scenarios.
    2. ALPHABET  — full hiragana & katakana; tap a letter to hear it + see an example word.
    3. VOCAB     — preset decks + Claude-generated 10-card decks; flip, hear, mark learned.
    4. TRANSLATE — EN<->JA both directions, pronunciation, word-by-word grammar breakdown (Claude).

  Persistence: streak + learned-word count saved to localStorage.
  API: window.claude.complete(prompt) — available in the Claude artifact runtime.
*/

// ----------------------------------------------------------------------------
// Claude API helper — asks for strict JSON and parses defensively.
// ----------------------------------------------------------------------------
async function askClaudeJSON(prompt) {
  if (typeof window === 'undefined' || !window.claude || !window.claude.complete) {
    throw new Error('Claude API is not available in this environment.');
  }
  const raw = await window.claude.complete(prompt);
  return parseLooseJSON(raw);
}

function parseLooseJSON(text) {
  if (typeof text !== 'string') return text;
  // Strip code fences if present.
  let t = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(t);
  } catch (_) {
    // Try to grab the first {...} or [...] block.
    const objMatch = t.match(/[\{\[][\s\S]*[\}\]]/);
    if (objMatch) {
      try { return JSON.parse(objMatch[0]); } catch (_) {}
    }
    throw new Error('Could not parse Claude response as JSON.');
  }
}

// Progressive parser for the streaming chat format. The tutor replies with
// labelled lines (JAPANESE: / ROMAJI: / ENGLISH: / CORRECTION:). This tolerates
// partial buffers mid-stream and stray markdown, so fields fill in as they arrive.
function parseDelimited(buf) {
  const out = { japanese: '', romaji: '', english: '', correction: '' };
  const map = { JAPANESE: 'japanese', ROMAJI: 'romaji', ENGLISH: 'english', CORRECTION: 'correction' };
  let cur = null;
  for (const line of buf.split('\n')) {
    const m = line.match(/^[\s*#>\-]*\b(JAPANESE|ROMAJI|ENGLISH|CORRECTION)\b\s*[:：]\s?(.*)$/i);
    if (m) {
      cur = map[m[1].toUpperCase()];
      out[cur] = m[2];
    } else if (cur) {
      out[cur] += (out[cur] ? '\n' : '') + line;
    }
  }
  // Correction is a single logical block; drop any trailing chatter the model
  // appends after a blank line, and treat "NONE" as no correction.
  out.correction = out.correction.split(/\n\s*\n/)[0].trim();
  if (out.correction.toUpperCase() === 'NONE') out.correction = '';
  out.japanese = out.japanese.trim();
  out.romaji = out.romaji.trim();
  out.english = out.english.trim();
  return out;
}

// ----------------------------------------------------------------------------
// Text-to-speech (Japanese)
// ----------------------------------------------------------------------------
function speakJapanese(text, rate = 0.9) {
  if (typeof window === 'undefined' || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = 'ja-JP';
  utter.rate = rate;
  const voices = window.speechSynthesis.getVoices();
  const jaVoice = voices.find((v) => v.lang && v.lang.toLowerCase().startsWith('ja'));
  if (jaVoice) utter.voice = jaVoice;
  window.speechSynthesis.speak(utter);
}

// ----------------------------------------------------------------------------
// Persistence
// ----------------------------------------------------------------------------
const STORAGE_KEY = 'nihongo_app_progress_v1';

function loadProgress() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function saveProgress(p) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch (_) {}
}

// Lossless cache for model-generated content: a repeated topic/translation
// returns the identical result instantly instead of re-running inference.
const CACHE_PREFIX = 'nihongo_cache_v1:';
function cacheGet(key) {
  try {
    const v = localStorage.getItem(CACHE_PREFIX + key);
    return v ? JSON.parse(v) : null;
  } catch (_) {
    return null;
  }
}
function cacheSet(key, val) {
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(val));
  } catch (_) {}
}

// Cap how many prior turns we feed back to the model. Beginner tutoring only
// needs recent context, and an unbounded transcript makes prompt-eval slower
// every turn. ~8 messages ≈ 4 exchanges.
const MAX_HISTORY = 8;

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  const da = new Date(a + 'T00:00:00');
  const db = new Date(b + 'T00:00:00');
  return Math.round((db - da) / 86400000);
}

// ----------------------------------------------------------------------------
// Alphabet data (hiragana + katakana, with romaji + example words)
// ----------------------------------------------------------------------------
// Each entry: [kana, romaji, exampleKana, exampleRomaji, exampleEn]
const HIRAGANA = [
  ['あ', 'a', 'あめ', 'ame', 'rain'], ['い', 'i', 'いぬ', 'inu', 'dog'], ['う', 'u', 'うみ', 'umi', 'sea'], ['え', 'e', 'えき', 'eki', 'station'], ['お', 'o', 'おちゃ', 'ocha', 'tea'],
  ['か', 'ka', 'かさ', 'kasa', 'umbrella'], ['き', 'ki', 'きって', 'kitte', 'stamp'], ['く', 'ku', 'くち', 'kuchi', 'mouth'], ['け', 'ke', 'けむり', 'kemuri', 'smoke'], ['こ', 'ko', 'こども', 'kodomo', 'child'],
  ['さ', 'sa', 'さかな', 'sakana', 'fish'], ['し', 'shi', 'しお', 'shio', 'salt'], ['す', 'su', 'すし', 'sushi', 'sushi'], ['せ', 'se', 'せんせい', 'sensei', 'teacher'], ['そ', 'so', 'そら', 'sora', 'sky'],
  ['た', 'ta', 'たまご', 'tamago', 'egg'], ['ち', 'chi', 'ちず', 'chizu', 'map'], ['つ', 'tsu', 'つき', 'tsuki', 'moon'], ['て', 'te', 'てがみ', 'tegami', 'letter'], ['と', 'to', 'とり', 'tori', 'bird'],
  ['な', 'na', 'なつ', 'natsu', 'summer'], ['に', 'ni', 'にく', 'niku', 'meat'], ['ぬ', 'nu', 'いぬ', 'inu', 'dog'], ['ね', 'ne', 'ねこ', 'neko', 'cat'], ['の', 'no', 'のり', 'nori', 'seaweed'],
  ['は', 'ha', 'はな', 'hana', 'flower'], ['ひ', 'hi', 'ひと', 'hito', 'person'], ['ふ', 'fu', 'ふね', 'fune', 'boat'], ['へ', 'he', 'へや', 'heya', 'room'], ['ほ', 'ho', 'ほし', 'hoshi', 'star'],
  ['ま', 'ma', 'まど', 'mado', 'window'], ['み', 'mi', 'みず', 'mizu', 'water'], ['む', 'mu', 'むし', 'mushi', 'insect'], ['め', 'me', 'め', 'me', 'eye'], ['も', 'mo', 'もり', 'mori', 'forest'],
  ['や', 'ya', 'やま', 'yama', 'mountain'], ['ゆ', 'yu', 'ゆき', 'yuki', 'snow'], ['よ', 'yo', 'よる', 'yoru', 'night'],
  ['ら', 'ra', 'らく', 'raku', 'easy'], ['り', 'ri', 'りんご', 'ringo', 'apple'], ['る', 'ru', 'よる', 'yoru', 'night'], ['れ', 're', 'れきし', 'rekishi', 'history'], ['ろ', 'ro', 'ろく', 'roku', 'six'],
  ['わ', 'wa', 'わたし', 'watashi', 'I/me'], ['を', 'wo', 'を', 'wo', '(object particle)'], ['ん', 'n', 'ほん', 'hon', 'book'],
  // dakuten / handakuten
  ['が', 'ga', 'がっこう', 'gakkou', 'school'], ['ぎ', 'gi', 'ぎん', 'gin', 'silver'], ['ぐ', 'gu', 'ぐあい', 'guai', 'condition'], ['げ', 'ge', 'げんき', 'genki', 'healthy'], ['ご', 'go', 'ごはん', 'gohan', 'rice/meal'],
  ['ざ', 'za', 'ざっし', 'zasshi', 'magazine'], ['じ', 'ji', 'じかん', 'jikan', 'time'], ['ず', 'zu', 'みず', 'mizu', 'water'], ['ぜ', 'ze', 'かぜ', 'kaze', 'wind'], ['ぞ', 'zo', 'ぞう', 'zou', 'elephant'],
  ['だ', 'da', 'だいがく', 'daigaku', 'university'], ['ぢ', 'ji', 'はなぢ', 'hanaji', 'nosebleed'], ['づ', 'zu', 'つづく', 'tsuzuku', 'to continue'], ['で', 'de', 'でんわ', 'denwa', 'telephone'], ['ど', 'do', 'どあ', 'doa', 'door'],
  ['ば', 'ba', 'ばす', 'basu', 'bus'], ['び', 'bi', 'びょういん', 'byouin', 'hospital'], ['ぶ', 'bu', 'ぶた', 'buta', 'pig'], ['べ', 'be', 'べんり', 'benri', 'convenient'], ['ぼ', 'bo', 'ぼうし', 'boushi', 'hat'],
  ['ぱ', 'pa', 'ぱん', 'pan', 'bread'], ['ぴ', 'pi', 'ぴあの', 'piano', 'piano'], ['ぷ', 'pu', 'ぷーる', 'puuru', 'pool'], ['ぺ', 'pe', 'ぺん', 'pen', 'pen'], ['ぽ', 'po', 'さんぽ', 'sanpo', 'a walk'],
  // yoon
  ['きゃ', 'kya', 'きゃく', 'kyaku', 'guest'], ['きゅ', 'kyu', 'きゅう', 'kyuu', 'nine'], ['きょ', 'kyo', 'きょう', 'kyou', 'today'],
  ['しゃ', 'sha', 'しゃしん', 'shashin', 'photo'], ['しゅ', 'shu', 'しゅみ', 'shumi', 'hobby'], ['しょ', 'sho', 'しょくじ', 'shokuji', 'meal'],
  ['ちゃ', 'cha', 'おちゃ', 'ocha', 'tea'], ['ちゅ', 'chu', 'ちゅうい', 'chuui', 'caution'], ['ちょ', 'cho', 'ちょっと', 'chotto', 'a little'],
  ['にゃ', 'nya', 'こんにゃく', 'konnyaku', 'konjac'], ['にゅ', 'nyu', 'にゅういん', 'nyuuin', 'hospitalization'], ['にょ', 'nyo', 'にょきにょき', 'nyokinyoki', 'sprouting up'],
  ['ひゃ', 'hya', 'ひゃく', 'hyaku', 'hundred'], ['ひゅ', 'hyu', 'ひゅう', 'hyuu', 'whoosh'], ['ひょ', 'hyo', 'ひょう', 'hyou', 'leopard'],
  ['みゃ', 'mya', 'みゃく', 'myaku', 'pulse'], ['みゅ', 'myu', 'みゅーじっく', 'myuujikku', 'music'], ['みょ', 'myo', 'みょうじ', 'myouji', 'surname'],
  ['りゃ', 'rya', 'りゃくご', 'ryakugo', 'abbreviation'], ['りゅ', 'ryu', 'りゅう', 'ryuu', 'dragon'], ['りょ', 'ryo', 'りょこう', 'ryokou', 'travel'],
  ['ぎゃ', 'gya', 'ぎゃく', 'gyaku', 'reverse'], ['ぎゅ', 'gyu', 'ぎゅうにゅう', 'gyuunyuu', 'milk'], ['ぎょ', 'gyo', 'きんぎょ', 'kingyo', 'goldfish'],
  ['じゃ', 'ja', 'じゃがいも', 'jagaimo', 'potato'], ['じゅ', 'ju', 'じゅぎょう', 'jugyou', 'class'], ['じょ', 'jo', 'じょうず', 'jouzu', 'skilled'],
  ['びゃ', 'bya', 'びゃくや', 'byakuya', 'white night'], ['びゅ', 'byu', 'びゅうびゅう', 'byuubyuu', 'howling wind'], ['びょ', 'byo', 'びょうき', 'byouki', 'illness'],
  ['ぴゃ', 'pya', 'ろっぴゃく', 'roppyaku', 'six hundred'], ['ぴゅ', 'pyu', 'ぴゅう', 'pyuu', 'whiz'], ['ぴょ', 'pyo', 'ぴょんぴょん', 'pyonpyon', 'hopping'],
];

const KATAKANA = [
  ['ア', 'a', 'アイス', 'aisu', 'ice cream'], ['イ', 'i', 'インク', 'inku', 'ink'], ['ウ', 'u', 'ウール', 'uuru', 'wool'], ['エ', 'e', 'エアコン', 'eakon', 'air conditioner'], ['オ', 'o', 'オレンジ', 'orenji', 'orange'],
  ['カ', 'ka', 'カメラ', 'kamera', 'camera'], ['キ', 'ki', 'キロ', 'kiro', 'kilo'], ['ク', 'ku', 'クラス', 'kurasu', 'class'], ['ケ', 'ke', 'ケーキ', 'keeki', 'cake'], ['コ', 'ko', 'コーヒー', 'koohii', 'coffee'],
  ['サ', 'sa', 'サラダ', 'sarada', 'salad'], ['シ', 'shi', 'シャツ', 'shatsu', 'shirt'], ['ス', 'su', 'スープ', 'suupu', 'soup'], ['セ', 'se', 'セーター', 'seetaa', 'sweater'], ['ソ', 'so', 'ソファ', 'sofa', 'sofa'],
  ['タ', 'ta', 'タクシー', 'takushii', 'taxi'], ['チ', 'chi', 'チーズ', 'chiizu', 'cheese'], ['ツ', 'tsu', 'ツアー', 'tsuaa', 'tour'], ['テ', 'te', 'テレビ', 'terebi', 'TV'], ['ト', 'to', 'トマト', 'tomato', 'tomato'],
  ['ナ', 'na', 'ナイフ', 'naifu', 'knife'], ['ニ', 'ni', 'ニュース', 'nyuusu', 'news'], ['ヌ', 'nu', 'カヌー', 'kanuu', 'canoe'], ['ネ', 'ne', 'ネクタイ', 'nekutai', 'necktie'], ['ノ', 'no', 'ノート', 'nooto', 'notebook'],
  ['ハ', 'ha', 'ハム', 'hamu', 'ham'], ['ヒ', 'hi', 'ヒーター', 'hiitaa', 'heater'], ['フ', 'fu', 'フォーク', 'fooku', 'fork'], ['ヘ', 'he', 'ヘリコプター', 'herikoputaa', 'helicopter'], ['ホ', 'ho', 'ホテル', 'hoteru', 'hotel'],
  ['マ', 'ma', 'マスク', 'masuku', 'mask'], ['ミ', 'mi', 'ミルク', 'miruku', 'milk'], ['ム', 'mu', 'ゲーム', 'geemu', 'game'], ['メ', 'me', 'メニュー', 'menyuu', 'menu'], ['モ', 'mo', 'メモ', 'memo', 'memo'],
  ['ヤ', 'ya', 'タイヤ', 'taiya', 'tire'], ['ユ', 'yu', 'ユニフォーム', 'yunifoomu', 'uniform'], ['ヨ', 'yo', 'ヨガ', 'yoga', 'yoga'],
  ['ラ', 'ra', 'ラジオ', 'rajio', 'radio'], ['リ', 'ri', 'リスト', 'risuto', 'list'], ['ル', 'ru', 'ルール', 'ruuru', 'rule'], ['レ', 're', 'レモン', 'remon', 'lemon'], ['ロ', 'ro', 'ロボット', 'robotto', 'robot'],
  ['ワ', 'wa', 'ワイン', 'wain', 'wine'], ['ヲ', 'wo', 'ヲ', 'wo', '(rare particle)'], ['ン', 'n', 'パン', 'pan', 'bread'],
  // dakuten / handakuten
  ['ガ', 'ga', 'ガラス', 'garasu', 'glass'], ['ギ', 'gi', 'ギター', 'gitaa', 'guitar'], ['グ', 'gu', 'グラス', 'gurasu', 'glass (cup)'], ['ゲ', 'ge', 'ゲーム', 'geemu', 'game'], ['ゴ', 'go', 'ゴルフ', 'gorufu', 'golf'],
  ['ザ', 'za', 'ピザ', 'piza', 'pizza'], ['ジ', 'ji', 'ジュース', 'juusu', 'juice'], ['ズ', 'zu', 'ズボン', 'zubon', 'trousers'], ['ゼ', 'ze', 'ゼロ', 'zero', 'zero'], ['ゾ', 'zo', 'ゾーン', 'zoon', 'zone'],
  ['ダ', 'da', 'ダンス', 'dansu', 'dance'], ['ヂ', 'ji', 'ヂ', 'ji', '(rare)'], ['ヅ', 'zu', 'ヅ', 'zu', '(rare)'], ['デ', 'de', 'デート', 'deeto', 'date'], ['ド', 'do', 'ドア', 'doa', 'door'],
  ['バ', 'ba', 'バナナ', 'banana', 'banana'], ['ビ', 'bi', 'ビール', 'biiru', 'beer'], ['ブ', 'bu', 'ブラシ', 'burashi', 'brush'], ['ベ', 'be', 'ベッド', 'beddo', 'bed'], ['ボ', 'bo', 'ボタン', 'botan', 'button'],
  ['パ', 'pa', 'パン', 'pan', 'bread'], ['ピ', 'pi', 'ピアノ', 'piano', 'piano'], ['プ', 'pu', 'プール', 'puuru', 'pool'], ['ペ', 'pe', 'ペン', 'pen', 'pen'], ['ポ', 'po', 'ポスト', 'posuto', 'mailbox'],
  // yoon
  ['キャ', 'kya', 'キャンプ', 'kyanpu', 'camp'], ['キュ', 'kyu', 'キュー', 'kyuu', 'cue'], ['キョ', 'kyo', 'キョーザ', 'kyooza', 'dumpling'],
  ['シャ', 'sha', 'シャワー', 'shawaa', 'shower'], ['シュ', 'shu', 'シュート', 'shuuto', 'shoot'], ['ショ', 'sho', 'ショップ', 'shoppu', 'shop'],
  ['チャ', 'cha', 'チャンス', 'chansu', 'chance'], ['チュ', 'chu', 'チューブ', 'chuubu', 'tube'], ['チョ', 'cho', 'チョコ', 'choko', 'chocolate'],
  ['ニャ', 'nya', 'ニャー', 'nyaa', 'meow'], ['ニュ', 'nyu', 'ニュース', 'nyuusu', 'news'], ['ニョ', 'nyo', 'ニョッキ', 'nyokki', 'gnocchi'],
  ['ヒャ', 'hya', 'ヒャー', 'hyaa', 'yikes'], ['ヒュ', 'hyu', 'ヒューズ', 'hyuuzu', 'fuse'], ['ヒョ', 'hyo', 'ヒョウ', 'hyou', 'leopard'],
  ['ミャ', 'mya', 'ミャンマー', 'myanmaa', 'Myanmar'], ['ミュ', 'myu', 'ミュージック', 'myuujikku', 'music'], ['ミョ', 'myo', 'ミョー', 'myoo', 'strange'],
  ['リャ', 'rya', 'リャマ', 'ryama', 'llama'], ['リュ', 'ryu', 'リュック', 'ryukku', 'backpack'], ['リョ', 'ryo', 'リョー', 'ryoo', '(sound)'],
  ['ギャ', 'gya', 'ギャラリー', 'gyararii', 'gallery'], ['ギュ', 'gyu', 'ギュッ', 'gyu', 'squeeze'], ['ギョ', 'gyo', 'ギョーザ', 'gyooza', 'dumpling'],
  ['ジャ', 'ja', 'ジャム', 'jamu', 'jam'], ['ジュ', 'ju', 'ジュース', 'juusu', 'juice'], ['ジョ', 'jo', 'ジョギング', 'jogingu', 'jogging'],
  ['ビャ', 'bya', 'ビャ', 'bya', '(sound)'], ['ビュ', 'byu', 'ビュッフェ', 'byuffe', 'buffet'], ['ビョ', 'byo', 'ビョー', 'byoo', '(sound)'],
  ['ピャ', 'pya', 'ピャ', 'pya', '(sound)'], ['ピュ', 'pyu', 'ピューレ', 'pyuure', 'purée'], ['ピョ', 'pyo', 'ピョン', 'pyon', 'hop'],
];

// ----------------------------------------------------------------------------
// Preset vocab decks
// ----------------------------------------------------------------------------
const PRESET_DECKS = {
  Greetings: [
    ['こんにちは', 'konnichiwa', 'Hello / Good afternoon'],
    ['おはよう', 'ohayou', 'Good morning'],
    ['こんばんは', 'konbanwa', 'Good evening'],
    ['ありがとう', 'arigatou', 'Thank you'],
    ['すみません', 'sumimasen', 'Excuse me / Sorry'],
    ['はじめまして', 'hajimemashite', 'Nice to meet you'],
    ['さようなら', 'sayounara', 'Goodbye'],
    ['おやすみ', 'oyasumi', 'Good night'],
    ['げんきですか', 'genki desu ka', 'How are you?'],
    ['またね', 'mata ne', 'See you later'],
  ],
  Food: [
    ['ごはん', 'gohan', 'Rice / Meal'],
    ['みず', 'mizu', 'Water'],
    ['おちゃ', 'ocha', 'Tea'],
    ['さかな', 'sakana', 'Fish'],
    ['にく', 'niku', 'Meat'],
    ['やさい', 'yasai', 'Vegetables'],
    ['くだもの', 'kudamono', 'Fruit'],
    ['たまご', 'tamago', 'Egg'],
    ['パン', 'pan', 'Bread'],
    ['おいしい', 'oishii', 'Delicious'],
  ],
  Travel: [
    ['えき', 'eki', 'Station'],
    ['くうこう', 'kuukou', 'Airport'],
    ['でんしゃ', 'densha', 'Train'],
    ['ホテル', 'hoteru', 'Hotel'],
    ['きっぷ', 'kippu', 'Ticket'],
    ['ちず', 'chizu', 'Map'],
    ['みぎ', 'migi', 'Right'],
    ['ひだり', 'hidari', 'Left'],
    ['まっすぐ', 'massugu', 'Straight ahead'],
    ['いくら', 'ikura', 'How much?'],
  ],
  Numbers: [
    ['いち', 'ichi', 'One (1)'],
    ['に', 'ni', 'Two (2)'],
    ['さん', 'san', 'Three (3)'],
    ['よん', 'yon', 'Four (4)'],
    ['ご', 'go', 'Five (5)'],
    ['ろく', 'roku', 'Six (6)'],
    ['なな', 'nana', 'Seven (7)'],
    ['はち', 'hachi', 'Eight (8)'],
    ['きゅう', 'kyuu', 'Nine (9)'],
    ['じゅう', 'juu', 'Ten (10)'],
  ],
};

const SCENARIOS = [
  { id: 'free', label: '💬 Free chat', desc: 'Open conversation' },
  { id: 'coffee', label: '☕ Order coffee', desc: 'You are at a café ordering a drink.' },
  { id: 'meet', label: '🤝 Meet someone', desc: 'You are introducing yourself to a new person.' },
  { id: 'airport', label: '✈️ At the airport', desc: 'You are checking in and asking for directions at the airport.' },
];

// ============================================================================
// Root component
// ============================================================================
export default function App() {
  const [tab, setTab] = useState('chat');
  const [progress, setProgress] = useState(() => {
    const p = loadProgress();
    return p || { streak: 0, lastActive: null, learned: [] };
  });

  // Update streak once on mount.
  useEffect(() => {
    setProgress((prev) => {
      const today = todayStr();
      if (prev.lastActive === today) return prev;
      let streak = 1;
      if (prev.lastActive) {
        const gap = daysBetween(prev.lastActive, today);
        if (gap === 1) streak = (prev.streak || 0) + 1;
        else if (gap === 0) streak = prev.streak || 1;
        else streak = 1;
      }
      const next = { ...prev, streak, lastActive: today };
      saveProgress(next);
      return next;
    });
  }, []);

  useEffect(() => { saveProgress(progress); }, [progress]);

  // Prime TTS voices.
  useEffect(() => {
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.getVoices();
    }
  }, []);

  const markLearned = useCallback((word) => {
    setProgress((prev) => {
      if (prev.learned.includes(word)) return prev;
      return { ...prev, learned: [...prev.learned, word] };
    });
  }, []);

  const unmarkLearned = useCallback((word) => {
    setProgress((prev) => ({ ...prev, learned: prev.learned.filter((w) => w !== word) }));
  }, []);

  const TABS = [
    { id: 'chat', label: 'CHAT', icon: '🗣️' },
    { id: 'alphabet', label: 'ALPHABET', icon: 'あ' },
    { id: 'vocab', label: 'VOCAB', icon: '🃏' },
    { id: 'translate', label: 'TRANSLATE', icon: '🔁' },
  ];

  return (
    <div style={{ fontFamily: "'Helvetica Neue', Arial, sans-serif" }} className="min-h-screen bg-neutral-950 text-neutral-100">
      {/* Header */}
      <header className="sticky top-0 z-20 border-b border-neutral-800 bg-neutral-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-black tracking-tight text-rose-500">日本語</span>
            <span className="text-sm font-semibold uppercase tracking-widest text-neutral-400">Tutor</span>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="flex items-center gap-1 rounded-full bg-orange-500/15 px-3 py-1 font-bold text-orange-400">
              🔥 {progress.streak} day{progress.streak === 1 ? '' : 's'}
            </span>
            <span className="flex items-center gap-1 rounded-full bg-emerald-500/15 px-3 py-1 font-bold text-emerald-400">
              ✓ {progress.learned.length} learned
            </span>
          </div>
        </div>
      </header>

      {/* Tab content */}
      <main className="mx-auto max-w-3xl px-4 pb-28 pt-5">
        {tab === 'chat' && <ChatTab markLearned={markLearned} />}
        {tab === 'alphabet' && <AlphabetTab />}
        {tab === 'vocab' && (
          <VocabTab learned={progress.learned} markLearned={markLearned} unmarkLearned={unmarkLearned} />
        )}
        {tab === 'translate' && <TranslateTab />}
      </main>

      {/* Bottom tab bar */}
      <nav className="fixed bottom-0 left-0 right-0 z-20 border-t border-neutral-800 bg-neutral-950/95 backdrop-blur">
        <div className="mx-auto flex max-w-3xl">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex flex-1 flex-col items-center gap-0.5 py-3 text-xs font-bold tracking-wide transition ${
                tab === t.id ? 'text-rose-500' : 'text-neutral-500 hover:text-neutral-300'
              }`}
            >
              <span className="text-lg leading-none">{t.icon}</span>
              {t.label}
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}

// ============================================================================
// CHAT TAB
// ============================================================================
function ChatTab({ markLearned }) {
  const [scenario, setScenario] = useState('free');
  const [messages, setMessages] = useState([]); // {role, japanese, romaji, english}
  const [correction, setCorrection] = useState(null);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState('');
  const recognitionRef = useRef(null);
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, loading]);

  const startListening = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      setError('Speech recognition is not supported in this browser. Try Chrome.');
      return;
    }
    setError('');
    const rec = new SR();
    rec.lang = 'ja-JP';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onresult = (e) => {
      const transcript = e.results[0][0].transcript;
      setInput((prev) => (prev ? prev + ' ' : '') + transcript);
    };
    rec.onerror = (e) => { setError('Mic error: ' + e.error); setListening(false); };
    rec.onend = () => setListening(false);
    recognitionRef.current = rec;
    rec.start();
    setListening(true);
  };

  const stopListening = () => {
    if (recognitionRef.current) recognitionRef.current.stop();
    setListening(false);
  };

  const buildPrompt = (history, userText) => {
    const sc = SCENARIOS.find((s) => s.id === scenario);
    const convo = history
      .slice(-MAX_HISTORY)
      .map((m) => `${m.role === 'user' ? 'Student' : 'Tutor'}: ${m.japanese || m.english}`)
      .join('\n');
    return `You are a warm, encouraging Japanese tutor for an absolute BEGINNER.
Scenario: ${sc.desc}
Keep your Japanese SIMPLE (beginner level, short sentences, mostly hiragana/katakana with very common kanji).

Conversation so far:
${convo || '(none yet)'}

The student just said (they may have made mistakes, or written in English): "${userText}"

Respond ONLY with a single JSON object, no markdown, with these exact keys:
{
  "japanese": "your reply in Japanese",
  "romaji": "romaji transliteration of your Japanese reply",
  "english": "English translation of your reply",
  "correction": "If the student's Japanese had mistakes, gently explain the correction here in English (show corrected Japanese + why). If it was fine or was English, set this to an empty string."
}`;
  };

  // Streaming prompt: same content as the JSON version, but as labelled lines
  // that stream naturally (Japanese first, then romaji, English, correction).
  const buildStreamPrompt = (history, userText) => {
    const sc = SCENARIOS.find((s) => s.id === scenario);
    const convo = history
      .slice(-MAX_HISTORY)
      .map((m) => `${m.role === 'user' ? 'Student' : 'Tutor'}: ${m.japanese || m.english}`)
      .join('\n');
    return `You are a warm, encouraging Japanese tutor for an absolute BEGINNER.
Scenario: ${sc.desc}
Keep your Japanese SIMPLE (beginner level, short sentences, mostly hiragana/katakana with very common kanji).

Conversation so far:
${convo || '(none yet)'}

The student just said (they may have made mistakes, or written in English): "${userText}"

Reply in EXACTLY this format — four labelled lines, in this order, and nothing else:
JAPANESE: <your reply in Japanese>
ROMAJI: <romaji transliteration of your Japanese reply>
ENGLISH: <English translation of your reply>
CORRECTION: <if the student's Japanese had mistakes, gently explain the correction in English (corrected Japanese + why); otherwise write NONE>`;
  };

  const send = async (text) => {
    const userText = (text ?? input).trim();
    if (!userText || loading) return;
    setError('');
    setInput('');
    const userMsg = { role: 'user', japanese: userText, romaji: '', english: '' };
    const priorMessages = messages;
    setMessages((m) => [...m, userMsg]);
    setLoading(true);

    const canStream = typeof window !== 'undefined' && window.claude && window.claude.stream;
    try {
      if (canStream) {
        // Insert a live placeholder bubble and fill it as tokens arrive.
        setMessages((m) => [...m, { role: 'tutor', japanese: '', romaji: '', english: '', streaming: true }]);
        const apply = (parsed) => {
          setMessages((m) => {
            const copy = m.slice();
            const last = copy[copy.length - 1];
            if (last && last.role === 'tutor') {
              copy[copy.length - 1] = { ...last, japanese: parsed.japanese, romaji: parsed.romaji, english: parsed.english };
            }
            return copy;
          });
          setCorrection(parsed.correction && parsed.correction.trim() ? parsed.correction.trim() : null);
        };
        // Stop as soon as the four labelled lines are complete (the CORRECTION
        // line has ended) — the reply is fully in hand, so don't let the model
        // ramble on. Aborting cancels generation upstream at Ollama too.
        const controller = new AbortController();
        const onChunk = (sofar) => {
          apply(parseDelimited(sofar));
          if (/CORRECTION\s*[:：][^\n]*\n/i.test(sofar)) controller.abort();
        };
        const full = await window.claude.stream(buildStreamPrompt(priorMessages, userText), onChunk, controller.signal);
        const finalParsed = parseDelimited(full);
        setMessages((m) => {
          const copy = m.slice();
          const last = copy[copy.length - 1];
          if (last && last.role === 'tutor') copy[copy.length - 1] = { ...last, ...finalParsed, streaming: false };
          return copy;
        });
        if (finalParsed.japanese) setTimeout(() => speakJapanese(finalParsed.japanese), 150);
      } else {
        // Fallback: non-streaming JSON path.
        const res = await askClaudeJSON(buildPrompt(priorMessages, userText));
        const tutorMsg = { role: 'tutor', japanese: res.japanese || '', romaji: res.romaji || '', english: res.english || '' };
        setMessages((m) => [...m, tutorMsg]);
        setCorrection(res.correction && res.correction.trim() ? res.correction.trim() : null);
        if (tutorMsg.japanese) setTimeout(() => speakJapanese(tutorMsg.japanese), 150);
      }
    } catch (e) {
      // Drop any empty streaming placeholder, surface the error, keep the student's message.
      setMessages((m) => m.filter((msg) => !(msg.role === 'tutor' && msg.streaming && !msg.japanese)));
      setError(e.message || 'Something went wrong calling the tutor.');
    } finally {
      setLoading(false);
    }
  };

  const changeScenario = (id) => {
    setScenario(id);
    setMessages([]);
    setCorrection(null);
    setError('');
  };

  return (
    <div className="space-y-4">
      {/* Scenario picker */}
      <div className="flex flex-wrap gap-2">
        {SCENARIOS.map((s) => (
          <button
            key={s.id}
            onClick={() => changeScenario(s.id)}
            className={`rounded-full border px-3 py-1.5 text-sm font-semibold transition ${
              scenario === s.id
                ? 'border-rose-500 bg-rose-500/20 text-rose-300'
                : 'border-neutral-700 text-neutral-400 hover:border-neutral-500'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* Correction box */}
      {correction && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3">
          <div className="mb-1 text-xs font-bold uppercase tracking-wider text-amber-400">✎ Correction</div>
          <div className="text-sm text-amber-100">{correction}</div>
        </div>
      )}

      {/* Messages */}
      <div
        ref={scrollRef}
        className="h-[46vh] space-y-3 overflow-y-auto rounded-xl border border-neutral-800 bg-neutral-900/50 p-3"
      >
        {messages.length === 0 && !loading && (
          <div className="flex h-full flex-col items-center justify-center text-center text-neutral-500">
            <div className="text-4xl">🗣️</div>
            <p className="mt-2 max-w-xs text-sm">
              Tap the mic and speak Japanese, or type below. Pick a role-play scenario above to practice.
            </p>
          </div>
        )}
        {messages.map((m, i) =>
          m.role === 'user' ? (
            <div key={i} className="flex justify-end">
              <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-rose-600 px-4 py-2 text-white">
                <div className="text-base">{m.japanese}</div>
              </div>
            </div>
          ) : (
            <div key={i} className="flex justify-start">
              <div className="max-w-[85%] rounded-2xl rounded-bl-sm bg-neutral-800 px-4 py-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="text-lg font-medium leading-snug">
                    {m.japanese || (m.streaming ? <span className="animate-pulse text-neutral-500">▋</span> : '')}
                  </div>
                  <button
                    onClick={() => speakJapanese(m.japanese)}
                    className="shrink-0 rounded-full bg-neutral-700 px-2 py-1 text-xs hover:bg-neutral-600"
                    title="Play"
                  >🔊</button>
                </div>
                {m.romaji && <div className="mt-1 text-sm italic text-sky-300">{m.romaji}</div>}
                {m.english && <div className="mt-0.5 text-sm text-neutral-400">{m.english}</div>}
              </div>
            </div>
          )
        )}
        {loading && !(messages.length > 0 && messages[messages.length - 1].role === 'tutor') && (
          <div className="flex justify-start">
            <div className="rounded-2xl rounded-bl-sm bg-neutral-800 px-4 py-3 text-neutral-400">
              <span className="inline-flex gap-1">
                <Dot /> <Dot delay="150ms" /> <Dot delay="300ms" />
              </span>
            </div>
          </div>
        )}
      </div>

      {error && <div className="rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-300">{error}</div>}

      {/* Input row */}
      <div className="flex items-center gap-2">
        <button
          onClick={listening ? stopListening : startListening}
          className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-xl transition ${
            listening ? 'animate-pulse bg-red-600 text-white' : 'bg-neutral-800 hover:bg-neutral-700'
          }`}
          title="Speak"
        >🎤</button>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
          placeholder="Speak or type in Japanese…"
          className="h-12 flex-1 rounded-full border border-neutral-700 bg-neutral-900 px-4 text-base outline-none focus:border-rose-500"
        />
        <button
          onClick={() => send()}
          disabled={loading || !input.trim()}
          className="h-12 shrink-0 rounded-full bg-rose-600 px-5 font-bold text-white transition hover:bg-rose-500 disabled:opacity-40"
        >Send</button>
      </div>
    </div>
  );
}

function Dot({ delay = '0ms' }) {
  return <span className="inline-block h-2 w-2 animate-bounce rounded-full bg-neutral-400" style={{ animationDelay: delay }} />;
}

// ============================================================================
// ALPHABET TAB
// ============================================================================
function AlphabetTab() {
  const [set, setSet] = useState('hiragana');
  const [selected, setSelected] = useState(null);
  const data = set === 'hiragana' ? HIRAGANA : KATAKANA;

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {['hiragana', 'katakana'].map((s) => (
          <button
            key={s}
            onClick={() => { setSet(s); setSelected(null); }}
            className={`flex-1 rounded-xl border py-3 text-sm font-bold uppercase tracking-wider transition ${
              set === s ? 'border-rose-500 bg-rose-500/15 text-rose-300' : 'border-neutral-700 text-neutral-400'
            }`}
          >
            {s === 'hiragana' ? 'ひらがな Hiragana' : 'カタカナ Katakana'}
          </button>
        ))}
      </div>

      {selected && (
        <div className="rounded-2xl border border-neutral-800 bg-gradient-to-br from-rose-600/20 to-neutral-900 p-5 text-center">
          <div className="text-6xl font-black">{selected[0]}</div>
          <div className="mt-1 text-lg font-semibold uppercase tracking-widest text-rose-300">{selected[1]}</div>
          <div className="mt-3 text-sm text-neutral-400">Example</div>
          <div className="text-2xl font-medium">{selected[2]}</div>
          <div className="text-sm italic text-sky-300">{selected[3]} — {selected[4]}</div>
          <button
            onClick={() => speakJapanese(selected[2])}
            className="mt-3 rounded-full bg-rose-600 px-4 py-2 text-sm font-bold text-white hover:bg-rose-500"
          >🔊 Play example</button>
        </div>
      )}

      <div className="grid grid-cols-5 gap-2 sm:grid-cols-8">
        {data.map((row) => (
          <button
            key={row[0] + row[1]}
            onClick={() => { setSelected(row); speakJapanese(row[0]); }}
            className={`flex aspect-square flex-col items-center justify-center rounded-lg border text-center transition ${
              selected && selected[0] === row[0]
                ? 'border-rose-500 bg-rose-500/20'
                : 'border-neutral-800 bg-neutral-900 hover:border-neutral-600 hover:bg-neutral-800'
            }`}
          >
            <span className="text-xl font-bold">{row[0]}</span>
            <span className="text-[10px] uppercase text-neutral-500">{row[1]}</span>
          </button>
        ))}
      </div>
      <p className="text-center text-xs text-neutral-600">Tap a character to hear it and see an example word.</p>
    </div>
  );
}

// ============================================================================
// VOCAB TAB
// ============================================================================
function VocabTab({ learned, markLearned, unmarkLearned }) {
  const [deckName, setDeckName] = useState('Greetings');
  const [customCards, setCustomCards] = useState(null); // generated deck
  const [topic, setTopic] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);

  const presetCards = PRESET_DECKS[deckName] || [];
  const cards = customCards || presetCards;
  const card = cards[index];

  const reset = () => { setIndex(0); setFlipped(false); };

  const selectPreset = (name) => {
    setDeckName(name);
    setCustomCards(null);
    reset();
    setError('');
  };

  const generate = async () => {
    const t = topic.trim();
    if (!t || loading) return;
    const cacheKey = 'vocab:' + t.toLowerCase();
    const cached = cacheGet(cacheKey);
    if (cached && cached.length) {
      setCustomCards(cached);
      setDeckName(`✨ ${t}`);
      reset();
      setError('');
      return;
    }
    setLoading(true);
    setError('');
    try {
      // Ask for an OBJECT that wraps the array — the proxy runs the model in
      // JSON mode, which reliably returns a single object but tends to collapse
      // a bare top-level array down to one item.
      const prompt = `Generate a beginner Japanese vocabulary deck of EXACTLY 10 words about the topic "${t}".
Respond ONLY with a JSON object (no markdown) of this exact shape:
{ "cards": [ { "japanese": "word in kana (simple)", "romaji": "romaji", "english": "English meaning" } ] }
The "cards" array MUST contain exactly 10 items.`;
      const res = await askClaudeJSON(prompt);
      // Accept a bare array, a known wrapper key, or any array-valued property.
      const arr = Array.isArray(res)
        ? res
        : res.cards || res.deck || res.words || res.vocabulary ||
          Object.values(res).find((v) => Array.isArray(v)) || [];
      const mapped = arr
        .filter((c) => c && c.japanese)
        .map((c) => [c.japanese, c.romaji || '', c.english || '']);
      if (mapped.length === 0) throw new Error('No cards generated.');
      setCustomCards(mapped);
      cacheSet(cacheKey, mapped);
      setDeckName(`✨ ${t}`);
      reset();
    } catch (e) {
      setError(e.message || 'Could not generate deck.');
    } finally {
      setLoading(false);
    }
  };

  const next = () => { setFlipped(false); setIndex((i) => (i + 1) % cards.length); };
  const prev = () => { setFlipped(false); setIndex((i) => (i - 1 + cards.length) % cards.length); };

  const isLearned = card && learned.includes(card[0]);

  return (
    <div className="space-y-4">
      {/* Preset deck chips */}
      <div className="flex flex-wrap gap-2">
        {Object.keys(PRESET_DECKS).map((name) => (
          <button
            key={name}
            onClick={() => selectPreset(name)}
            className={`rounded-full border px-3 py-1.5 text-sm font-semibold transition ${
              deckName === name && !customCards
                ? 'border-rose-500 bg-rose-500/20 text-rose-300'
                : 'border-neutral-700 text-neutral-400 hover:border-neutral-500'
            }`}
          >{name}</button>
        ))}
        {customCards && (
          <span className="rounded-full border border-emerald-500 bg-emerald-500/15 px-3 py-1.5 text-sm font-semibold text-emerald-300">
            {deckName}
          </span>
        )}
      </div>

      {/* Custom topic generator */}
      <div className="flex gap-2">
        <input
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') generate(); }}
          placeholder="Type any topic → generate 10 cards…"
          className="h-11 flex-1 rounded-full border border-neutral-700 bg-neutral-900 px-4 text-sm outline-none focus:border-rose-500"
        />
        <button
          onClick={generate}
          disabled={loading || !topic.trim()}
          className="h-11 shrink-0 rounded-full bg-rose-600 px-4 text-sm font-bold text-white hover:bg-rose-500 disabled:opacity-40"
        >{loading ? '…' : 'Generate'}</button>
      </div>

      {error && <div className="rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-300">{error}</div>}

      {/* Flashcard */}
      {card && (
        <>
          <div className="text-center text-xs font-semibold uppercase tracking-widest text-neutral-500">
            Card {index + 1} / {cards.length}
          </div>
          <button
            onClick={() => setFlipped((f) => !f)}
            className="flex min-h-[200px] w-full flex-col items-center justify-center rounded-3xl border border-neutral-800 bg-gradient-to-br from-neutral-900 to-neutral-950 p-6 text-center transition hover:border-neutral-700"
          >
            {!flipped ? (
              <>
                <div className="text-5xl font-black">{card[0]}</div>
                <div className="mt-4 text-xs uppercase tracking-widest text-neutral-600">tap to flip</div>
              </>
            ) : (
              <>
                <div className="text-2xl font-bold italic text-sky-300">{card[1]}</div>
                <div className="mt-2 text-xl text-neutral-200">{card[2]}</div>
                <div className="mt-4 text-xs uppercase tracking-widest text-neutral-600">tap to flip back</div>
              </>
            )}
          </button>

          {/* Card controls */}
          <div className="flex items-center justify-between gap-2">
            <button onClick={prev} className="rounded-full bg-neutral-800 px-4 py-2 text-sm font-bold hover:bg-neutral-700">← Prev</button>
            <button
              onClick={() => speakJapanese(card[0])}
              className="rounded-full bg-sky-600 px-4 py-2 text-sm font-bold text-white hover:bg-sky-500"
            >🔊 Hear</button>
            <button
              onClick={() => (isLearned ? unmarkLearned(card[0]) : markLearned(card[0]))}
              className={`rounded-full px-4 py-2 text-sm font-bold transition ${
                isLearned ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'bg-neutral-800 hover:bg-neutral-700'
              }`}
            >{isLearned ? '✓ Learned' : 'Mark learned'}</button>
            <button onClick={next} className="rounded-full bg-neutral-800 px-4 py-2 text-sm font-bold hover:bg-neutral-700">Next →</button>
          </div>
        </>
      )}
    </div>
  );
}

// ============================================================================
// TRANSLATE TAB
// ============================================================================
function TranslateTab() {
  const [text, setText] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const translate = async () => {
    const t = text.trim();
    if (!t || loading) return;
    const cacheKey = 'tr:' + t;
    const cached = cacheGet(cacheKey);
    if (cached) {
      setResult(cached);
      setError('');
      return;
    }
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const prompt = `You are a Japanese<->English translator for a beginner.
The user entered: "${t}"
Detect whether it is English or Japanese and translate to the other language.
Respond ONLY with a JSON object (no markdown):
{
  "sourceLang": "English" or "Japanese",
  "targetLang": "Japanese" or "English",
  "japanese": "the Japanese version of the sentence (whether source or translation)",
  "romaji": "romaji of the Japanese version",
  "english": "the English version of the sentence",
  "breakdown": [
     { "word": "Japanese word/particle", "romaji": "romaji", "meaning": "English meaning", "note": "short grammar note (part of speech / role)" }
  ]
}
Break the Japanese sentence into its meaningful words/particles in order.`;
      const res = await askClaudeJSON(prompt);
      setResult(res);
      cacheSet(cacheKey, res);
    } catch (e) {
      setError(e.message || 'Translation failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type English or Japanese…"
          rows={3}
          className="w-full resize-none rounded-xl border border-neutral-700 bg-neutral-900 p-3 text-base outline-none focus:border-rose-500"
        />
        <button
          onClick={translate}
          disabled={loading || !text.trim()}
          className="w-full rounded-xl bg-rose-600 py-3 font-bold text-white transition hover:bg-rose-500 disabled:opacity-40"
        >{loading ? 'Translating…' : '🔁 Translate'}</button>
      </div>

      {error && <div className="rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-300">{error}</div>}

      {result && (
        <div className="space-y-4">
          <div className="rounded-2xl border border-neutral-800 bg-neutral-900/60 p-4">
            <div className="mb-2 text-xs font-semibold uppercase tracking-widest text-neutral-500">
              {result.sourceLang} → {result.targetLang}
            </div>
            <div className="flex items-start justify-between gap-2">
              <div className="text-2xl font-bold leading-snug">{result.japanese}</div>
              <button
                onClick={() => speakJapanese(result.japanese)}
                className="shrink-0 rounded-full bg-neutral-800 px-3 py-1.5 text-sm hover:bg-neutral-700"
              >🔊</button>
            </div>
            {result.romaji && <div className="mt-1 text-base italic text-sky-300">{result.romaji}</div>}
            {result.english && <div className="mt-1 text-base text-neutral-300">{result.english}</div>}
          </div>

          {Array.isArray(result.breakdown) && result.breakdown.length > 0 && (
            <div>
              <div className="mb-2 text-xs font-semibold uppercase tracking-widest text-neutral-500">Word by word</div>
              <div className="space-y-2">
                {result.breakdown.map((w, i) => (
                  <div key={i} className="flex items-center gap-3 rounded-xl border border-neutral-800 bg-neutral-900/60 p-3">
                    <button
                      onClick={() => speakJapanese(w.word)}
                      className="shrink-0 rounded-full bg-neutral-800 px-2 py-1 text-xs hover:bg-neutral-700"
                    >🔊</button>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="text-lg font-bold">{w.word}</span>
                        <span className="text-sm italic text-sky-300">{w.romaji}</span>
                        <span className="text-sm text-neutral-300">{w.meaning}</span>
                      </div>
                      {w.note && <div className="mt-0.5 text-xs text-amber-300/80">{w.note}</div>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
