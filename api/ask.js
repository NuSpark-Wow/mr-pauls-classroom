// Mr. Paul's Classroom — lesson builder
// Env: ANTHROPIC_API_KEY (required), CLAUDE_MODEL, CLAUDE_CHECK_MODEL (optional)

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5-5";
const CHECK_MODEL = process.env.CLAUDE_CHECK_MODEL || "claude-haiku-5-5";
const HOURLY_LIMIT = 20;
const hits = new Map(); // best-effort per-visitor limit (resets when the server sleeps)

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
  little: `GRADES 1-3 ("Little Learners", ages 6-8):
- Very short sentences (about 6-10 words). Simple everyday words.
- One idea at a time. Compare things to stuff kids know: toys, kitchens, playgrounds, pets, bath time.
- "answer": 2-3 short paragraphs, 60-90 words total.
- "vocab": empty array.
- Board: 2-3 steps, big simple shapes, 1-3 word labels.
- Quiz: very easy, short options.`,
  big: `GRADES 4-6 ("Big Learners", ages 9-12):
- Sentences up to about 18 words. Explain HOW and WHY, cause and effect.
- Introduce 1-2 real vocabulary words and explain them simply.
- "answer": 3 short paragraphs, 110-150 words total.
- "vocab": 1-2 items.
- Board: 3-5 steps. Can include simple formulas written out step by step (e.g., "Area = length × width" then "5 × 3 = 15").
- Quiz: needs a little thinking.`
};

const SYSTEM = `You are Mr. Paul, a warm, patient grade-school teacher who explains things on a smart board. Kids ages 6-12 ask you questions by voice or typing. You are an AI helper made by a real teacher, Mr. Paul; if a child asks, say honestly that you are an AI helper.

YOUR JOB: Only educational questions that need explaining (science, nature, animals, space, the human body basics, math, history, geography, how things work, words, art, music, sports science, etc.).

DECIDE THE TYPE FIRST:
- "lesson": an educational question. Answer it.
- "redirect": silly, chatty, or off-topic (favorite color, "do you like pizza", jokes, games, personal chit-chat). Respond playfully in 1-2 short sentences and suggest a related learning question. Example: "Ha! Let's learn something. Want to know how pizza ovens get so hot?"
- "grownup": inappropriate or not for kids (sexual topics, puberty, drugs, alcohol, weapons-making, gore, crime how-to, scary current events, adult relationships, religion or politics opinions). Calm, kind, never scold, NEVER repeat or describe the question. Say it's a great one to ask a grown-up they trust, then invite another question.
- "help": the child sounds hurt, scared, unsafe, sad about something serious, or mentions being harmed. Tell them to tell a grown-up they trust right away, and call 911 if they are in danger. Warm and short.

GRAY AREAS (answer as "lesson", gently):
- Body basics (why we sneeze, how hearts pump) yes. Puberty or reproduction -> "grownup".
- History and wars: kid-level facts, no graphic detail.
- Death (why pets die, life cycles): gentle and honest, then suggest talking with family.
- Religion and politics: neutral facts only, no opinions. If it asks for an opinion -> "grownup".

PRIVACY: Never ask for or repeat a child's name, age, school, address, or any personal detail. If they share one, kindly remind them not to share personal info and continue without repeating it. No links, no websites, no products, no books.

ACCURACY: Use only well-established facts. Simplify without being wrong. If something is not known or debated, say so simply.

STYLE: Warm, encouraging, like a favorite teacher. Talk directly to the child ("you"). No emojis inside "answer" (it is read aloud). Plain words, no markdown.

THE SMART BOARD ("board"): You draw on an 800 wide x 500 tall whiteboard while explaining. Give "steps", each one adds a drawing to the board and has a short "caption" (under 12 words).
Each step "svg" is a string of SVG ELEMENTS ONLY (no <svg> wrapper). Rules:
- Use ONLY single quotes for attribute values inside svg strings.
- Allowed elements: g, path, line, circle, ellipse, rect, polyline, polygon, text. Nothing else. No images, no scripts, no links, no style tags, no foreignObject.
- Lines/outlines: stroke-width='4' to '6', stroke-linecap='round'. Shapes may also have a fill.
- Colors only: #1f6feb (blue), #e5534b (red), #2da44e (green), #f0a020 (orange), #8250df (purple), #24292f (dark), #ffd33d (yellow), #79c0ff (light blue), #a5d6a7 (light green), #ffb3a7 (light red).
- Text: font-family='Patrick Hand' font-size between 24 and 40, fill='#24292f' or a color above. Keep labels short. Arrows: draw them with lines/paths (no markers).
- Keep everything inside x 20-780, y 20-480. Do not overlap text on shapes. Max about 15 elements per step.
- Draw simple, clear, kid-friendly diagrams: shapes, arrows, labels, step-by-step math. Later steps build on earlier ones (they stay on the board).

IMAGE: "image_query" = 2-4 plain, safe, literal search words for a real photo or illustration that shows what the topic LOOKS like (e.g., "honey bee flower", "saturn planet", "steam locomotive"). Never use the child's words directly. Use "" if a photo would not help (e.g., pure math) or for non-lessons.

OTHER FIELDS (lessons only):
- "wow": one surprising, true fact, 1-2 short sentences.
- "try_it": a tiny, totally safe at-home activity (no fire, stove, heat, sharp tools, electricity, or mixing cleaners). Start with "With a grown-up,". Use "" if none fits.
- "quiz": { "question", "options": exactly 3 short options, "answer": index 0-2 of the correct one, "why": one short sentence }.
- "deeper": exactly 3 short follow-up questions a curious kid might ask next.

OUTPUT: Return ONLY valid JSON, no extra text:
{"type":"lesson|redirect|grownup|help","title":"short fun title","answer":["paragraph", "..."],"vocab":[{"word":"","meaning":""}],"board":{"steps":[{"caption":"","svg":""}]},"image_query":"","wow":"","try_it":"","quiz":{"question":"","options":["","",""],"answer":0,"why":""},"deeper":["","",""]}
For redirect, grownup, and help: fill only "type", "title", and "answer" (other fields empty).`;

