/*!
 * app.v1.js - シナリオテキストメーカー (UI)
 *
 * state = { images, speakers, script, opts, edited, confirmed }
 *   images:   the image shelf (置き場): [{ id, kind: "file", name, type, size, hash } | { id, kind: "url", name, url }]
 *             Only what an image is lives in state; the bytes of a file are a Blob in IndexedDB
 *             (localStorage holds a few MB at most). Project files carry them as data URLs.
 *   speakers: [{ id, name, aliases, imageId, faces: [{ id, label, imageId }] }]
 *   entry.image: "auto" (the speaker's portrait or face) | "none" | an image id (this entry only)
 *   edited:   null while the list simply follows the text. The first hand edit freezes a copy
 *             of the list here; from then on the text and options no longer rebuild it until
 *             the user chooses "文章から作り直す".
 *   confirmed: batches the user has set aside ("確定") to write the next text:
 *             [{ id, mode, label, script, opts, entries, edited }]. The zip holds them all, then
 *             the current list. "戻して直す" puts one back into the text box.
 * An entry's title is the speaker's name; with opts.faceInTitle its face is added as アリス（笑顔）
 * unless the title was typed by hand (titleCustom).
 * Entries point at a speaker and face by id and label, so changing a portrait later still
 * reaches every entry. Autosave keeps the state in localStorage and the image bytes in IndexedDB.
 * Saves from before the shelf (speaker.image / face.image as data URLs or URLs) are moved onto it.
 */
