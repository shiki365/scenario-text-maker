/*!
 * parse.v1.js - text -> scenario text entries (no UI)
 *
 * Two ways to cut the text:
 *   "script"  one entry per line of dialogue. アリス「こんにちは」 or アリス：こんにちは becomes
 *             title アリス, text 「こんにちは」. CCFOLIA sends a scenario text with its title as the
 *             name, so the title is always the registered display name, whatever alias was used.
 *   "heading" one entry per heading (■図書館, 【図書館】, ## 図書館 ...): title = the heading,
 *             text = the lines below it. For descriptions and handouts.
 * A speaker name may carry a face (差分): アリス（笑顔）「…」 or アリス@笑顔「…」 picks the image
 * registered under 笑顔. The whole name is tried first, so a name that itself ends in
 * parentheses, such as アリス (ありす), still matches.
 *
 * Style "auto" accepts a colon line only for registered speakers, so narration such as
 * 「時刻：21時」 is not taken for a speaker named 時刻.
 */
(function (root) {
  "use strict";

  const QUOTE = /^\s*([^\s「」『』][^「」『』]*?)\s*([「『][\s\S]*[」』])\s*$/;
  const COLON = /^\s*([^\s：:「」『』][^：:「」『』]*?)\s*[：:]\s*([\s\S]+?)\s*$/;
  // Sentence punctuation means the part before the quote is prose, not a name.
  const PROSE = /[。、，．！？!?…]/;
  const FACE = /^(.+?)\s*(?:[（(]\s*([^（）()]+?)\s*[）)]|[@＠]\s*(\S+))$/;
  const HEADING = [/^\s*#{1,6}\s*(.+?)\s*#*\s*$/, /^\s*[■□◆◇●○▼▽★☆◎]\s*(.+?)\s*$/, /^\s*【(.+?)】\s*$/];
  const MAX_NAME = 40;
  const MAX_JOIN = 20;

  const key = s => String(s || "").normalize("NFKC").replace(/\s+/g, " ").trim();

  function aliasesOf(speaker) {
    return [speaker.name].concat(String(speaker.aliases || "").split(/[,、，]/)).map(key).filter(Boolean);
  }

  function speakerIndex(speakers) {
    const map = new Map();
    for (const sp of speakers || []) {
      for (const a of aliasesOf(sp)) if (!map.has(a)) map.set(a, sp);
    }
    return map;
  }

  // name as written -> { speaker, face, faceMissing } or null. face is the label as registered.
  function resolve(name, index) {
    const whole = index.get(key(name));
    if (whole) return { speaker: whole, face: "", faceMissing: false };
    const m = FACE.exec(String(name || "").trim());
    if (!m) return null;
    const sp = index.get(key(m[1]));
    if (!sp) return null;
    const written = (m[2] || m[3]).trim();
    const face = (sp.faces || []).find(f => key(f.label) === key(written));
    return { speaker: sp, face: face ? face.label : written, faceMissing: !face };
  }

  // Open quotes minus closed ones, so a line that opens 「 without closing it continues below.
  const openQuotes = s => (s.match(/[「『]/g) || []).length - (s.match(/[」』]/g) || []).length;

  // One line each (a quote left open keeps taking the following lines), or runs of non-blank
  // lines ("block"). line = 1-based line number of the start.
  function units(script, unit) {
    const lines = String(script || "").replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    let cur = null, joined = 0;
    lines.forEach((raw, i) => {
      const text = raw.replace(/\s+$/, "");
      const open = cur && (unit === "block" ? text.trim() !== "" : openQuotes(cur.text) > 0 && joined < MAX_JOIN);
      if (open) { cur.text += "\n" + text; joined++; return; }
      if (!text.trim()) { cur = null; return; }
      cur = { text, line: i + 1 };
      joined = 0;
      out.push(cur);
    });
    return out;
  }

  // -> { name, quote | text } or null
  function splitSpeaker(src, style, index) {
    if (style !== "colon") {
      const m = QUOTE.exec(src);
      if (m && m[1].length <= MAX_NAME && !PROSE.test(m[1])) return { name: m[1].trim(), quote: m[2] };
    }
    if (style !== "quote") {
      const m = COLON.exec(src);
      if (m && m[1].length <= MAX_NAME && !PROSE.test(m[1]) && (style === "colon" || resolve(m[1], index))) {
        return { name: m[1].trim(), text: m[2] };
      }
    }
    return null;
  }

  function entryFor(kind, title, text, hit, line, name) {
    return {
      kind, title, text, line, name: name || "",
      speakerId: hit ? hit.speaker.id : null, face: hit ? hit.face : "", faceMissing: !!(hit && hit.faceMissing),
    };
  }

  function parseScript(script, index, o) {
    const entries = [];
    for (const u of units(script, o.unit)) {
      const found = splitSpeaker(u.text, o.style, index);
      if (found) {
        const text = found.quote != null ? (o.keepQuotes ? found.quote : found.quote.slice(1, -1)) : found.text;
        const hit = resolve(found.name, index);
        entries.push(hit
          ? entryFor("speaker", hit.speaker.name, text, hit, u.line, found.name)
          : entryFor("unknown", found.name, text, null, u.line, found.name));
      } else if (o.narration === "include") {
        entries.push(entryFor("narration", o.narratorName, u.text, resolve(o.narratorName, index), u.line));
      }
    }
    return entries;
  }

  const headingOf = line => { for (const re of HEADING) { const m = re.exec(line); if (m && m[1].trim()) return m[1].trim(); } return null; };

  function parseHeadings(script, index, o) {
    const lines = String(script || "").replace(/\r\n?/g, "\n").split("\n");
    const entries = [];
    let cur = null;
    const flush = () => {
      if (!cur) return;
      const text = cur.body.join("\n").replace(/^\s*\n|\s+$/g, "");
      // An empty text would make CCFOLIA send whatever is in the chat box, so a bare heading sends itself.
      if (cur.title != null || text) entries.push(Object.assign(entryFor(cur.title == null ? "narration" : "heading", cur.title == null ? o.narratorName : cur.title, text || cur.title, cur.hit, cur.line), { bare: !text }));
      cur = null;
    };
    lines.forEach((raw, i) => {
      const h = headingOf(raw);
      if (h != null) {
        flush();
        cur = { title: h, body: [], line: i + 1, hit: resolve(h, index) };
        if (cur.hit) cur.title = cur.hit.speaker.name;
        return;
      }
      if (!cur) {
        if (!raw.trim()) return;
        cur = { title: null, body: [], line: i + 1, hit: resolve(o.narratorName, index) };
      }
      cur.body.push(raw.replace(/\s+$/, ""));
    });
    flush();
    return entries;
  }

  /**
   * opts: { mode: "script" | "heading", unit: "line" | "block", style: "auto" | "quote" | "colon",
   *         keepQuotes: boolean, narration: "include" | "skip", narratorName: string }
   * -> [{ kind: "speaker" | "unknown" | "narration" | "heading", title, text, speakerId, face,
   *       faceMissing, name, line, bare? }]
   */
  function parse(script, speakers, opts) {
    const o = Object.assign({ mode: "script", unit: "line", style: "auto", keepQuotes: true, narration: "include", narratorName: "" }, opts);
    const index = speakerIndex(speakers);
    return o.mode === "heading" ? parseHeadings(script, index, o) : parseScript(script, index, o);
  }

  // Names the script uses that are not registered yet, in order of first appearance.
  function unknownNames(entries) {
    const seen = new Set(), out = [];
    for (const e of entries) {
      if (e.kind === "unknown" && !seen.has(key(e.name))) { seen.add(key(e.name)); out.push(e.name); }
    }
    return out;
  }

  // [{ speakerId, face }] for faces the script uses but nobody registered.
  function missingFaces(entries) {
    const seen = new Set(), out = [];
    for (const e of entries) {
      const k = e.speakerId + "\u0000" + key(e.face);
      if (e.faceMissing && !seen.has(k)) { seen.add(k); out.push({ speakerId: e.speakerId, face: e.face }); }
    }
    return out;
  }

  root.StParse = { parse, unknownNames, missingFaces, key };
})(typeof window !== "undefined" ? window : globalThis);
