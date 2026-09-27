/*!
 * roomdata.v1.js - scenario text entries -> CCFOLIA room data zip (no UI)
 *
 * Format read from CCFOLIA 1.37.4 (main.09686af1.js, 2026-09-26):
 *   __data.json  {"meta":{"version":"1.1.0"},"entities":{...},"resources":{<file>:{"type":<mime>}}}
 *                entities.notes = { <id>: { name, text, iconUrl, order } }  (scenario texts)
 *   <file>       an image at the zip root, named <sha-256 hex of its bytes>.<extension of its mime>
 *                (CCFOLIA ignores a file whose name does not match its content). On import it is
 *                uploaded to shared storage and iconUrl is replaced with its URL.
 *   .token       "0." + sha-256 of __data.json. Ours never matches on purpose: CCFOLIA then asks
 *                "外部ツールで作成および編集されたデータです…" before importing, so the user knows
 *                the data came from an outside tool.
 * Import writes each entity by id (set), so new ids only add scenario texts. The other kinds are
 * empty and leave the room as it is; room {} only touches its updatedAt.
 *
 * A scenario text sent from CCFOLIA's list uses its title as the name and its iconUrl as the
 * image, which the message box shows as the portrait.
 */
(function (root) {
  "use strict";

  // CCFOLIA names files with mime's getExtension, which returns the first extension listed.
  const EXT = { "image/png": "png", "image/jpeg": "jpeg", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif" };
  const TOKEN = "0.not-signed-made-by-an-outside-tool";
  const EMPTY_KINDS = ["room", "items", "decks", "characters", "effects", "scenes", "savedatas", "snapshots"];

  const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");

  function dataUrlBytes(dataUrl) {
    const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl || "");
    if (!m) throw new Error("bad data url");
    const raw = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return { type: m[1], bytes };
  }

  function newId(random) {
    const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const r = random(20);
    let s = "";
    for (let i = 0; i < 20; i++) s += abc[r[i] % abc.length];
    return s;
  }

  /**
   * entries: [{ title, text, image }]
   *          image: null | { kind: "url", url } | { kind: "file", dataUrl }
   *                 | { kind: "file", type, bytes (Uint8Array), key }  (the portrait to send with it;
   *                 key, if given, marks images that are the same so they are hashed once)
   * deps:    { JSZip, subtle, random(n) -> Uint8Array, now }
   * -> { zip (JSZip), notes, files }  (call zip.generateAsync yourself)
   */
  async function build(entries, deps) {
    const { JSZip, subtle, random } = deps;
    const now = deps.now || Date.now();
    const zip = new JSZip();
    const resources = {};
    const refOf = new Map(); // image key -> file name, so a portrait used many times is stored once

    async function iconUrl(img) {
      if (!img) return "";
      if (img.kind === "url") return img.url || "";
      if (img.kind !== "file" || !(img.dataUrl || img.bytes)) return "";
      const k = img.key || img.dataUrl || img.bytes;
      if (refOf.has(k)) return refOf.get(k);
      const { type, bytes } = img.bytes ? { type: img.type, bytes: img.bytes } : dataUrlBytes(img.dataUrl);
      const ext = EXT[type];
      if (!ext) throw new Error("unsupported image type: " + type);
      const name = hex(await subtle.digest("SHA-256", bytes)) + "." + ext;
      if (!resources[name]) { resources[name] = { type }; zip.file(name, bytes); }
      refOf.set(k, name);
      return name;
    }

    // Seconds since 1970 as the base keeps each import after the ones before it in the list.
    const base = Math.floor(now / 1000);
    const notes = {};
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      notes[newId(random)] = { name: e.title || "", text: e.text || "", iconUrl: await iconUrl(e.image), order: base + i };
    }

    const entities = { notes };
    for (const k of EMPTY_KINDS) entities[k] = {};
    const data = { meta: { version: "1.1.0" }, entities, resources };
    zip.file("__data.json", JSON.stringify(data));
    zip.file(".token", TOKEN);
    return { zip, notes, files: Object.keys(resources) };
  }

  root.StRoomData = { build, EXT, TOKEN, dataUrlBytes, hex };
})(typeof window !== "undefined" ? window : globalThis);
