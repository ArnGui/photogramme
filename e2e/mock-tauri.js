// Faux backend Tauri pour les tests d'interface (Playwright).
//
// Injecté avant l'application : il remplace window.__TAURI_INTERNALS__ et
// répond aux commandes comme le fait le Rust (mêmes noms, mêmes formes de
// données, mêmes paquets binaires). Chaque appel est consigné dans
// window.__e2e.calls pour que les tests vérifient ce que l'interface demande.
//
// Réglage par test : window.__E2E_OPTS = { film: true|false, analysis: true|false, ... }
// posé par un addInitScript qui passe avant celui-ci.

(() => {
  const opts = Object.assign({ film: true, savedTab: null, outputDir: "D:\\Films\\Atelier\\stills", updates: true, failCommand: null }, window.__E2E_OPTS || {});
  const FPS = 24;
  const FRAMES = 240; // 10 s, comme la vidéo de test
  const W = 1280;
  const H = 536;

  const state = {
    calls: [],
    callbacks: new Map(),
    nextId: 1,
    eventListeners: new Map(),
    settings: {
      quality: 92, chroma: "4:4:4", outputDir: opts.outputDir,
      export: { subfolder: true, overlay: true, csv: true, csvPalette: false, format: "jpeg", color: "untagged", timecode: "file" },
      shots: { threshold: 10, minSeconds: 0.5, pick: { mode: "middle" }, decoder: "auto" },
      batch: { mode: "shots", intervalSeconds: 2, spreadCount: 12 },
      palette: { count: 6, sort: "share", ignoreBars: true, weighting: "area" },
      barcode: { width: 3840, height: 400, mode: "vertical" },
      overlay: null,
      sheet: { columns: 4, page: "a4", landscape: false, format: "pdf", dpi: 200, imageWidth: 3840, theme: "light", title: "{film}", showTc: true, showShot: true, showClip: false, showFrame: false, showPalette: true },
      updates: { checkAtStartup: false, skipped: null },
      ui: Object.assign({ scopesOpen: false, scope: "waveform", strip: "barcode", theme: "dark", skin: "studio", effects: true, accent: "gold", muted: false }, opts.ui || {}),
    },
    presets: [],
    analyzed: !!opts.analysis,
    imported: null,
    filmOpen: false,
    captures: 0,
    jobs: new Map(),
    nextJob: 1,
    projectUi: opts.savedTab ? { v: 1, frame: 0, source: "detect", removedCuts: [], addedCuts: [], unchecked: [], marks: { start: null, end: null }, captures: [], output: "stills", tab: opts.savedTab } : null,
  };

  const preset = (name, texts) => ({
    name,
    frame: { padTop: 60, padRight: 64, padBottom: 140, padLeft: 64, background: "#0B0B0B" },
    palette: { enabled: true, placement: "below", style: "squares", size: 48, gap: 10, margin: 24, align: "center", showHex: true, hexFont: { family: "IBM Plex Mono", size: 11, weight: 400, italic: false }, hexColor: "#9D988E" },
    texts,
    scope: { enabled: false, kind: "waveform", anchor: "topRight", region: "image", size: 320, opacity: 0.6, offsetX: 16, offsetY: 16 },
  });
  const text = (id, template, anchor, size) => ({
    id, enabled: true, template, font: { family: "Barlow Condensed", size, weight: 600, italic: false }, color: "#EFE9DD", opacity: 1,
    uppercase: true, letterSpacing: 4, anchor, region: "canvas", offsetX: 64, offsetY: 24, shadow: false, boxEnabled: false, boxColor: "#000000", boxOpacity: 0.5, boxPadding: 8,
  });
  state.presets = [
    preset("Cinema", [text("title", "{film}", "topLeft", 22), text("tc", "{tc}", "topRight", 18)]),
    preset("Grading check", [text("tc", "{tc} · {frame}", "bottomLeft", 16)]),
  ];
  state.settings.overlay = structuredClone(state.presets[0]);

  const info = {
    path: "/films/atelier_du_haut_v7_master.mp4", fileName: "atelier_du_haut_v7_master.mp4",
    width: W, height: H, sarNum: 1, sarDen: 1, rotation: 0, outWidth: W, outHeight: H,
    fpsNum: FPS, fpsDen: 1, fps: FPS, duration: FRAMES / FPS, frameCount: FRAMES, codec: "h264", profile: "High", pixFmt: "yuv420p",
    colorMatrix: "bt709", colorRange: "tv", colorTransfer: "bt709",
    timecode: { rate: 24, drop: false, start: 86400 }, fileTimecode: { rate: 24, drop: false, start: 86400 },
    nvdecCompatible: true, warnings: opts.warnings || [],
  };
  const tabs = () => ({
    active: state.filmOpen || opts.film ? "k1" : null,
    tabs: state.filmOpen || opts.film
      ? [{ key: "k1", fileName: info.fileName, folder: "/films", missing: false }, { key: "k2", fileName: "voix_de_lodeve_final.mp4", folder: "/films", missing: false }]
      : [],
  });

  const pad = (n) => String(n).padStart(2, "0");
  const tc = (f) => {
    const n = f + 86400;
    return `${pad(Math.floor(n / 86400))}:${pad(Math.floor(n / 1440) % 60)}:${pad(Math.floor(n / 24) % 60)}:${pad(n % 24)}`;
  };

  // Image synthétique 2,39:1 (ciel, montagnes, sol, manteau rouge) : couleurs connues pour vérifier la palette et le ratio.
  function rgba(frame, w = W, h = H) {
    const px = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const ridge = h * (0.45 + 0.12 * Math.sin((x / w) * 9 + frame / 40));
        let c;
        if (y < ridge) c = [217 - (y / h) * 60, 203 - (y / h) * 80, 176 - (y / h) * 90];
        else if (y < h * 0.66) c = [91, 106, 104];
        else c = [59, 53, 48];
        if (x > w * 0.6 && x < w * 0.625 && y > h * 0.5 && y < h * 0.78) c = [184, 50, 42];
        px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
      }
    }
    return px;
  }
  const palette = [
    { hex: "#D9CBB0", rgb: [217, 203, 176], share: 0.3, lab: [82, 2, 14] },
    { hex: "#C6A985", rgb: [198, 169, 133], share: 0.22, lab: [71, 5, 21] },
    { hex: "#5B6A68", rgb: [91, 106, 104], share: 0.18, lab: [43, -5, -1] },
    { hex: "#3B3530", rgb: [59, 53, 48], share: 0.2, lab: [23, 2, 3] },
    { hex: "#8F6D52", rgb: [143, 109, 82], share: 0.07, lab: [49, 9, 19] },
    { hex: "#B8322A", rgb: [184, 50, 42], share: 0.03, lab: [43, 55, 37] },
  ];
  function packet(header, px) {
    const json = new TextEncoder().encode(JSON.stringify(header));
    const out = new Uint8Array(4 + json.length + px.length);
    new DataView(out.buffer).setUint32(0, json.length, true);
    out.set(json, 4);
    out.set(px, 4 + json.length);
    return out.buffer;
  }
  const frameCache = new Map();
  function framePacket(frame, extra = {}) {
    if (!frameCache.has(frame % 8)) frameCache.set(frame % 8, rgba(frame % 8));
    return packet({ frame, timecode: tc(frame), width: W, height: H, palette, shot: null, clip: null, ...extra }, frameCache.get(frame % 8));
  }
  async function jpegBytes(w, h) {
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext("2d");
    for (let x = 0; x < w; x += 4) {
      const t = x / w;
      ctx.fillStyle = `hsl(${30 + 20 * Math.sin(t * 20) + (Math.round(t * 50) % 11 === 0 ? 170 : 0)} 25% ${25 + 25 * Math.abs(Math.sin(t * 13))}%)`;
      ctx.fillRect(x, 0, 4, h);
    }
    return (await c.convertToBlob({ type: "image/jpeg", quality: 0.8 })).arrayBuffer();
  }

  const cutsFor = (threshold, minSeconds, extra) => {
    // Coupe tous les 10 à 26 images ; un seuil plus haut en garde moins.
    const step = Math.round(10 + threshold * 0.8);
    const minLen = Math.max(1, Math.round(minSeconds * FPS));
    const cuts = [];
    for (let f = step; f < FRAMES; f += step) cuts.push(f);
    for (const e of extra) if (!cuts.includes(e)) cuts.push(e);
    cuts.sort((a, b) => a - b);
    const kept = [];
    let last = 0;
    for (const c of cuts) if (c - last >= minLen || extra.includes(c)) { kept.push(c); last = c; }
    return kept;
  };

  // Comme le Rust : un compteur par canal, les messages arrivent numérotés dans l'ordre.
  const channelIndex = new Map();
  function emitChannel(ch, messages, delay = 15) {
    let i = 0;
    return new Promise((resolve) => {
      const tick = () => {
        if (i >= messages.length) return resolve();
        const n = channelIndex.get(ch.id) ?? 0;
        channelIndex.set(ch.id, n + 1);
        state.callbacks.get(ch.id)?.({ index: n, message: messages[i] });
        i++;
        setTimeout(tick, delay);
      };
      tick();
    });
  }

  let captureN = 0;
  const captureResult = (frame, shot = null) => {
    captureN += 1;
    const fileName = `atelier_du_haut_${tc(frame).replace(/:/g, "")}_${captureN}.jpg`;
    return { path: `D:\\Films\\Atelier\\stills\\${fileName}`, fileName, frame, timecode: tc(frame), bytes: 412000, width: W, height: H, quality: 92, shot };
  };

  const commands = {
    current_video: () => (state.filmOpen ? info : null),
    tabs_list: () => tabs(),
    tab_open: ({ key }) => {
      state.filmOpen = true;
      return key === "k2" ? { ...info, fileName: "voix_de_lodeve_final.mp4", path: "/films/voix_de_lodeve_final.mp4" } : info;
    },
    tab_close: () => {
      state.filmOpen = false;
      opts.film = false;
      return { active: null, tabs: [] };
    },
    pick_video: () => {
      state.filmOpen = true;
      opts.film = true;
      return info;
    },
    project_restore: () => ({ ui: state.projectUi, analysis: state.analyzed ? analysisSummary() : null, imported: null, filmChanged: false }),
    project_save: ({ ui }) => {
      state.projectUi = ui;
    },
    project_cache_size: () => 52428800,
    project_cache_clear: () => 52428800,
    get_settings: () => structuredClone(state.settings),
    update_settings: (a) => {
      state.settings = structuredClone(a.new);
      return structuredClone(state.settings);
    },
    pick_output_dir: () => {
      state.settings.outputDir = "D:\\Films\\Atelier\\stills";
      return structuredClone(state.settings);
    },
    capture: ({ frame }) => captureResult(frame),
    write_composed: (packetArgs) => {
      const buf = packetArgs instanceof Uint8Array ? packetArgs : new Uint8Array(packetArgs);
      const n = new DataView(buf.buffer, buf.byteOffset).getUint32(0, true);
      const header = JSON.parse(new TextDecoder().decode(buf.subarray(4, 4 + n)));
      state.lastComposed = { ...header, bytes: buf.length - 4 - n };
      const res = captureResult(header.frame, header.shot ?? null);
      // Image d'un export : le Rust l'annonce sur le canal du travail (frames.rs).
      const j = header.job != null ? state.jobs.get(header.job) : null;
      if (j) {
        j.written += 1;
        void emitChannel(j.onEvent, [{ kind: "written", capture: res }, { kind: "progress", phase: "export", done: j.written, total: j.frames.length }], 0);
      }
      return res;
    },
    reveal: () => {},
    open_folder: () => {},
    save_palette: () => ["D:\\out\\pal.ase", "D:\\out\\pal.css", "D:\\out\\pal.gpl", "D:\\out\\pal.json"],
    // window.__grabDelay (ms) : simule un décodage FFmpeg lent (GOP long).
    grab_frame: async ({ frame }) => {
      if (window.__grabDelay) await new Promise((r) => setTimeout(r, window.__grabDelay));
      return framePacket(frame);
    },
    grab_probe: () => {
      throw "Cannot read back the viewer (test).";
    },
    analyze: async ({ onEvent }) => {
      await emitChannel(onEvent, [
        { kind: "progress", phase: "analysis-gpu", done: 60, total: FRAMES },
        { kind: "progress", phase: "analysis-gpu", done: 180, total: FRAMES },
        { kind: "progress", phase: "analysis-gpu", done: FRAMES, total: FRAMES },
      ], 40);
      state.analyzed = true;
      return analysisSummary();
    },
    cancel_analysis: () => {},
    list_shots: ({ source, threshold, minSeconds, extraCuts }) => {
      const cuts = source === "imported" ? [24, 72, 120, 168, 216] : cutsFor(threshold, minSeconds, extraCuts);
      const starts = [0, ...cuts];
      return starts.map((s, i) => ({
        index: i + 1, start: s, end: i + 1 < starts.length ? starts[i + 1] : FRAMES, score: extraCuts.includes(s) ? -1 : 20,
        thumb: s, clip: source === "imported" ? `A00${i + 1}_C00${i + 1}` : null,
      }));
    },
    import_cuts: () => {
      state.imported = { format: "EDL (CMX 3600)", fileName: "atelier_v7.edl", cuts: [24, 72, 120, 168, 216], shots: 6, warnings: [] };
      return state.imported;
    },
    clear_cuts: () => {},
    barcode_preview: ({ width, height }) => jpegBytes(Math.min(width, 1024), height),
    export_barcode: () => ({ ...captureResult(0), fileName: "atelier_barcode.jpg", width: 3840, height: 400 }),
    batch_plan: ({ request, range }) => {
      const span = range ? range.end - range.start + 1 : FRAMES;
      if (request.kind === "shots") {
        const per = request.pick.mode === "spread" ? request.pick.count : 1;
        if (!request.shots.length) throw "No shot selected.";
        return { count: request.shots.length * per, first: [] };
      }
      if (request.kind === "interval") return { count: Math.max(1, Math.floor(span / (request.seconds * FPS))), first: [] };
      return { count: Math.min(request.count, span), first: [] };
    },
    batch_start: async ({ request, range, target, onEvent }) => {
      const job = state.nextJob++;
      const total = request.kind === "shots" ? request.shots.length : 6;
      const frames = Array.from({ length: total }, (_, i) => Math.round(((i + 0.5) / total) * (FRAMES - 1)));
      state.jobs.set(job, { frames, next: 0, onEvent, target, written: 0, pages: 0, cancelled: false });
      state.lastBatch = { request, range, target };
      if (target.kind === "stills" && !target.compose) {
        // Le Rust écrit seul : progression, images écrites, fin.
        setTimeout(async () => {
          const msgs = [];
          frames.forEach((f, i) => {
            msgs.push({ kind: "progress", phase: "export", done: i + 1, total });
            msgs.push({ kind: "written", capture: captureResult(f, i + 1) });
          });
          msgs.push({ kind: "done", written: total, dir: "D:\\Films\\Atelier\\stills\\atelier_shots", csv: "D:\\x.csv", file: null });
          await emitChannel(onEvent, msgs, 25);
        }, 30);
      }
      return { job, total, dir: "D:\\Films\\Atelier\\stills\\atelier_shots", width: W, height: H };
    },
    batch_pull: ({ job }) => {
      const j = state.jobs.get(job);
      if (!j || j.cancelled) throw "Cancelled.";
      if (j.next >= j.frames.length) return new ArrayBuffer(0);
      const f = j.frames[j.next++];
      return framePacket(f, { shot: j.next, job, total: j.frames.length });
    },
    sheet_page: () => {
      for (const j of state.jobs.values()) j.pages += 1;
      return 1;
    },
    batch_finish: ({ job }) => {
      const j = state.jobs.get(job);
      const sheet = j.target.kind === "sheet";
      const msgs = [];
      msgs.push({ kind: "done", written: sheet ? j.pages : j.frames.length, dir: "D:\\Films\\Atelier\\stills", csv: null, file: sheet ? "D:\\Films\\Atelier\\atelier_contact.pdf" : null });
      void emitChannel(j.onEvent, msgs, 10);
    },
    batch_cancel: () => {
      for (const j of state.jobs.values()) {
        j.cancelled = true;
        void emitChannel(j.onEvent, [{ kind: "cancelled" }], 5);
      }
    },
    list_presets: () => structuredClone(state.presets),
    save_preset: ({ preset: p }) => {
      state.presets = [...state.presets.filter((x) => x.name !== p.name), structuredClone(p)];
      return structuredClone(state.presets);
    },
    delete_preset: ({ name }) => {
      state.presets = state.presets.filter((x) => x.name !== name);
      return structuredClone(state.presets);
    },
    open_presets_folder: () => {},
    app_info: () => ({ version: "0.7.0", repo: "https://github.com/ArnGui/photogramme", kofi: "https://ko-fi.com/arngui", updatesEnabled: opts.updates }),
    open_link: () => {},
    check_update: () => ({ current: "0.7.0", version: null, notes: null, date: null }),
    install_update: () => {},
    "plugin:event|listen": ({ event, handler }) => {
      state.eventListeners.set(event, handler);
      return state.nextId++;
    },
    "plugin:event|unlisten": () => {},
  };
  function analysisSummary() {
    return { id: 7, frames: FRAMES, decoder: "gpu", note: null, seconds: 1.4, thumbs: 40, thumbWidth: 160, thumbHeight: 67, memoryMb: 12 };
  }

  window.__e2e = {
    state,
    calls: state.calls,
    /** Simule un film déposé sur la fenêtre (événement « film » émis par le Rust). */
    dropFilm() {
      const h = state.eventListeners.get("film");
      state.filmOpen = true;
      opts.film = true;
      state.callbacks.get(h)?.({ event: "film", id: 1, payload: { kind: "opened", info } });
    },
  };

  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    plugins: {},
    transformCallback(cb, once) {
      const id = state.nextId++;
      state.callbacks.set(id, (data) => {
        if (once) state.callbacks.delete(id);
        return cb && cb(data);
      });
      return id;
    },
    unregisterCallback(id) {
      state.callbacks.delete(id);
    },
    convertFileSrc(path, protocol = "asset") {
      return `http://e2e.local/${protocol}/${encodeURIComponent(path)}`;
    },
    async invoke(cmd, args = {}) {
      state.calls.push({ cmd, args: cmd === "write_composed" || cmd === "sheet_page" ? "<binary>" : JSON.parse(JSON.stringify(args ?? {}, (k, v) => (v && typeof v === "object" && "id" in v && "onmessage" in v ? "<channel>" : v))) });
      if (opts.failCommand === cmd) throw `${cmd} failed (test).`;
      const f = commands[cmd];
      if (!f) throw `Unknown command in the test backend: ${cmd}`;
      return f(args);
    },
  };
})();