(function () {
  "use strict";

  const P = window.StParse, R = window.StRoomData;
  const $ = sel => document.querySelector(sel);

  const SAVE_KEY = "ccf-scenario-text-maker.state";
  const MAX_IMAGE = 5 * 1024 * 1024; // CCFOLIA's upload limit for images
  const SAMPLES = {
    script: [
      "アリス「ねえ、この屋敷、本当に誰も住んでいないの？」",
      "ボブ「そのはずだよ。十年前から空き家だって」",
      "扉の向こうから、かすかに足音が聞こえる。",
      "アリス（不安）「……今の、聞こえた？」",
      "ボブ：気のせいだと思いたいね",
    ].join("\n"),
    heading: [
      "■図書館",
      "古い新聞が棚にぎっしりと並んでいる。",
      "〈図書館〉に成功すると、十年前の火事の記事が見つかる。",
      "",
      "■書斎",
      "机の上に、鍵のかかった小箱がひとつ置かれている。",
      "",
      "■アリス",
      "（アリスからの手紙）明日の夜、屋敷の裏口で待っています。",
    ].join("\n"),
  };

  const uid = p => p + Math.random().toString(36).slice(2, 10);
  const defaultOpts = () => ({ mode: "script", unit: "line", style: "auto", keepQuotes: true, narration: "include", narratorName: "", faceInTitle: false });
  const newSpeaker = name => ({ id: uid("s"), name: name || "", aliases: "", imageId: null, faces: [] });
  const newFace = label => ({ id: uid("f"), label: label || "", imageId: null });
  const defaultState = () => ({ images: [], speakers: [newSpeaker("アリス"), newSpeaker("ボブ")], script: "", opts: defaultOpts(), edited: null, confirmed: [] });

  let state = defaultState();
  let entries = [];
  let selected = -1;
  let pendingPick = null; // called with the ids of the files chosen through #imageFile

  function status(message, isError) {
    const el = $("#status");
    el.textContent = message;
    el.classList.toggle("error", !!isError);
  }

  // ---------------------------------------------------------------- persistence

  const cleanEntry = e => ({
    kind: String(e.kind || "narration"), title: String(e.title || ""), text: String(e.text || ""),
    speakerId: e.speakerId ? String(e.speakerId) : null, face: String(e.face || ""), line: e.line || "",
    titleCustom: !!e.titleCustom, image: e.image ? String(e.image) : "auto",
  });
  const cleanList = list => Array.isArray(list) ? list.filter(e => e && typeof e === "object").map(cleanEntry) : [];
  const cleanImage = im => im.kind === "url"
    ? { id: String(im.id), kind: "url", name: String(im.name || ""), url: String(im.url) }
    : { id: String(im.id), kind: "file", name: String(im.name || ""), type: String(im.type || ""), size: Number(im.size) || 0, hash: String(im.hash || "") };
  const withCredit = (src, im) => Object.assign(im, { credit: String(src.credit || "") });

  function normalize(s) {
    const d = defaultState();
    if (!s || typeof s !== "object") return d;
    const images = Array.isArray(s.images) ? s.images.filter(im => im && im.id && (im.kind === "url" ? im.url : im.kind === "file")).map(im => withCredit(im, cleanImage(im))) : [];
    const ref = v => v ? String(v) : null;
    const speakers = Array.isArray(s.speakers) ? s.speakers.filter(x => x && typeof x === "object").map(x => ({
      id: String(x.id || uid("s")), name: String(x.name || ""), aliases: String(x.aliases || ""), imageId: ref(x.imageId),
      faces: Array.isArray(x.faces) ? x.faces.filter(f => f && typeof f === "object").map(f => ({ id: String(f.id || uid("f")), label: String(f.label || ""), imageId: ref(f.imageId) })) : [],
    })) : d.speakers;
    return {
      images, speakers, script: String(s.script || ""), opts: Object.assign(defaultOpts(), s.opts || {}),
      edited: Array.isArray(s.edited) ? cleanList(s.edited) : null,
      confirmed: Array.isArray(s.confirmed) ? s.confirmed.filter(b => b && typeof b === "object").map(b => ({
        id: String(b.id || uid("b")), mode: b.mode === "heading" ? "heading" : "script", label: String(b.label || ""),
        script: String(b.script || ""), opts: Object.assign(defaultOpts(), b.opts || {}), entries: cleanList(b.entries), edited: !!b.edited,
      })) : [],
    };
  }

  let saveTimer = 0;
  function saveNow() {
    clearTimeout(saveTimer);
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(state));
    } catch (err) {
      status("ブラウザに自動保存できませんでした。「プロジェクトを保存」でファイルに残してください。", true);
    }
  }
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 400);
  }

  // -> the images that came inline with the save (older saves), to be written to IndexedDB
  function loadSaved() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return [];
      const s = JSON.parse(raw);
      const lifted = liftImages(s);
      state = normalize(s);
      return lifted;
    } catch (err) { return []; /* private mode or broken data: start fresh */ }
  }

  function download(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  function stamp() {
    const d = new Date(), p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  }

  // ---------------------------------------------------------------- images

  const DB_NAME = "ccf-scenario-text-maker", DB_STORE = "images";
  const blobs = new Map(); // image id -> Blob (the bytes of the shelf's files while the page is open)
  const srcs = new Map();  // image id -> object URL
  let db = null;           // null when IndexedDB is unavailable: images then live only in memory

  function openDb() {
    return new Promise(resolve => {
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = req.onblocked = () => resolve(null);
      } catch (err) { resolve(null); }
    });
  }

  function dbRun(mode, fn) {
    return new Promise((resolve, reject) => {
      if (!db) { reject(new Error("no IndexedDB")); return; }
      const tx = db.transaction(DB_STORE, mode);
      const req = fn(tx.objectStore(DB_STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error("IndexedDB"));
    });
  }

  const warnNotStored = () => status("画像をブラウザに保存できませんでした。このページを閉じると消えるので、「プロジェクトを保存」でファイルに残してください。", true);
  function storeBlob(id, blob) { return dbRun("readwrite", s => s.put(blob, id)).catch(warnNotStored); }

  function holdBlob(id, blob) {
    if (srcs.has(id)) URL.revokeObjectURL(srcs.get(id));
    blobs.set(id, blob);
    srcs.set(id, URL.createObjectURL(blob));
  }

  function dropBlob(id) {
    if (srcs.has(id)) URL.revokeObjectURL(srcs.get(id));
    srcs.delete(id);
    blobs.delete(id);
    if (db) dbRun("readwrite", s => s.delete(id)).catch(() => {});
  }

  // Read the bytes of the shelf's files back from IndexedDB.
  async function loadBlobs() {
    for (const im of state.images) {
      if (im.kind !== "file" || blobs.has(im.id)) continue;
      try {
        const blob = await dbRun("readonly", s => s.get(im.id));
        if (blob) holdBlob(im.id, blob);
      } catch (err) { /* shown as missing on the shelf */ }
    }
  }

  async function hashOf(blob) {
    try { return R.hex(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())); } catch (err) { return ""; }
  }

  const baseName = n => String(n || "").replace(/\.[^.]+$/, "") || "画像";
  const blobToDataUrl = blob => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

  // Older saves keep images inline on speakers and faces, and project files carry the shelf with
  // data URLs. Put those bytes in blobs, leave only ids behind (mutates s), and return the images
  // that came in this way so they can be written to IndexedDB.
  function liftImages(s) {
    if (!s || typeof s !== "object") return [];
    const lifted = [], images = [];
    const seen = new Map(); // data url or url -> image, so one portrait used twice becomes one image
    const fromData = (meta, dataUrl) => {
      const { type, bytes } = R.dataUrlBytes(dataUrl);
      const im = { id: String(meta.id || uid("i")), kind: "file", name: String(meta.name || "画像"), type, size: bytes.length, hash: String(meta.hash || ""), credit: String(meta.credit || "") };
      holdBlob(im.id, new Blob([bytes], { type }));
      lifted.push(im);
      return im;
    };
    for (const im of Array.isArray(s.images) ? s.images : []) {
      if (!im || typeof im !== "object") continue;
      try {
        const got = im.kind === "file" && im.dataUrl ? fromData(im, im.dataUrl) : im;
        images.push(got);
        if (im.dataUrl || im.url) seen.set(im.dataUrl || im.url, got);
      } catch (err) { /* a broken image is left out */ }
    }
    const legacy = img => {
      if (!img || typeof img !== "object") return null;
      const k = img.kind === "file" ? img.dataUrl : img.kind === "url" ? img.url : "";
      if (!k) return null;
      if (!seen.has(k)) {
        try {
          const im = img.kind === "file" ? fromData({ name: baseName(img.fileName) }, k) : { id: uid("i"), kind: "url", name: urlName(k), url: k };
          images.push(im);
          seen.set(k, im);
        } catch (err) { return null; }
      }
      return seen.get(k).id;
    };
    for (const sp of Array.isArray(s.speakers) ? s.speakers : []) {
      if (!sp || typeof sp !== "object") continue;
      if ("image" in sp) { if (!sp.imageId) sp.imageId = legacy(sp.image); delete sp.image; }
      for (const f of Array.isArray(sp.faces) ? sp.faces : []) {
        if (f && typeof f === "object" && "image" in f) { if (!f.imageId) f.imageId = legacy(f.image); delete f.image; }
      }
    }
    s.images = images;
    return lifted;
  }

  function urlName(url) {
    try {
      const last = new URL(url).pathname.split("/").filter(Boolean).pop();
      return last ? baseName(decodeURIComponent(last)) : "URL の画像";
    } catch (err) { return "URL の画像"; }
  }

  // Put files on the shelf. -> their ids, in order (a file already there gives the existing id).
  async function addFiles(files) {
    const ids = [];
    let bad = 0, big = 0, same = 0;
    for (const file of Array.from(files || [])) {
      if (!R.EXT[file.type]) { bad++; continue; }
      const hash = await hashOf(file);
      const had = hash && state.images.find(im => im.kind === "file" && im.hash === hash && blobs.has(im.id));
      if (had) { ids.push(had.id); same++; continue; }
      const im = { id: uid("i"), kind: "file", name: baseName(file.name), type: file.type, size: file.size, hash };
      holdBlob(im.id, file);
      state.images.push(im);
      ids.push(im.id);
      if (file.size > MAX_IMAGE) big++;
      if (db) await storeBlob(im.id, file);
    }
    if (ids.length) saveNow();
    const added = ids.length - same;
    const parts = [];
    if (added) parts.push(`画像を ${added} 枚、置き場に入れました。`);
    if (added && !db) parts.push("ただし、このブラウザでは画像を保存できないので、閉じる前に「プロジェクトを保存」でファイルに残してください。");
    if (same) parts.push(`${same} 枚は置き場にある画像と同じなので、それを使います。`);
    if (bad) parts.push(`${bad} 個は使えない形式でした（PNG・JPEG・GIF・WebP が使えます）。`);
    if (big) parts.push(`${big} 枚は 5 MB を超えています。ココフォリアで読み込めないことがあるので、小さくしてから使ってください。`);
    if (parts.length) status(parts.join(""), !!(bad || big || (added && !db)));
    return ids;
  }

  function addUrl() {
    const url = prompt("画像の URL（https:// から）", "");
    if (url == null) return null;
    const u = url.trim();
    if (!/^https:\/\/\S+$/.test(u)) { status("URL は https:// から始まるものを入れてください。", true); return null; }
    let im = state.images.find(x => x.kind === "url" && x.url === u);
    if (!im) { im = { id: uid("i"), kind: "url", name: urlName(u), url: u }; state.images.push(im); }
    return im.id;
  }

  // Everything that points at an image, so deleting it can say what changes.
  function usesOf(id) {
    const names = [];
    for (const sp of state.speakers) {
      if (sp.imageId === id) names.push(sp.name || "名前なし");
      for (const f of sp.faces) if (f.imageId === id) names.push(`${sp.name || "名前なし"}（${f.label || "差分"}）`);
    }
    const lists = [state.edited || []].concat(state.confirmed.map(b => b.entries));
    const count = lists.reduce((n, list) => n + list.filter(e => e.image === id).length, 0);
    return { names, count };
  }

  function removeImage(im) {
    const { names, count } = usesOf(im.id);
    const uses = [];
    if (names.length) uses.push(`話し手・差分: ${names.join("、")}`);
    if (count) uses.push(`個別に選んだシナリオテキスト ${count} 件`);
    const msg = uses.length
      ? `「${im.name}」は次の所で使っています。\n${uses.join("\n")}\n\n削除すると、これらは「画像なし」になります。削除しますか？`
      : `「${im.name}」を置き場から削除しますか？`;
    if (!confirm(msg)) return;
    for (const sp of state.speakers) {
      if (sp.imageId === im.id) sp.imageId = null;
      for (const f of sp.faces) if (f.imageId === im.id) f.imageId = null;
    }
    for (const list of [state.edited || []].concat(state.confirmed.map(b => b.entries))) {
      for (const e of list) if (e.image === im.id) e.image = "none";
    }
    state.images = state.images.filter(x => x !== im);
    dropBlob(im.id);
    update();
    saveNow();
    status(uses.length ? `削除しました。使っていた所は「画像なし」になりました。` : "削除しました。");
  }

  const speakerById = id => state.speakers.find(s => s.id === id);
  const imageById = id => id ? state.images.find(im => im.id === id) || null : null;
  const imageSrc = img => !img ? "" : img.kind === "url" ? img.url : srcs.get(img.id) || "";
  const sizeText = n => n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
  const findFace = (sp, label) => sp && label ? (sp.faces || []).find(f => P.key(f.label) === P.key(label)) : null;

  // Shelf images by name, so a heading ■鍵 or a speaker 鍵 finds the image named 鍵.
  let nameIdx = new Map();
  function indexNames() {
    nameIdx = new Map();
    for (const im of state.images) {
      const k = P.key(im.name);
      if (k && !nameIdx.has(k)) nameIdx.set(k, im);
    }
  }
  const imageByName = name => nameIdx.get(P.key(name)) || null;

  // The image an entry sends: one chosen for it alone, else its face if registered, else the
  // speaker's base image, else the shelf image named like its title (■鍵 finds 鍵).
  function imageOf(e) {
    if (e.image === "none") return null;
    if (e.image && e.image !== "auto") return imageById(e.image);
    const sp = e.speakerId && speakerById(e.speakerId);
    if (sp) {
      const f = findFace(sp, e.face);
      const own = imageById(f && f.imageId) || imageById(sp.imageId);
      if (own) return own;
    }
    return imageByName(titleOf(e)) || imageByName(e.title);
  }
  const faceMissing = e => !!(e.face && e.speakerId && !findFace(speakerById(e.speakerId), e.face));
  // The title CCFOLIA shows: アリス, or アリス（笑顔） when faces go into titles.
  const titleOf = e => !e.titleCustom && e.face && e.speakerId && state.opts.faceInTitle ? `${e.title}（${e.face}）` : e.title;

  const tooBig = img => !!(img && img.kind === "file" && img.size > MAX_IMAGE);
  const missing = img => !!(img && img.kind === "file" && !blobs.has(img.id));

  function thumb(img, alt) {
    const box = document.createElement("div");
    box.className = "thumb";
    const src = imageSrc(img);
    if (src) {
      const el = document.createElement("img");
      el.src = src;
      el.alt = alt;
      box.append(el);
    } else {
      box.textContent = "画像なし";
    }
    return box;
  }

  function button(label, act, extra) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "small" + (extra && extra.danger ? " danger" : "");
    b.textContent = label;
    b.dataset.act = act;
    if (extra && extra.disabled) b.disabled = true;
    if (extra && extra.aria) b.setAttribute("aria-label", extra.aria);
    return b;
  }

  const imageLabel = im => (im.name || "（名前なし）") + (im.kind === "url" ? "（URL）" : "");

  // Choose one file and put it on the shelf; assign gets its id.
  function pickFile(assign) {
    pendingPick = assign;
    $("#imageFile").click();
  }

  const hasFiles = ev => !!(ev.dataTransfer && Array.from(ev.dataTransfer.types || []).includes("Files"));

  // Dropping image files on el puts them on the shelf, then hands the ids to take.
  function dropTarget(el, take) {
    el.addEventListener("dragover", ev => { if (!hasFiles(ev)) return; ev.preventDefault(); el.classList.add("over"); });
    el.addEventListener("dragleave", () => el.classList.remove("over"));
    el.addEventListener("drop", ev => {
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      el.classList.remove("over");
      addFiles(ev.dataTransfer.files).then(ids => take(ids));
    });
  }

  // A select of the shelf's images (with "none" first), plus a button that adds a file.
  // assign(id or null) is called with the choice.
  function imagePicker(current, assign, label) {
    const row = document.createElement("div");
    row.className = "img-row";
    const sel = document.createElement("select");
    sel.setAttribute("aria-label", label);
    sel.append(new Option("画像なし", ""));
    for (const im of state.images) sel.append(new Option(imageLabel(im), im.id));
    sel.value = imageById(current) ? current : "";
    sel.addEventListener("change", () => assign(sel.value || null));
    const add = button("＋ 画像", "file", { aria: `${label}にファイルから画像を追加` });
    add.addEventListener("click", () => pickFile(ids => { if (ids[0]) assign(ids[0]); }));
    row.append(sel, add);
    return row;
  }

  function warnLine(img) {
    const n = document.createElement("div");
    n.className = "img-note warn";
    n.textContent = missing(img) ? `「${img.name}」の中身が見つかりません。置き場で入れ直してください`
      : `「${img.name}」は ${sizeText(img.size)}。5 MB を超えると、ココフォリアで読み込めないことがあります`;
    return n;
  }

  // ---------------------------------------------------------------- image shelf

  function renderGallery() {
    const box = $("#gallery");
    box.textContent = "";
    $("#imageCount").textContent = state.images.length;
    $("#makeFromImages").disabled = !state.images.length;
    if (!state.images.length) {
      const p = document.createElement("p");
      p.className = "desc";
      p.textContent = "まだ画像がありません。";
      box.append(p);
      return;
    }
    for (const im of state.images) {
      const cell = document.createElement("div");
      cell.className = "imgcell";
      const src = imageSrc(im);
      if (src) { const img = document.createElement("img"); img.src = src; img.alt = ""; img.loading = "lazy"; cell.append(img); }
      else { const d = document.createElement("div"); d.className = "noimg"; d.textContent = "中身なし"; cell.append(d); }
      const name = document.createElement("input");
      name.type = "text";
      name.value = im.name;
      name.setAttribute("aria-label", "画像の名前");
      name.addEventListener("input", () => { im.name = name.value; update({ keepGallery: true }); });
      const credit = document.createElement("input");
      credit.type = "text";
      credit.value = im.credit || "";
      credit.placeholder = "出典・作者（任意）";
      credit.setAttribute("aria-label", `画像「${im.name}」の出典・作者`);
      credit.addEventListener("input", () => { im.credit = credit.value; update({ keepGallery: true }); });
      const info = document.createElement("span");
      info.className = "info" + (tooBig(im) || missing(im) ? " warn" : "");
      info.textContent = im.kind === "url" ? "URL" : missing(im) ? "中身が見つかりません" : sizeText(im.size) + (tooBig(im) ? "（5 MB 超）" : "");
      if (im.kind === "url") info.title = im.url;
      const del = button("削除", "delete-image", { danger: true, aria: `画像「${im.name}」を削除` });
      del.addEventListener("click", () => removeImage(im));
      cell.append(name, credit, info, del);
      box.append(cell);
    }
  }

  // ---------------------------------------------------------------- speakers

  function renderSpeakers() {
    const box = $("#speakers");
    box.textContent = "";
    state.speakers.forEach((sp, i) => {
      const el = document.createElement("div");
      el.className = "speaker";
      const setSp = id => { sp.imageId = id; update(); };
      const spThumb = thumb(imageById(sp.imageId), `${sp.name || "話し手"}の立ち絵`);
      spThumb.title = "画像をここにドロップしても設定できます";
      dropTarget(spThumb, ids => { if (ids[0]) setSp(ids[0]); });
      el.append(spThumb);

      const fields = document.createElement("div");
      fields.className = "fields";
      fields.innerHTML = `
        <label>名前（タイトル）<input type="text" data-field="name"></label>
        <label>台本での書き方（ほかにあれば。「、」区切り）<input type="text" data-field="aliases" placeholder="例: ありす、アリー"></label>`;
      fields.querySelector('[data-field="name"]').value = sp.name;
      fields.querySelector('[data-field="aliases"]').value = sp.aliases;
      fields.addEventListener("input", ev => {
        const f = ev.target.dataset.field;
        if (!f) return;
        sp[f] = ev.target.value;
        update({ keepSpeakers: true });
      });
      const imgs = imagePicker(sp.imageId, setSp, `${sp.name || "話し手"}の立ち絵`);
      const del = button("削除", "remove", { danger: true, aria: `${i + 1} 人目の話し手を削除` });
      del.addEventListener("click", () => {
        if ((sp.imageId || sp.faces.length) && !confirm(`「${sp.name || "名前なし"}」を削除しますか？（置き場の画像は残ります）`)) return;
        state.speakers = state.speakers.filter(x => x !== sp);
        update();
      });
      imgs.append(del);
      fields.append(imgs);
      const spImg = imageById(sp.imageId);
      if (tooBig(spImg) || missing(spImg)) fields.append(warnLine(spImg));

      // Faces (差分)
      const faces = document.createElement("div");
      faces.className = "faces";
      sp.faces.forEach(face => {
        const row = document.createElement("div");
        row.className = "face";
        const setFace = id => { face.imageId = id; update(); };
        const fThumb = thumb(imageById(face.imageId), `${sp.name}（${face.label}）`);
        dropTarget(fThumb, ids => { if (ids[0]) setFace(ids[0]); });
        row.append(fThumb);
        const inner = document.createElement("div");
        inner.className = "fields";
        const lab = document.createElement("input");
        lab.type = "text";
        lab.value = face.label;
        lab.placeholder = "差分の名前（例: 笑顔）";
        lab.setAttribute("aria-label", `${sp.name || "話し手"}の差分の名前`);
        lab.addEventListener("input", () => { face.label = lab.value; update({ keepSpeakers: true }); });
        const btns = imagePicker(face.imageId, setFace, `差分「${face.label}」の画像`);
        const rm = button("削除", "remove-face", { danger: true, aria: `差分「${face.label}」を削除` });
        rm.addEventListener("click", () => { sp.faces = sp.faces.filter(f => f !== face); update(); });
        btns.append(rm);
        inner.append(lab, btns);
        const fImg = imageById(face.imageId);
        if (tooBig(fImg) || missing(fImg)) inner.append(warnLine(fImg));
        row.append(inner);
        faces.append(row);
      });
      const addFace = button("＋ 差分（表情）を追加", "add-face");
      addFace.addEventListener("click", () => {
        sp.faces.push(newFace(""));
        update();
        const inputs = document.querySelectorAll(`#speakers .speaker:nth-child(${i + 1}) .face input[type=text]`);
        if (inputs.length) inputs[inputs.length - 1].focus();
      });
      faces.append(addFace);

      // More faces: from shelf images named like アリス_笑顔, or by an effect on the portrait.
      const tools = document.createElement("div");
      tools.className = "face-tools";
      const fromNames = button("置き場から差分を作る", "faces-from-names");
      fromNames.title = `名前が「${sp.name || "話し手の名前"}_笑顔」のような画像を、差分にします`;
      fromNames.addEventListener("click", () => facesFromNames(sp));
      const fxSel = document.createElement("select");
      fxSel.setAttribute("aria-label", `${sp.name || "話し手"}の立ち絵から演出差分を作る`);
      fxSel.append(new Option("演出差分を作る…", ""));
      for (const [id, label] of FX) fxSel.append(new Option(label, id));
      const src = imageById(sp.imageId);
      fxSel.disabled = !(src && src.kind === "file");
      fxSel.title = fxSel.disabled ? "ファイルの立ち絵を設定すると使えます（URL の画像は、ブラウザの制限で加工できません）" : "立ち絵を加工して、差分を作ります";
      fxSel.addEventListener("change", () => { const v = fxSel.value; fxSel.value = ""; if (v) makeFx(sp, v); });
      tools.append(fromNames, fxSel);
      faces.append(tools);
      fields.append(faces);
      el.append(fields);
      box.append(el);
    });
  }

  // ---------------------------------------------------------------- bulk helpers

  // One entry per shelf image that nothing in the list shows yet (title = the image's name).
  function makeFromImages() {
    if (!state.images.length) { status("置き場に画像がありません。", true); return; }
    const used = new Set(entries.map(imageOf).filter(Boolean).map(im => im.id));
    const fresh = state.images.filter(im => !used.has(im.id));
    if (!fresh.length) { status("置き場の画像は、すべて一覧で使われています。", true); return; }
    ensureEdited();
    const first = state.edited.length;
    for (const im of fresh) state.edited.push(cleanEntry({ kind: "heading", title: im.name, text: "", image: im.id, titleCustom: true }));
    entries = state.edited;
    selected = first;
    update();
    status(`画像 ${fresh.length} 枚ぶん、シナリオテキストを足しました${used.size ? `（一覧で使っている ${used.size} 枚は飛ばしました）` : ""}。本文が空なので、1 件ずつ入れてください。`);
  }

  // Shelf images named 話し手_差分 (アリス_笑顔, アリス（笑顔）, アリス@笑顔 ...) become that speaker's faces;
  // an image named just アリス becomes the portrait if there is none.
  const FACE_SEP = /^[\s_\-－@＠（(：:]+/;
  function facesFromNames(sp) {
    const names = [sp.name].concat(String(sp.aliases || "").split(/[,、，]/)).map(P.key).filter(Boolean).sort((a, b) => b.length - a.length);
    if (!names.length) { status("先に、話し手の名前を入れてください。", true); return; }
    const made = [];
    let base = false, found = 0;
    for (const im of state.images) {
      const n = P.key(im.name);
      const a = names.find(x => n === x || n.startsWith(x));
      if (!a) continue;
      if (n === a) { found++; if (!sp.imageId) { sp.imageId = im.id; base = true; } continue; }
      const rest = n.slice(a.length);
      if (!FACE_SEP.test(rest)) continue; // アリスの家 is another name, not a face
      const label = rest.replace(FACE_SEP, "").replace(/[）)]+$/, "").trim();
      if (!label) continue;
      found++;
      if (findFace(sp, label)) continue;
      sp.faces.push({ id: uid("f"), label, imageId: im.id });
      made.push(label);
    }
    if (!made.length && !base) {
      status(found ? "新しく作れる差分はありません（すでに作ってあります）。" : `名前が「${sp.name}」で始まる画像が見つかりません。画像の名前を「${sp.name}_笑顔」のようにしてください。`, !found);
      return;
    }
    update();
    status((made.length ? `差分を ${made.length} 個作りました: ${made.join("、")}。` : "") + (base ? "立ち絵も設定しました。" : ""));
  }

  // ---------------------------------------------------------------- effect faces

  const FX = [["silhouette", "シルエット"], ["sepia", "セピア"], ["mono", "モノクロ"], ["blur", "ぼかし"], ["ghost", "半透明"]];
  const fxLabel = id => (FX.find(f => f[0] === id) || [])[1] || id;

  async function hasTransparency(blob) {
    const bmp = await createImageBitmap(blob);
    try {
      const c = document.createElement("canvas");
      c.width = c.height = 48;
      const g = c.getContext("2d", { willReadFrequently: true });
      g.drawImage(bmp, 0, 0, 48, 48);
      const d = g.getImageData(0, 0, 48, 48).data;
      for (let i = 3; i < d.length; i += 4) if (d[i] < 250) return true;
      return false;
    } finally { bmp.close(); }
  }

  // The image (its first frame, if it moves) drawn with an effect -> PNG.
  async function drawFx(blob, fx) {
    const bmp = await createImageBitmap(blob);
    try {
      const small = Math.min(bmp.width, bmp.height);
      const pad = fx === "blur" ? Math.max(8, Math.round(small / 20)) : 0;
      const c = document.createElement("canvas");
      c.width = bmp.width + pad * 2;
      c.height = bmp.height + pad * 2;
      const g = c.getContext("2d");
      if (fx === "sepia" || fx === "mono" || fx === "blur") {
        if (!("filter" in g)) throw new Error("このブラウザでは、この効果は使えません");
        g.filter = fx === "sepia" ? "sepia(1)" : fx === "mono" ? "grayscale(1)" : `blur(${Math.max(2, Math.round(small / 80))}px)`;
      }
      if (fx === "ghost") g.globalAlpha = 0.5;
      g.drawImage(bmp, pad, pad);
      if (fx === "silhouette") {
        g.globalCompositeOperation = "source-in";
        g.fillStyle = "#000";
        g.fillRect(0, 0, c.width, c.height);
      }
      return await new Promise((resolve, reject) => c.toBlob(b => b ? resolve(b) : reject(new Error("画像を書き出せませんでした")), "image/png"));
    } finally { bmp.close(); }
  }

  let fxBusy = false;
  async function makeFx(sp, fx) {
    const src = imageById(sp.imageId);
    if (!src) { status("先に、この話し手の立ち絵を設定してください。", true); return; }
    if (src.kind !== "file" || !blobs.has(src.id)) { status("URL の画像は、ブラウザの制限で加工できません。ファイルの画像で試してください。", true); return; }
    const label = fxLabel(fx);
    if (findFace(sp, label)) { status(`すでに「${label}」の差分があります。`, true); return; }
    if (fxBusy) return;
    fxBusy = true;
    try {
      const blob = blobs.get(src.id);
      if (fx === "silhouette" && !(await hasTransparency(blob))) {
        status("この画像は背景が透明ではないので、四角い黒い塊になります。背景が透明な PNG の立ち絵で試してください。", true);
        return;
      }
      const out = await drawFx(blob, fx);
      const [id] = await addFiles([new File([out], `${src.name}（${label}）.png`, { type: "image/png" })]);
      if (!id) return;
      sp.faces.push({ id: uid("f"), label, imageId: id });
      update();
      const big = tooBig(imageById(id));
      status(`差分「${label}」を作りました（画像は置き場に入っています）。台本に「${sp.name || "名前"}（${label}）「…」」と書くと使えます。` + (big ? "ただし 5 MB を超えています。ココフォリアで読み込めないことがあります。" : ""), big);
    } catch (err) {
      console.error(err);
      status("演出差分を作れませんでした: " + err.message, true);
    } finally { fxBusy = false; }
  }

  // ---------------------------------------------------------------- warnings

  function renderWarnings() {
    const box = $("#unknown");
    box.textContent = "";
    const names = state.edited ? [] : P.unknownNames(entries);
    const faces = [];
    const seen = new Set();
    for (const e of entries) {
      const k = e.speakerId + "\u0000" + P.key(e.face);
      if (faceMissing(e) && !seen.has(k)) { seen.add(k); faces.push(e); }
    }
    box.hidden = !names.length && !faces.length;
    if (names.length) {
      const p = document.createElement("div");
      p.append("登録していない話し手がいます（立ち絵なしで、台本の名前のまま送られます）: ");
      for (const name of names) {
        const b = button(`＋「${name}」を話し手に追加`, "add-speaker");
        b.addEventListener("click", () => { state.speakers.push(newSpeaker(name)); update(); });
        p.append(b);
      }
      box.append(p);
    }
    if (faces.length) {
      const p = document.createElement("div");
      p.append("登録していない差分があります（基本の立ち絵で送られます）: ");
      for (const e of faces) {
        const sp = speakerById(e.speakerId);
        const b = button(`＋「${sp.name}（${e.face}）」を差分に追加`, "add-face");
        b.addEventListener("click", () => { sp.faces.push(newFace(e.face)); update(); });
        p.append(b);
      }
      box.append(p);
    }
  }

  // ---------------------------------------------------------------- list

  function renderEntries() {
    const body = $("#entries");
    body.textContent = "";
    if (!entries.length) {
      const tr = document.createElement("tr");
      tr.innerHTML = '<td colspan="4" class="empty-list">上に文章を貼ると、ここに 1 件ずつ並びます</td>';
      body.append(tr);
    }
    entries.forEach((e, i) => {
      const tr = document.createElement("tr");
      tr.setAttribute("aria-selected", String(i === selected));
      tr.tabIndex = 0;
      const src = imageSrc(imageOf(e));
      tr.innerHTML = `<td class="num"></td><td class="pic"></td><td class="title"></td><td class="text"></td>`;
      tr.children[0].textContent = e.line || "＋";
      if (src) { const img = document.createElement("img"); img.src = src; img.alt = ""; tr.children[1].append(img); }
      const title = tr.children[2];
      const shown = titleOf(e);
      title.textContent = shown || "（名前の欄）";
      const badge = (cls, text) => { const s = document.createElement("span"); s.className = "badge " + cls; s.textContent = text; title.append(s); };
      if (e.face && !shown.endsWith(`（${e.face}）`)) badge("face", "差分 " + e.face);
      if (e.image === "none") badge("narr", "画像なし");
      else if (e.image && e.image !== "auto") badge("face", "個別の画像");
      if (e.kind === "unknown" && !e.speakerId) badge("unknown-b", "未登録");
      if (faceMissing(e)) badge("unknown-b", "差分なし");
      if (e.kind === "narration") badge("narr", state.opts.mode === "heading" ? "見出しの前" : "地の文");
      tr.children[3].textContent = e.text;
      const pick = () => { selected = i; renderEntries(); renderPreview(); renderEditor(); };
      tr.addEventListener("click", pick);
      tr.addEventListener("keydown", ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); pick(); } });
      body.append(tr);
    });
    $("#count").textContent = entries.length;
    const withImage = entries.filter(e => imageOf(e)).length;
    $("#summary").innerHTML = entries.length ? `画像つき <b>${withImage}</b> 件・なし <b>${entries.length - withImage}</b> 件` : "";
    $("#confirmBatch").disabled = entries.length === 0;
    $("#editedNote").hidden = !state.edited;
  }

  function renderPreview() {
    const e = entries[selected];
    $("#mbox").hidden = !e;
    if (!e) return;
    const src = imageSrc(imageOf(e));
    const img = $("#mboxPortrait");
    img.hidden = !src;
    if (src) img.src = src;
    const name = $("#mboxName");
    const shown = titleOf(e);
    name.textContent = shown || "（送るときの名前の欄の名前）";
    name.classList.toggle("empty", !shown);
    $("#mboxText").textContent = e.text;
  }

  // ---------------------------------------------------------------- hand edits

  // Freeze the list the first time something is edited by hand.
  function ensureEdited() {
    if (!state.edited) state.edited = entries.map(cleanEntry);
    entries = state.edited;
  }

  // typing: keep the editor as it is, so the caret stays where the user is typing.
  function editEntry(fn, typing) {
    ensureEdited();
    fn(state.edited);
    update({ keepSpeakers: true, keepEditor: !!typing });
  }

  function renderEditor() {
    const box = $("#editor");
    const e = entries[selected];
    box.hidden = !e;
    if (!e) return;
    $("#edTitle").value = titleOf(e);
    const spSel = $("#edSpeaker");
    spSel.textContent = "";
    spSel.append(new Option("（立ち絵なし）", ""));
    for (const sp of state.speakers) spSel.append(new Option(sp.name || "（名前なし）", sp.id));
    spSel.value = e.speakerId && speakerById(e.speakerId) ? e.speakerId : "";
    const faceSel = $("#edFace");
    faceSel.textContent = "";
    faceSel.append(new Option("基本", ""));
    const sp = speakerById(spSel.value);
    for (const f of sp ? sp.faces : []) if (f.label) faceSel.append(new Option(f.label, f.label));
    if (e.face && !findFace(sp, e.face)) faceSel.append(new Option(`${e.face}（未登録）`, e.face));
    faceSel.value = e.face || "";
    faceSel.disabled = !sp;
    const imgSel = $("#edImage");
    imgSel.textContent = "";
    imgSel.append(new Option("自動（話し手・差分・同じ名前の画像）", "auto"), new Option("画像なし", "none"));
    for (const im of state.images) imgSel.append(new Option(imageLabel(im), im.id));
    imgSel.value = e.image === "none" || imageById(e.image) ? e.image : "auto";
    $("#edText").value = e.text;
    $("#edTitleReset").hidden = !(e.titleCustom && e.speakerId && speakerById(e.speakerId));
    $("#edUp").disabled = selected <= 0;
    $("#edDown").disabled = selected >= entries.length - 1;
  }

  function wireEditor() {
    $("#edTitle").addEventListener("input", ev => {
      editEntry(list => { list[selected].title = ev.target.value; list[selected].titleCustom = true; }, true);
      $("#edTitleReset").hidden = !(entries[selected] && speakerById(entries[selected].speakerId));
    });
    $("#edText").addEventListener("input", ev => editEntry(list => { list[selected].text = ev.target.value; }, true));
    $("#edSpeaker").addEventListener("change", ev => editEntry(list => {
      const e = list[selected], sp = speakerById(ev.target.value);
      e.speakerId = sp ? sp.id : null;
      e.face = "";
      if (sp) { e.title = sp.name; e.kind = "speaker"; e.titleCustom = false; }
    }));
    $("#edFace").addEventListener("change", ev => editEntry(list => { list[selected].face = ev.target.value; }));
    $("#edImage").addEventListener("change", ev => editEntry(list => { list[selected].image = ev.target.value; }));
    $("#edImageAdd").addEventListener("click", () => {
      const at = selected;
      pickFile(ids => { if (ids[0] && entries[at]) { selected = at; editEntry(list => { list[at].image = ids[0]; }); } });
    });
    dropTarget($("#editor"), ids => {
      if (ids[0] && entries[selected]) editEntry(list => { list[selected].image = ids[0]; });
    });
    $("#edTitleReset").addEventListener("click", () => editEntry(list => {
      const e = list[selected], sp = speakerById(e.speakerId);
      if (sp) e.title = sp.name;
      e.titleCustom = false;
    }));
    const move = d => editEntry(list => {
      const j = selected + d;
      if (j < 0 || j >= list.length) return;
      [list[selected], list[j]] = [list[j], list[selected]];
      selected = j;
    });
    $("#edUp").addEventListener("click", () => move(-1));
    $("#edDown").addEventListener("click", () => move(1));
    $("#edAdd").addEventListener("click", () => editEntry(list => {
      const base = list[selected];
      list.splice(selected + 1, 0, cleanEntry(Object.assign({}, base || {}, { text: "（新しいシナリオテキスト）", line: "" })));
      selected += 1;
    }));
    $("#edDelete").addEventListener("click", () => editEntry(list => {
      list.splice(selected, 1);
      if (selected >= list.length) selected = list.length - 1;
    }));
    $("#rebuild").addEventListener("click", () => {
      if (!confirm("手直しした内容を捨てて、文章から一覧を作り直しますか？")) return;
      state.edited = null;
      selected = -1;
      update();
      status("文章から作り直しました。");
    });
  }

  // ---------------------------------------------------------------- update loop

  function syncOpts() {
    for (const el of document.querySelectorAll("[data-opt]")) {
      const v = state.opts[el.dataset.opt];
      if (el.type === "checkbox") el.checked = !!v; else if (el.type === "radio") el.checked = el.value === v; else el.value = v;
    }
    const heading = state.opts.mode === "heading";
    for (const el of document.querySelectorAll("[data-mode]")) el.hidden = el.dataset.mode !== state.opts.mode;
    $("#narratorRow").hidden = !heading && state.opts.narration !== "include";
    $("#narratorLabel").textContent = heading ? "見出しより前の文の名前" : "地の文の名前";
    $("#textTitle").textContent = heading ? "本文（見出しで区切る）" : "台本";
    $("#script").placeholder = heading ? "■図書館\n古い新聞が並んでいる。\n\n■書斎\n机の上に鍵がある。" : "アリス「こんにちは。」\nボブ「やあ。」\n扉の向こうから足音が近づいてくる。";
  }

  function update(o) {
    indexNames();
    entries = state.edited || P.parse(state.script, state.speakers, state.opts);
    if (selected >= entries.length) selected = entries.length - 1;
    if (!(o && (o.keepSpeakers || o.keepGallery))) renderGallery();
    if (!(o && o.keepSpeakers)) renderSpeakers();
    renderWarnings();
    renderEntries();
    renderPreview();
    renderConfirmed();
    if (!(o && o.keepEditor)) renderEditor();
    else { $("#edUp").disabled = selected <= 0; $("#edDown").disabled = selected >= entries.length - 1; }
    scheduleSave();
  }

  // ---------------------------------------------------------------- confirmed batches

  const MODE_NAME = { script: "台本", heading: "見出し" };
  const snippet = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n) + "…" : t; };
  const confirmedCount = () => state.confirmed.reduce((n, b) => n + b.entries.length, 0);

  function batchOf(list) {
    const first = list[0];
    return {
      id: uid("b"), mode: state.opts.mode, label: snippet((titleOf(first) ? titleOf(first) + "：" : "") + first.text, 28),
      script: state.script, opts: Object.assign({}, state.opts), entries: list.map(cleanEntry), edited: !!state.edited,
    };
  }

  // Set the current list aside and empty the text box for the next text.
  function confirmCurrent(quiet) {
    if (!entries.length) return false;
    state.confirmed.push(batchOf(entries));
    state.script = "";
    state.edited = null;
    $("#script").value = "";
    selected = -1;
    if (!quiet) status(`確定しました（${state.confirmed.at(-1).entries.length} 件）。次の文章を入れられます。`);
    return true;
  }

  function restoreBatch(i) {
    const moved = entries.length ? confirmCurrent(true) : false;
    const b = state.confirmed.splice(i, 1)[0];
    state.script = b.script;
    state.opts = Object.assign({}, b.opts, { faceInTitle: state.opts.faceInTitle });
    state.edited = b.edited ? b.entries.map(cleanEntry) : null;
    $("#script").value = state.script;
    selected = -1;
    syncOpts();
    update({ keepSpeakers: true });
    status(moved ? "戻しました。入っていた文章は、確定したものの最後に移しました。" : "戻しました。直したら、もう一度「確定」してください。");
    window.scrollTo({ top: $("#textTitle").getBoundingClientRect().top + window.scrollY - 20, behavior: "smooth" });
  }

  function renderConfirmed() {
    const card = $("#confirmedCard");
    const box = $("#confirmedList");
    card.hidden = state.confirmed.length === 0;
    box.textContent = "";
    state.confirmed.forEach((b, i) => {
      const item = document.createElement("details");
      item.className = "batch";
      const sum = document.createElement("summary");
      sum.innerHTML = `<span class="num"></span><span class="badge narr"></span><b></b><span class="label"></span>`;
      sum.children[0].textContent = i + 1;
      sum.children[1].textContent = MODE_NAME[b.mode];
      sum.children[2].textContent = `${b.entries.length} 件`;
      sum.children[3].textContent = b.label;
      const btns = document.createElement("span");
      btns.className = "btns";
      const up = button("↑", "up", { disabled: i === 0, aria: `${i + 1} 番目を上へ` });
      const down = button("↓", "down", { disabled: i === state.confirmed.length - 1, aria: `${i + 1} 番目を下へ` });
      const back = button("戻して直す", "back");
      const del = button("削除", "delete", { danger: true, aria: `${i + 1} 番目を削除` });
      btns.append(up, down, back, del);
      btns.addEventListener("click", ev => {
        ev.preventDefault(); // keep the details from toggling
        const act = ev.target.dataset && ev.target.dataset.act;
        if (act === "up" || act === "down") {
          const j = i + (act === "up" ? -1 : 1);
          [state.confirmed[i], state.confirmed[j]] = [state.confirmed[j], state.confirmed[i]];
          update({ keepSpeakers: true });
        } else if (act === "back") restoreBatch(i);
        else if (act === "delete") {
          if (!confirm(`確定した ${i + 1} 番目（${b.entries.length} 件）を削除しますか？`)) return;
          state.confirmed.splice(i, 1);
          update({ keepSpeakers: true });
        }
      });
      sum.append(btns);
      item.append(sum);
      const ul = document.createElement("ol");
      for (const e of b.entries) {
        const li = document.createElement("li");
        const img = imageSrc(imageOf(e));
        if (img) { const im = document.createElement("img"); im.src = img; im.alt = ""; li.append(im); }
        const t = document.createElement("b");
        t.textContent = titleOf(e) || "（名前の欄）";
        li.append(t, " " + snippet(e.text, 60));
        ul.append(li);
      }
      item.append(ul);
      box.append(item);
    });
    const done = confirmedCount();
    $("#confirmedCount").textContent = done;
    const total = done + entries.length;
    $("#exportSummary").innerHTML = total
      ? (done ? `確定 <b>${done}</b> 件 ＋ 今の一覧 <b>${entries.length}</b> 件 ＝ <b>${total}</b> 件を 1 つの ZIP に書き出します。` : `今の一覧 <b>${entries.length}</b> 件を ZIP に書き出します。`)
      : "書き出すシナリオテキストがまだありません。";
    $("#exportZip").disabled = total === 0;
    syncBundleButton();
  }

  // ---------------------------------------------------------------- export

  function exportStatus(message, isError) {
    const el = $("#exportStatus");
    el.textContent = message;
    el.classList.toggle("error", !!isError);
  }

  // ---------------------------------------------------------------- image bundle

  // image id -> Map(title shown -> how many entries), for every entry that sends an image.
  function usageMap(all) {
    const use = new Map();
    for (const e of all) {
      const im = imageOf(e);
      if (!im) continue;
      const t = titleOf(e) || "（名前の欄）";
      if (!use.has(im.id)) use.set(im.id, new Map());
      const m = use.get(im.id);
      m.set(t, (m.get(t) || 0) + 1);
    }
    return use;
  }
  const allEntries = () => state.confirmed.flatMap(b => b.entries).concat(entries);

  function syncBundleButton() {
    const n = $("#bundleAll").checked ? state.images.length : usageMap(allEntries()).size;
    $("#exportImages").disabled = n === 0;
  }

  const fileSafe = s => String(s || "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim() || "画像";
  function usedText(m) {
    if (!m || !m.size) return "（使っていません）";
    const parts = [...m].map(([t, n]) => `${t} ×${n}`);
    return parts.length > 8 ? parts.slice(0, 8).join("、") + `、ほか ${parts.length - 8} 種` : parts.join("、");
  }

  // The images the scenario texts use (or the whole shelf), under readable names, with a list that
  // says where each is used, who made it, and what it is called inside the room data zip.
  async function exportImages() {
    if (!window.JSZip) { exportStatus("ZIP を作る部品を読み込めませんでした。ネットにつながった状態で開き直してください。", true); return; }
    const use = usageMap(allEntries());
    const everything = $("#bundleAll").checked;
    const list = state.images.filter(im => everything || use.has(im.id));
    if (!list.length) { exportStatus("まとめる画像がありません。", true); return; }
    const btn = $("#exportImages");
    btn.disabled = true;
    exportStatus("ZIP を作っています…");
    try {
      const zip = new JSZip();
      const taken = new Set();
      const lines = [
        "シナリオテキストメーカー 画像の一覧",
        `作成: ${new Date().toLocaleString("ja-JP")}`,
        `画像 ${list.length} 枚（${everything ? "置き場のすべて" : "シナリオテキストで使っているもの"}）`,
        "画像ファイルは images フォルダに入っています。",
        "「ルームデータ内の名前」は、書き出したルームデータ（ZIP）の中での、その画像のファイル名です。",
        "",
      ];
      let files = 0, urls = 0, lost = 0, i = 0;
      for (const im of list) {
        i++;
        const credit = im.credit ? im.credit : "（未記入）";
        const where = usedText(use.get(im.id));
        if (im.kind === "url") {
          urls++;
          lines.push(`[${i}] ${im.name}（URL の画像。中身は入っていません）`, `    URL: ${im.url}`, `    出典・作者: ${credit}`, `    使っている所: ${where}`, "");
          continue;
        }
        const blob = blobs.get(im.id);
        if (!blob) {
          lost++;
          lines.push(`[${i}] ${im.name}（中身が見つからないので、入っていません）`, `    出典・作者: ${credit}`, `    使っている所: ${where}`, "");
          continue;
        }
        const ext = R.EXT[im.type] || R.EXT[blob.type] || "png";
        const base = fileSafe(im.name);
        let name = base, k = 2;
        while (taken.has(`${name}.${ext}`.toLowerCase())) name = `${base}（${k++}）`;
        taken.add(`${name}.${ext}`.toLowerCase());
        zip.file(`images/${name}.${ext}`, await blob.arrayBuffer(), { compression: "STORE" });
        files++;
        lines.push(`[${i}] images/${name}.${ext}`, `    大きさ: ${sizeText(im.size)}（${im.type}）${tooBig(im) ? " ※ 5 MB を超えています" : ""}`);
        if (im.hash) lines.push(`    ルームデータ内の名前: ${im.hash}.${ext}`);
        lines.push(`    出典・作者: ${credit}`, `    使っている所: ${where}`, "");
      }
      zip.file("画像の一覧.txt", lines.join("\r\n"));
      const out = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
      const fileName = `scenario-text-images-${stamp()}.zip`;
      download(out, fileName);
      exportStatus(`画像 ${files} 枚を ${fileName}（${sizeText(out.size)}）にまとめて保存しました。`
        + (urls ? `URL の画像 ${urls} 件は、一覧に URL だけ書きました。` : "")
        + (lost ? `中身が見つからない画像が ${lost} 枚あります。` : ""), !!lost);
    } catch (err) {
      console.error(err);
      exportStatus("画像をまとめられませんでした: " + err.message, true);
    } finally {
      syncBundleButton();
    }
  }

  async function exportZip() {
    const all = state.confirmed.flatMap(b => b.entries).concat(entries);
    if (!all.length) return;
    if (!window.JSZip) { exportStatus("ZIP を作る部品を読み込めませんでした。ネットにつながった状態で開き直してください。", true); return; }
    if (!(window.crypto && crypto.subtle)) { exportStatus("このブラウザでは ZIP を作れません（https のページか、新しい Chrome・Edge で開いてください）。", true); return; }
    const emptyBatch = state.confirmed.findIndex(b => b.entries.some(e => !e.text.trim()));
    const empty = entries.findIndex(e => !e.text.trim());
    if (emptyBatch >= 0 || empty >= 0) {
      if (emptyBatch < 0) { selected = empty; update({ keepSpeakers: true }); }
      exportStatus(`本文が空のシナリオテキストがあります（${emptyBatch >= 0 ? `確定した ${emptyBatch + 1} 番目` : "今の一覧"}）。ココフォリアでは送信欄の文が代わりに送られてしまうので、本文を入れるか削除してください。`, true);
      return;
    }
    const btn = $("#exportZip");
    btn.disabled = true;
    exportStatus("ZIP を作っています…");
    try {
      const bytes = new Map(); // image id -> Uint8Array, read once however many entries use it
      const big = new Set();
      const exportImage = async im => {
        if (!im) return null;
        if (im.kind === "url") return { kind: "url", url: im.url };
        const blob = blobs.get(im.id);
        if (!blob) throw new Error(`画像「${im.name}」の中身が見つかりません。置き場で入れ直すか、使っている所の画像を変えてください。`);
        if (!bytes.has(im.id)) bytes.set(im.id, new Uint8Array(await blob.arrayBuffer()));
        if (tooBig(im)) big.add(im.id);
        return { kind: "file", type: im.type || blob.type, bytes: bytes.get(im.id), key: im.id };
      };
      const list = [];
      for (const e of all) list.push({ title: titleOf(e), text: e.text, image: await exportImage(imageOf(e)) });
      const { zip, files } = await R.build(list, {
        JSZip: window.JSZip, subtle: crypto.subtle, random: n => crypto.getRandomValues(new Uint8Array(n)),
      });
      const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
      download(blob, `scenario-text-${stamp()}.zip`);
      exportStatus(`書き出しました（シナリオテキスト ${all.length} 件・画像 ${files.length} 枚）。ココフォリアのルーム設定からインポートしてください。`
        + (big.size ? `5 MB を超える画像が ${big.size} 枚あり、ココフォリアで読み込めないことがあります。` : ""), big.size > 0);
    } catch (err) {
      console.error(err);
      exportStatus("ZIP を作れませんでした: " + err.message, true);
    } finally {
      btn.disabled = all.length === 0;
    }
  }

  // ---------------------------------------------------------------- wiring

  // Write images that came inline (older saves, project files) to IndexedDB, and fill in hashes.
  async function keepLifted(lifted) {
    for (const { id } of lifted) {
      const im = imageById(id); // normalize() made new objects; update the ones in state
      if (im && !im.hash) im.hash = await hashOf(blobs.get(id));
      if (db) await storeBlob(id, blobs.get(id));
    }
    if (lifted.length) saveNow();
  }

  async function projectData() {
    const images = [];
    for (const im of state.images) {
      if (im.kind === "file") {
        const blob = blobs.get(im.id);
        if (blob) images.push(Object.assign({}, im, { dataUrl: await blobToDataUrl(blob) }));
      } else images.push(Object.assign({}, im));
    }
    return { tool: "scenario-text-maker", version: 2, state: Object.assign({}, state, { images }) };
  }

  async function init() {
    const lifted = loadSaved();
    db = await openDb();
    await loadBlobs();
    await keepLifted(lifted);
    if (lifted.length) status(`前の版で設定した画像 ${lifted.length} 枚を、画像の置き場に移しました。`);
    else if (!db) status("このブラウザでは画像を保存できません。画像を使うときは「プロジェクトを保存」でファイルに残してください。", true);
    $("#script").value = state.script;
    syncOpts();

    // The shelf
    const drop = $("#drop");
    drop.addEventListener("click", () => $("#imageFiles").click());
    drop.addEventListener("keydown", ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); $("#imageFiles").click(); } });
    dropTarget(drop, ids => { if (ids.length) update(); });
    $("#imageFiles").addEventListener("change", ev => {
      const files = Array.from(ev.target.files);
      ev.target.value = "";
      addFiles(files).then(ids => { if (ids.length) update(); });
    });
    $("#imageFile").addEventListener("change", ev => {
      const files = Array.from(ev.target.files), take = pendingPick;
      ev.target.value = "";
      pendingPick = null;
      addFiles(files).then(ids => { if (take) take(ids); if (ids.length) update(); });
    });
    $("#addUrl").addEventListener("click", () => { if (addUrl()) { update(); status("URL の画像を置き場に入れました。"); } });
    $("#makeFromImages").addEventListener("click", makeFromImages);
    // A file dropped outside a drop area would make the browser leave the page to show it.
    window.addEventListener("dragover", ev => { if (hasFiles(ev)) ev.preventDefault(); });
    window.addEventListener("drop", ev => { if (hasFiles(ev) && !ev.defaultPrevented) { ev.preventDefault(); status("画像は「画像の置き場」の枠か、話し手の画像の所にドロップしてください。", true); } });

    $("#script").addEventListener("input", ev => { state.script = ev.target.value; update({ keepSpeakers: true }); });
    for (const el of document.querySelectorAll("[data-opt]")) {
      el.addEventListener(el.type === "text" ? "input" : "change", () => {
        state.opts[el.dataset.opt] = el.type === "checkbox" ? el.checked : el.value;
        syncOpts();
        update({ keepSpeakers: true });
      });
    }
    $("#addSpeaker").addEventListener("click", () => {
      state.speakers.push(newSpeaker(""));
      update();
      const inputs = document.querySelectorAll('#speakers [data-field="name"]');
      inputs[inputs.length - 1].focus();
    });
    $("#fillSample").addEventListener("click", () => {
      const sample = SAMPLES[state.opts.mode] || SAMPLES.script;
      if (state.script.trim() && !confirm("今の文章を例で置き換えますか？")) return;
      state.script = sample;
      state.edited = null;
      $("#script").value = sample;
      selected = 0;
      update();
    });
    $("#exportZip").addEventListener("click", exportZip);
    $("#exportImages").addEventListener("click", exportImages);
    $("#bundleAll").addEventListener("change", syncBundleButton);
    $("#confirmBatch").addEventListener("click", () => { if (confirmCurrent()) update({ keepSpeakers: true }); });
    wireEditor();

    $("#saveProject").addEventListener("click", async () => {
      try {
        download(new Blob([JSON.stringify(await projectData(), null, 1)], { type: "application/json" }), `scenario-text-${stamp()}.json`);
        status("プロジェクトを保存しました（置き場の画像も入っています）。");
      } catch (err) {
        status("プロジェクトを保存できませんでした: " + err.message, true);
      }
    });
    $("#loadProject").addEventListener("click", () => $("#projectFile").click());
    $("#projectFile").addEventListener("change", ev => {
      const file = ev.target.files[0];
      ev.target.value = "";
      if (!file) return;
      file.text().then(async text => {
        const data = JSON.parse(text);
        const s = data.state || data;
        const lifted = liftImages(s);
        const next = normalize(s);
        // The shelf keeps the images already there; the project's own come first.
        const ids = new Set(next.images.map(im => im.id));
        next.images = next.images.concat(state.images.filter(im => !ids.has(im.id)));
        state = next;
        await keepLifted(lifted);
        $("#script").value = state.script;
        selected = -1;
        syncOpts();
        update();
        status("プロジェクトを開きました。" + (lifted.length ? `画像 ${lifted.length} 枚を置き場に入れました。` : ""));
      }).catch(() => status("プロジェクトファイルを読めませんでした。", true));
    });
    $("#resetAll").addEventListener("click", () => {
      if (!confirm("話し手と文章、確定したものをすべて消して、最初からやり直しますか？（画像の置き場は残ります）")) return;
      state = Object.assign(defaultState(), { images: state.images });
      $("#script").value = "";
      selected = -1;
      syncOpts();
      update();
      status("最初からにしました。");
    });

    update();
  }

  init();
})();