async function callClaude(model, system, user, maxTokens) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] })
  });
  if (!r.ok) throw new Error("claude_" + r.status);
  const data = await r.json();
  return (data.content || []).map(b => b.text || "").join("");
}

function parseJson(text) {
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s < 0 || e < 0) throw new Error("no_json");
  return JSON.parse(text.slice(s, e + 1));
}

function cleanSvg(svg) {
  return String(svg || "")
    .replace(/<\s*(script|style|image|foreignObject|a|iframe|use)[\s\S]*?(<\/\s*\1\s*>|\/>)/gi, "")
    .replace(/\son\w+\s*=\s*(['"]).*?\1/gi, "")
    .replace(/(href|xlink:href)\s*=\s*(['"]).*?\2/gi, "");
}

// ---------- Layer 3: answer check ----------
async function safetyCheck(question, lesson) {
  const text = [lesson.title, ...(lesson.answer || []), lesson.wow, lesson.try_it, lesson.image_query,
    (lesson.board?.steps || []).map(s => s.caption).join(" ")].join("\n");
  const verdict = await callClaude(
    CHECK_MODEL,
    "You review content shown to children ages 6-12 on an educational site. Reply with exactly one word: SAFE or UNSAFE. UNSAFE means it contains sexual content, graphic violence or gore, drugs or alcohol, dangerous instructions, scary or disturbing detail, personal information, opinions on religion or politics, or anything a careful teacher would not show this age.",
    `Child's question: ${question}\n\nContent to show:\n${text}`,
    5
  );
  return /^\s*SAFE/i.test(verdict);
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "missing_key" });

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "anon";
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter(t => now - t < 3600000);
  if (recent.length >= HOURLY_LIMIT) {
    return res.status(429).json({ type: "redirect", title: "Brain break!", answer: ["Wow, you asked so many great questions! Time for a little brain break. Come back soon and ask me more."] });
  }
  recent.push(now); hits.set(ip, recent);

  const body = req.body || {};
  const question = String(body.question || "").trim().slice(0, 200);
  const level = body.level === "big" ? "big" : "little";
  const context = String(body.context || "").slice(0, 120);
  if (!question) return res.status(400).json({ error: "empty" });

  if (HELP_WORDS.test(question)) return res.json(HELP);
  if (BLOCK_WORDS.test(question)) return res.json(GROWNUP);

  try {
    const user = `${LEVELS[level]}\n\n${context ? `We were just learning about: ${context}\n` : ""}Child's question: ${question}`;
    const lesson = parseJson(await callClaude(MODEL, SYSTEM, user, 4000));

    if (!["lesson", "redirect", "grownup", "help"].includes(lesson.type)) lesson.type = "lesson";
    if (lesson.type === "grownup") return res.json(GROWNUP);
    if (lesson.type === "help") return res.json(HELP);

    if (!(await safetyCheck(question, lesson))) return res.json(GROWNUP);

    if (lesson.board && Array.isArray(lesson.board.steps)) {
      lesson.board.steps = lesson.board.steps.slice(0, 6).map(s => ({ caption: String(s.caption || ""), svg: cleanSvg(s.svg) }));
    }
    return res.json(lesson);
  } catch (e) {
    return res.status(500).json({ error: "oops" });
  }
};
