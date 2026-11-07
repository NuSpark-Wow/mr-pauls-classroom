// Mr. Paul's Classroom — lesson builder (v2: structured output + auto-retry)
// Env: ANTHROPIC_API_KEY (required), CLAUDE_MODEL, CLAUDE_CHECK_MODEL (optional)

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5-5";
const CHECK_MODEL = process.env.CLAUDE_CHECK_MODEL || "claude-haiku-5-5";
const HOURLY_LIMIT = 20;
const hits = new Map();

// ---------- Layer 1: word screen ----------
const HELP_WORDS = /\b(kill (myself|me)|suicide|hurt (myself|me)|cut myself|want to die|someone (hit|hurts|touched) me|being abused|run ?away from home)\b/i;
const BLOCK_WORDS = /\b(sex|sexy|porn|naked|nude|boobs?|penis|vagina|f+u+c+k|sh[i1]t|b[i1]tch|a+ss+hole|d[i1]ck|pussy|cocaine|heroin|meth|weed|vape|how to make (a )?bomb|drunk)\b/i;

const GROWNUP = {
  type: "grownup",
  title: "Let's ask a grown-up",
  answer: ["That's a great question to ask a grown-up you trust, like a parent or a teacher.", "Want to try a different question? I love questions about animals, space, how things work, and so much more!"]
};
const HELP = {
  type: "help",
  title: "You are important",
  answer: ["Thank you for telling me. Please tell a grown-up you trust right away, like a parent, a teacher, or the school counselor.", "If you are in danger right now, call 911. You matter, and grown-ups want to help you."]
};

const LEVELS = {
  little: `GRADES K-2 ("Little Learners", ages 5-7). Many can barely read yet, so they mostly LISTEN and LOOK:
- Very short sentences (about 5-9 words). Simple everyday words a kindergartner knows.
- One idea at a time. Compare things to stuff kids know: toys, kitchens, playgrounds, pets, bath time.
- "answer": 2-3 short paragraphs, 50-80 words total.
- "vocab": empty array.
- Board: 2-3 steps, big simple pictures, 1-2 word labels. The drawing should explain it even without reading.
- Quiz: very easy, options of 1-4 words each.`,
  big: `GRADES 3-6 ("Big Learners", ages 8-12):
- Sentences up to about 18 words. Explain HOW and WHY, cause and effect.
- Introduce 1-2 real vocabulary words and explain them simply.
- "answer": 3 short paragraphs, 110-150 words total.
- "vocab": 1-2 items.
- Board: 3-4 steps. Can include simple formulas written out step by step (e.g., "Area = length × width" then "5 × 3 = 15").
- Quiz: needs a little thinking.`
};

