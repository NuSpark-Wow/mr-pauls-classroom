// Mr. Paul's Classroom — lesson + smart-board builder (v3)
// v3: answer and drawing are made at the same time (faster), repeat questions are saved
// on Vercel's network (instant + free), and Spanish is supported.
// Env: ANTHROPIC_API_KEY (required), CLAUDE_MODEL, CLAUDE_CHECK_MODEL (optional)

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5-5";
const CHECK_MODEL = process.env.CLAUDE_CHECK_MODEL || "claude-haiku-5-5";
// The drawing step uses the faster model. To switch back, add BOARD_MODEL = claude-sonnet-5-5 in Vercel settings.
const BOARD_MODEL = process.env.BOARD_MODEL || "claude-haiku-5-5";
const HOURLY_LIMIT = 20;
const hits = new Map();

// ---------- Layer 1: word screen (English + Spanish) ----------
const HELP_WORDS = /\b(kill (myself|me)|suicide|hurt (myself|me)|cut myself|want to die|someone (hit|hurts|touched) me|being abused|run ?away from home)\b|(matarme|suicid|lastimarme|hacerme da|quiero morir|me pegan|abusan de m)/i;
const BLOCK_WORDS = /\b(sex|sexy|porn|naked|nude|boobs?|penis|vagina|f+u+c+k|sh[i1]t|b[i1]tch|a+ss+hole|d[i1]ck|pussy|cocaine|heroin|meth|weed|vape|how to make (a )?bomb|drunk|sexo|porno|desnud[oa]s?|drogas?|mierda|puta|marihuana|borracho)\b/i;

const GROWNUP = {
  en: { type: "grownup", title: "Let's ask a grown-up", answer: ["That's a great question to ask a grown-up you trust, like a parent or a teacher.", "Want to try a different question? I love questions about animals, space, how things work, and so much more!"] },
  es: { type: "grownup", title: "Pregúntale a un adulto", answer: ["Esa es una gran pregunta para un adulto de confianza, como tu mamá, tu papá o tu maestra.", "¿Quieres intentar otra pregunta? ¡Me encantan las preguntas sobre animales, el espacio, cómo funcionan las cosas y mucho más!"] }
};
const HELP = {
  en: { type: "help", title: "You are important", answer: ["Thank you for telling me. Please tell a grown-up you trust right away, like a parent, a teacher, or the school counselor.", "If you are in danger right now, call 911. You matter, and grown-ups want to help you."] },
  es: { type: "help", title: "Eres importante", answer: ["Gracias por contármelo. Por favor, díselo ahora mismo a un adulto de confianza, como tus papás, tu maestra o el consejero de la escuela.", "Si estás en peligro ahora mismo, llama al 911. Tú importas, y los adultos quieren ayudarte."] }
};
const BREAK = {
  en: { type: "redirect", title: "Brain break!", answer: ["Wow, you asked so many great questions! Time for a little brain break. Come back soon and ask me more."] },
  es: { type: "redirect", title: "¡Descanso!", answer: ["¡Guau, hiciste muchas preguntas geniales! Es hora de un pequeño descanso. Vuelve pronto y pregúntame más."] }
};

const LEVELS = {
  little: `GRADES K-2 ("Little Learners", ages 5-7). Many can barely read yet, so they mostly LISTEN and LOOK:
- Very short sentences (about 5-9 words). Simple everyday words a kindergartner knows.
- One idea at a time. Compare things to stuff kids know: toys, kitchens, playgrounds, pets, bath time.
- "answer": 2-3 short paragraphs, 50-80 words total.
- "vocab": empty array.
- Quiz: very easy, options of 1-4 words each.
- Board: 2-3 steps, big simple pictures, 1-2 word labels. The drawing should explain it even without reading.`,
  big: `GRADES 3-6 ("Big Learners", ages 8-12):
- Sentences up to about 18 words. Explain HOW and WHY, cause and effect.
- Introduce 1-2 real vocabulary words and explain them simply.
- "answer": 3 short paragraphs, 110-150 words total.
- "vocab": 1-2 items.
- Quiz: needs a little thinking.
- Board: 3-4 steps. Can include simple formulas written out step by step (e.g., "Area = length × width" then "5 × 3 = 15").`
};

const SPANISH = `IMPORTANT: Write EVERYTHING the child will see or hear (title, answer, vocab, quiz, wow, try_it, deeper, captions, board labels) in simple, friendly Latin American Spanish. Keep image_query in ENGLISH.`;

const SYSTEM_LESSON = `You are Mr. Paul, a warm, patient grade-school teacher. Kids ages 5-12 ask you questions by voice or typing. You are an AI helper made by a real teacher, Mr. Paul; if a child asks, say honestly that you are an AI helper. (A separate artist draws the smart-board pictures; you write the words.)

YOUR JOB: Only educational questions that need explaining (science, nature, animals, space, the human body basics, math, history, geography, how things work, words, art, music, sports science, etc.).

DECIDE THE TYPE FIRST:
- "lesson": an educational question. Answer it.
- "redirect": silly, chatty, or off-topic (favorite color, "do you like pizza", jokes, games, personal chit-chat). Respond playfully in 1-2 short sentences and suggest a related learning question. Example: "Ha! Let's learn something. Want to know how pizza ovens get so hot?"
- "grownup": inappropriate or not for kids (sexual topics, puberty, drugs, alcohol, weapons-making, gore, crime how-to, scary current events, adult relationships, religion or politics opinions). Calm, kind, never scold, NEVER repeat or describe the question.
- When in doubt, TEACH. Everyday curiosity is always a "lesson": how things are built or made (roofs, houses, bridges, cars, pencils, candy), jobs, tools, machines, food, cooking, weather, sports, games, music, money basics, the body, animals, plants, places, inventions, and history. "grownup" is ONLY for the specific topics listed above.
- "help": the child sounds hurt, scared, unsafe, sad about something serious, or mentions being harmed.

GRAY AREAS (answer as "lesson", gently):
- Body basics (why we sneeze, how hearts pump blood) yes. Puberty or reproduction -> "grownup".
- History and wars: kid-level facts, no graphic detail.
- Death (why pets die, life cycles): gentle and honest, then suggest talking with family.
- Religion and politics: neutral facts only, no opinions. If it asks for an opinion -> "grownup".

PRIVACY: Never ask for or repeat a child's name, age, school, address, or any personal detail. If they share one, kindly remind them not to share personal info and continue without repeating it. No links, no websites, no products, no books.

ACCURACY: Use only well-established facts. Simplify without being wrong.

STYLE: Warm, encouraging, like a favorite teacher. Talk directly to the child ("you"). No emojis inside "answer" (it is read aloud). Plain words, no markdown.

IMAGE: image_query = 2-4 plain, safe, literal English search words for a real photo showing what the topic looks like (e.g., "honey bee flower"). Never the child's words. "" if a photo would not help or for non-lessons.

LESSON EXTRAS: wow = one surprising true fact. try_it = a tiny totally safe home activity (no fire, stove, heat, sharp tools, electricity, cleaners) starting with "With a grown-up," (or "Con un adulto," in Spanish) or "". quiz = question, exactly 3 options, answer index 0-2, why. deeper = exactly 3 short follow-up questions.

For redirect, grownup, and help: fill only type, title, and answer.

Always respond by calling the give_lesson tool.`;

const SYSTEM_BOARD = `You are the smart-board artist for Mr. Paul, a grade-school teacher. Given a child's question, draw the step-by-step diagram a great teacher would sketch on a whiteboard while explaining the answer.

If the question is NOT an appropriate educational question for young children (inappropriate, scary, personal chit-chat), return steps: [].

THE SMART BOARD: an 800 wide x 500 tall whiteboard. Each step is its own complete picture with a short caption (under 12 words). Each step's svg is SVG ELEMENTS ONLY (no <svg> wrapper):
- Use single quotes for attribute values.
- Allowed elements: g, path, line, circle, ellipse, rect, polyline, polygon, text. Nothing else.
- Lines/outlines: stroke-width 4 to 6, stroke-linecap='round'.
- Colors only: #1f6feb, #e5534b, #2da44e, #f0a020, #8250df, #24292f, #ffd33d, #79c0ff, #a5d6a7, #ffb3a7.
- Text: font-family='Patrick Hand' font-size 24 to 40. Short labels. Arrows drawn with lines/paths.
- LAYOUT: Before drawing, plan where every object goes. Give each object its own space. Objects must NOT overlap each other, and text must never sit on top of a shape. Leave at least 20px between things. Keep everything inside x 20-780, y 20-480.
- Max 12 elements per step. EACH STEP STANDS ALONE: the board is wiped clean before every step, so draw the whole picture for that step using the full board. Never rely on shapes from earlier steps.
- Put every label BELOW or BESIDE its shape, never inside it or across it. Each label needs its own empty space, at least 30px from other words.
- Simple, clear, kid-friendly: shapes, arrows, labels, step-by-step math.

LEGEND: for each step, list every math sign, symbol, or unit abbreviation that appears in that step's svg (for example ×, ÷, =, +, °F, °C, cm, kg, %), each with a very short kid-friendly meaning (for example "× means times", "cm means centimeters"). Write meanings in the same language as the lesson. Use [] when a step has no symbols, which is most of the time for pictures.
FORMULAS: for every math sentence or formula written in a step (for example "5 × 3 = 15" or "Area = length × width"), give the "formula" exactly as written and an "explanation": one short, friendly sentence a kid can understand, ideally with a picture in words (for example "5 groups of 3 apples make 15 apples"). Same language as the lesson. Use [] if the step has none.

Always respond by calling the give_board tool.`;