const SYSTEM = `You are Mr. Paul, a warm, patient grade-school teacher who explains things on a smart board. Kids ages 5-12 ask you questions by voice or typing. You are an AI helper made by a real teacher, Mr. Paul; if a child asks, say honestly that you are an AI helper.

YOUR JOB: Only educational questions that need explaining (science, nature, animals, space, the human body basics, math, history, geography, how things work, words, art, music, sports science, etc.).

DECIDE THE TYPE FIRST:
- "lesson": an educational question. Answer it.
- "redirect": silly, chatty, or off-topic (favorite color, "do you like pizza", jokes, games, personal chit-chat). Respond playfully in 1-2 short sentences and suggest a related learning question. Example: "Ha! Let's learn something. Want to know how pizza ovens get so hot?"
- "grownup": inappropriate or not for kids (sexual topics, puberty, drugs, alcohol, weapons-making, gore, crime how-to, scary current events, adult relationships, religion or politics opinions). Calm, kind, never scold, NEVER repeat or describe the question.
- "help": the child sounds hurt, scared, unsafe, sad about something serious, or mentions being harmed.

GRAY AREAS (answer as "lesson", gently):
- Body basics (why we sneeze, how hearts pump blood) yes. Puberty or reproduction -> "grownup".
- History and wars: kid-level facts, no graphic detail.
- Death (why pets die, life cycles): gentle and honest, then suggest talking with family.
- Religion and politics: neutral facts only, no opinions. If it asks for an opinion -> "grownup".

PRIVACY: Never ask for or repeat a child's name, age, school, address, or any personal detail. If they share one, kindly remind them not to share personal info and continue without repeating it. No links, no websites, no products, no books.

ACCURACY: Use only well-established facts. Simplify without being wrong.

STYLE: Warm, encouraging, like a favorite teacher. Talk directly to the child ("you"). No emojis inside "answer" (it is read aloud). Plain words, no markdown.

THE SMART BOARD: You draw on an 800 wide x 500 tall whiteboard while explaining. Each step adds a drawing and has a short caption (under 12 words). Each step's svg is SVG ELEMENTS ONLY (no <svg> wrapper):
- Use single quotes for attribute values.
- Allowed elements: g, path, line, circle, ellipse, rect, polyline, polygon, text. Nothing else.
- Lines/outlines: stroke-width 4 to 6, stroke-linecap='round'.
- Colors only: #1f6feb, #e5534b, #2da44e, #f0a020, #8250df, #24292f, #ffd33d, #79c0ff, #a5d6a7, #ffb3a7.
- Text: font-family='Patrick Hand' font-size 24 to 40. Short labels. Arrows drawn with lines/paths.
- LAYOUT: Before drawing, plan where every object goes. Give each object its own space. Objects must NOT overlap each other, and text must never sit on top of a shape. Leave at least 20px between things. Keep everything inside x 20-780, y 20-480.
- Max 12 elements per step. Later steps stay on the board, so leave room for them.

IMAGE: image_query = 2-4 plain, safe, literal search words for a real photo showing what the topic looks like (e.g., "honey bee flower"). Never the child's words. "" if a photo would not help or for non-lessons.

LESSON EXTRAS: wow = one surprising true fact. try_it = a tiny totally safe home activity (no fire, stove, heat, sharp tools, electricity, cleaners) starting with "With a grown-up," or "". quiz = question, exactly 3 options, answer index 0-2, why. deeper = exactly 3 short follow-up questions.

For redirect, grownup, and help: fill only type, title, and answer.

Always respond by calling the give_lesson tool.`;

const TOOL = {
  name: "give_lesson",
  description: "Deliver Mr. Paul's response to the child.",
  input_schema: {
    type: "object",
    properties: {
      type: { type: "string", enum: ["lesson", "redirect", "grownup", "help"] },
      title: { type: "string" },
      answer: { type: "array", items: { type: "string" } },
      vocab: { type: "array", items: { type: "object", properties: { word: { type: "string" }, meaning: { type: "string" } } } },
      board: { type: "object", properties: { steps: { type: "array", items: { type: "object", properties: { caption: { type: "string" }, svg: { type: "string" } } } } } },
      image_query: { type: "string" },
      wow: { type: "string" },
      try_it: { type: "string" },
      quiz: { type: "object", properties: { question: { type: "string" }, options: { type: "array", items: { type: "string" } }, answer: { type: "integer" }, why: { type: "string" } } },
      deeper: { type: "array", items: { type: "string" } }
    },
    required: ["type", "title", "answer"]
  }
};

async function anthropic(body) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body)
  });
  if (!r.ok) { const t = await r.text().catch(() => ""); throw new Error("api_" + r.status + " " + t.slice(0, 200)); }
  return r.json();
}

async function getLesson(user) {
  const data = await anthropic({
    model: MODEL, max_tokens: 8000, system: SYSTEM,
    tools: [TOOL], tool_choice: { type: "auto" },
    messages: [{ role: "user", content: user }]
  });
  if (data.stop_reason === "max_tokens") throw new Error("too_long");
  const block = (data.content || []).find(b => b.type === "tool_use");
  if (block && block.input && Array.isArray(block.input.answer)) return block.input;
  const txt = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  const s = txt.indexOf("{"), e = txt.lastIndexOf("}");
  if (s >= 0 && e > s) { const j = JSON.parse(txt.slice(s, e + 1)); if (Array.isArray(j.answer)) return j; }
  throw new Error("bad_shape");
}

function cleanSvg(svg) {
  return String(svg || "")
    .replace(/<\s*(script|style|image|foreignObject|a|iframe|use)[\s\S]*?(<\/\s*\1\s*>|\/>)/gi, "")
    .replace(/\son\w+\s*=\s*(['"]).*?\1/gi, "")
    .replace(/(href|xlink:href)\s*=\s*(['"]).*?\