// Live drawing: the artist writes one step at a time in this plain format,
// and each finished step is sent to the page right away.
const STREAM_FORMAT = `OUTPUT FORMAT (IMPORTANT): plain text only, no JSON, no tools. Write each step as its own block, in drawing order, exactly like this:
=== STEP
CAPTION: the short caption
SVG: all of this step's svg elements on ONE line
LEGEND: symbol | meaning ;; symbol | meaning
FORMULAS: formula | explanation ;; formula | explanation
=== END
Leave LEGEND or FORMULAS empty when there are none. Write nothing before the first block or after the last one. If the question is not appropriate, write only: === NONE`;
const SYSTEM_BOARD_STREAM = SYSTEM_BOARD.replace("Always respond by calling the give_board tool.", STREAM_FORMAT);

const LESSON_TOOL = {
  name: "give_lesson",
  description: "Deliver Mr. Paul's words to the child.",
  input_schema: {
    type: "object",
    properties: {
      type: { type: "string", enum: ["lesson", "redirect", "grownup", "help"] },
      title: { type: "string" },
      answer: { type: "array", items: { type: "string" } },
      vocab: { type: "array", items: { type: "object", properties: { word: { type: "string" }, meaning: { type: "string" } } } },
      image_query: { type: "string" },
      wow: { type: "string" },
      try_it: { type: "string" },
      quiz: { type: "object", properties: { question: { type: "string" }, options: { type: "array", items: { type: "string" } }, answer: { type: "integer" }, why: { type: "string" } } },
      deeper: { type: "array", items: { type: "string" } }
    },
    required: ["type", "title", "answer"]
  }
};
const BOARD_TOOL = {
  name: "give_board",
  description: "Deliver the smart-board drawing steps.",
  input_schema: {
    type: "object",
    properties: { steps: { type: "array", items: { type: "object", properties: { caption: { type: "string" }, svg: { type: "string" }, legend: { type: "array", items: { type: "object", properties: { symbol: { type: "string" }, meaning: { type: "string" } } } }, formulas: { type: "array", items: { type: "object", properties: { formula: { type: "string" }, explanation: { type: "string" } } } } } } } },
    required: ["steps"]
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

// Calls Claude with a tool; reads the tool answer, or plain JSON text as a backup.
async function callTool(system, tool, user, maxTokens, check, model) {
  const data = await anthropic({
    model: model || MODEL, max_tokens: maxTokens, system,
    tools: [tool], tool_choice: { type: "auto" },
    messages: [{ role: "user", content: user }]
  });
  if (data.stop_reason === "max_tokens") throw new Error("too_long");
  const block = (data.content || []).find(b => b.type === "tool_use");
  if (block && block.input && check(block.input)) return block.input;
  const txt = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  const s = txt.indexOf("{"), e = txt.lastIndexOf("}");
  if (s >= 0 && e > s) { const j = JSON.parse(txt.slice(s, e + 1)); if (check(j)) return j; }
  throw new Error("bad_shape");
}

async function streamClaude(system, user, maxTokens, model, onText) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, stream: true, thinking: { type: "disabled" }, messages: [{ role: "user", content: user }] })
  });
  if (!r.ok) { const t = await r.text().catch(() => ""); throw new Error("api_" + r.status + " " + t.slice(0, 200)); }
  const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const ev = buf.slice(0, i); buf = buf.slice(i + 2);
      for (const line of ev.split("\n")) {
        if (!line.startsWith("data:")) continue;
        let d; try { d = JSON.parse(line.slice(5)); } catch (e) { continue; }
        if (d.type === "content_block_delta" && d.delta && d.delta.type === "text_delta") onText(d.delta.text);
        if (d.type === "error") throw new Error("api_529 " + JSON.stringify(d.error || {}).slice(0, 120));
      }
    }
  }
}

function pairs(str, maxA, maxB, limit) {
  return String(str || "").split(";;").map(x => x.split("|")).filter(p => p.length >= 2)
    .map(p => [p[0].trim().slice(0, maxA), p.slice(1).join("|").trim().slice(0, maxB)]).filter(p => p[0] && p[1]).slice(0, limit);
}
function parseBlock(block) {
  const f = { TITLE: "", CAPTION: "", SVG: "", LEGEND: "", FORMULAS: "" }; let key = null;
  for (const raw of block.split("\n")) {
    const m = raw.match(/^\s*(TITLE|CAPTION|SVG|LEGEND|FORMULAS)\s*:\s*(.*)$/);
    if (m) { key = m[1]; f[key] = m[2]; }
    else if (key && raw.trim()) f[key] += " " + raw.trim();
  }
  return { title: f.TITLE.trim(), caption: f.CAPTION.trim(), svg: cleanSvg(f.SVG.trim()),
    legend: pairs(f.LEGEND, 20, 160, 10).map(([symbol, meaning]) => ({ symbol, meaning })),
    formulas: pairs(f.FORMULAS, 80, 400, 4).map(([formula, explanation]) => ({ formula, explanation })) };
}

// Streams drawing steps to the page as newline-separated JSON, one finished step per line.
async function streamBoard(res, isGet, user, maxSteps, kidsLimits) {
  let wrote = false, count = 0, text = "", lastErr = null, none = false;
  const start = () => {
    if (wrote) return; wrote = true;
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", isGet ? "public, s-maxage=2592000, stale-while-revalidate=604800" : "no-store");
    res.setHeader("X-Accel-Buffering", "no");
  };
  const flush = () => {
    if (text.includes("=== NONE")) none = true;
    let a, b;
    while ((a = text.indexOf("=== STEP")) >= 0 && (b = text.indexOf("=== END", a)) >= 0) {
      const step = parseBlock(text.slice(a + 8, b)); text = text.slice(b + 7);
      if (!step.svg || count >= maxSteps) continue;
      if (kidsLimits) { step.legend = step.legend.slice(0, 8); step.formulas = step.formulas.slice(0, 3); delete step.title; }
      start(); res.write(JSON.stringify(step) + "\n"); count++;
    }
  };
  for (let attempt = 0; attempt < 2 && !wrote && !none; attempt++) {
    text = "";
    try { await streamClaude(SYSTEM_BOARD_STREAM, user, 8000, BOARD_MODEL, t => { text += t; flush(); }); flush(); lastErr = null; }
    catch (e) { lastErr = e; console.error("drawing attempt", attempt + 1, "failed:", e.message); }
    if (wrote || none) break;
  }
  if (wrote) { res.write(JSON.stringify({ done: true }) + "\n"); return res.end(); }
  if (none || !lastErr) {
    res.setHeader("Cache-Control", isGet && none ? "public, s-maxage=2592000" : "no-store");
    return res.status(200).json({ steps: [], done: true });
  }
  res.setHeader("Cache-Control", "no-store");
  return res.status(500).json({ error: "oops", reason: errorCode(lastErr) });
}

async function withRetry(fn, budgetMs) {
  const start = Date.now(); let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt === 1 && Date.now() - start > budgetMs) break;
    try { return await fn(); }
    catch (e) { lastErr = e; console.error("attempt", attempt + 1, "failed:", e.message); }
  }
  throw lastErr || new Error("failed");
}

function errorCode(err) {
  const m = String(err && err.message || "");
  return m.startsWith("api_429") ? "R2" : m.startsWith("api_5") ? "B3" : m === "too_long" ? "L4" : m.startsWith("api_4") ? "A5" : "S6";
}

// The page itself only allows safe drawing shapes; this is an extra first pass.
function cleanSvg(svg) {
  let s = String(svg || "");
  ["<script", "<style", "<image", "<foreignObject", "<iframe", "<use", "javascript:", "href="].forEach(bad => {
    s = s.split(bad).join("");
  });
  return s;
}

// ---------- Layer 3: answer check ----------
async function safetyCheck(question, lesson) {
  const text = [lesson.title, ...(lesson.answer || []), lesson.wow, lesson.try_it, lesson.image_query].join("\n");
  const data = await anthropic({
    model: CHECK_MODEL, max_tokens: 20, thinking: { type: "disabled" },
    system: "You review content shown to children ages 5-12 on an educational site (English or Spanish). Reply with exactly one word: SAFE or UNSAFE. UNSAFE means it contains sexual content, graphic violence or gore, drugs or alcohol, dangerous instructions, scary or disturbing detail, personal information, opinions on religion or politics, or anything a careful teacher would not show this age. Normal science about the body (blood, heart, bones) is SAFE.",
    messages: [{ role: "user", content: `Child's question: ${question}\n\nContent to show:\n${text}` }]
  });
  const verdict = (data.content || []).filter(b => b.type === "text").map(b => b.text || "").join("");
  if (!verdict.trim()) { console.error("safety check gave no answer"); throw new Error("blank_verdict"); }
  // Only an explicit UNSAFE blocks; formatting like "**SAFE**" or "Safe." passes.
  const unsafe = /UNSAFE|NOT\s+SAFE/i.test(verdict);
  if (unsafe) console.error("safety check said UNSAFE for topic:", String(lesson && lesson.title || "").slice(0, 80));
  return !unsafe;
}

module.exports = async (req, res) => {
  const isGet = req.method === "GET";
  if (!isGet && req.method !== "POST") return res.status(405).json({ error: "GET or POST only" });

  // GET = a fresh question (saved on Vercel's network so repeats are instant).
  // POST = a follow-up with context (always made fresh).
  const send = (status, obj, cacheable) => {
    res.setHeader("Cache-Control", cacheable && isGet && status === 200 ? "public, s-maxage=2592000, stale-while-revalidate=604800" : "no-store");
    return res.status(status).json(obj);
  };
  if (!process.env.ANTHROPIC_API_KEY) return send(500, { error: "oops", reason: "K1" });

  const src = (isGet ? req.query : req.body) || {};
  const part = src.part === "board" ? "board" : "lesson";
  const question = String(src.q || src.question || "").trim().slice(0, 200);
  const level = src.level === "big" ? "big" : "little";
  const lang = src.lang === "es" ? "es" : "en";
  const context = isGet ? "" : String(src.context || "").slice(0, 120);
  const more = !isGet && src.more === true;
  const prev = isGet ? "" : String(src.prev || "").slice(0, 1200);
  // the drawing request carries Mr. Paul's answer, one paragraph per line, so each picture matches a paragraph
  const paras = String(src.a || "").split("\n").map(x => x.trim()).filter(Boolean).slice(0, 4).map(x => x.slice(0, 700));
  if (!question) return send(400, { error: "empty" });

  if (HELP_WORDS.test(question)) return send(200, part === "board" ? { steps: [] } : HELP[lang], true);
  if (BLOCK_WORDS.test(question)) return send(200, part === "board" ? { steps: [] } : GROWNUP[lang], true);

  // per-visitor limit counts lessons only (the drawing rides along)
  if (part === "lesson") {
    const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "anon";
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter(t => now - t < 3600000);
    if (recent.length >= HOURLY_LIMIT) return send(200, BREAK[lang], false);
    recent.push(now); hits.set(ip, recent);
  }

  let user = `${LEVELS[level]}${lang === "es" ? "\n\n" + SPANISH : ""}\n\n${context ? `We were just learning about: ${context}\n` : ""}Child's question: ${question}`;
  if (more) {
    user = `${LEVELS[level]}${lang === "es" ? "\n\n" + SPANISH : ""}\n\nThe child tapped "Tell me more" about: ${context}\nHere is what Mr. Paul ALREADY taught them:\n${prev}\n\nGo one step deeper on this same topic, at the same grade level, with NEW facts. Do not repeat what was already said. Make the title fun, like "More About ...".${/^(tell me more|cu[eé]ntame m[aá]s)/i.test(question) ? "" : `\nThe child especially wants to know: ${question}`}`;
  }

  if (part === "board") {
    if (paras.length) {
      user += `\n\nMr. Paul's answer, paragraph by paragraph:\n${paras.map((x, i) => `${i + 1}. ${x}`).join("\n")}\n\nDraw EXACTLY ${paras.length} steps, one per paragraph, in the same order. Step ${paras.length > 1 ? "k" : "1"} must show what paragraph ${paras.length > 1 ? "k" : "1"} is talking about, so the picture changes as Mr. Paul talks. The board is wiped between steps, so each step is a complete picture on its own.`;
    }
    return streamBoard(res, isGet, user, paras.length || 4, true);
  }

  let lesson;
  try {
    lesson = await withRetry(() => callTool(SYSTEM_LESSON, LESSON_TOOL, user, 4000, j => Array.isArray(j.answer)), 25000);
  } catch (e) {
    return send(500, { error: "oops", reason: errorCode(e) });
  }

  if (!["lesson", "redirect", "grownup", "help"].includes(lesson.type)) lesson.type = "lesson";
  if (lesson.type === "grownup") return send(200, GROWNUP[lang], true);
  if (lesson.type === "help") return send(200, HELP[lang], true);

  try {
    if (!(await safetyCheck(question, lesson))) return send(200, GROWNUP[lang], true);
  } catch (e) {
    console.error("safety check failed:", e.message);
    return send(500, { error: "oops", reason: "C7" });
  }
  return send(200, lesson, true);
};
