/* Installateur AeroTrack : choix de la carte et du rôle, puis installation par le câble USB
 * (Web Serial + esptool-js). catalogue.json, écrit par tools/publish_update.py, donne pour
 * chaque environnement le fichier complet à écrire à l'adresse 0x0, sa taille et son SHA-256. */
(function () {
  "use strict";

  // chip : nom renvoyé par esptool-js (ESPLoader.chip.CHIP_NAME), pour refuser une mauvaise carte
  const BOARDS = [
    { id: "heltec_v2", name: "Heltec WiFi LoRa 32 V2", detail: "ESP32, écran OLED, GPS externe", chip: "ESP32",
      envs: { tracker: "tracker_heltec_v2", base: "base_heltec_v2" } },
    { id: "heltec_wt", name: "Heltec Wireless Tracker V1.1", detail: "ESP32-S3, écran couleur, GPS intégré", chip: "ESP32-S3",
      envs: { tracker: "tracker_heltec_wt", base: "base_heltec_wt" } },
    { id: "tbeam", name: "LILYGO T-Beam", detail: "ESP32, GPS intégré, batterie 18650", chip: "ESP32",
      envs: { tracker: "tracker_tbeam", base: "base_tbeam" } },
    { id: "lora32", name: "LILYGO LoRa32 V2.1 (T3 1.6)", detail: "ESP32, écran OLED, carte micro-SD", chip: "ESP32",
      envs: { tracker: "tracker_lora32_v21", base: "base_lora32_v21" } },
    { id: "twatch", name: "LILYGO T-Watch 2019 + S76G", detail: "montre, GPS et radio intégrés", chip: "ESP32",
      envs: { tracker: "tracker_twatch" } },
    { id: "tsim", name: "LILYGO T-SIM7000G + module LoRa", detail: "ESP32, 4G LTE-M", chip: "ESP32",
      envs: { base: "base_tsim7000g" } },
    { id: "techo", name: "LILYGO T-Echo", detail: "nRF52840, écran à encre", uf2: true,
      envs: { tracker: "tracker_techo" } },
  ];
  const ROLE_TAG = { tracker: "tracker", base: "station base" };
  const BAUD = 460800;

  const $ = (id) => document.getElementById(id);
  const state = { board: null, role: null, mode: null, catalogue: null, file: null, busy: false };

  // ── Journal technique (« Avancé ») ─────────────────────────
  const log = (line) => {
    const el = $("log");
    el.textContent += line + "\n";
    el.scrollTop = el.scrollHeight;
  };
  const terminal = { clean() {}, writeLine: log, write: (d) => { $("log").textContent += d; } };

  // ── Catalogue en ligne ─────────────────────────────────────
  async function loadCatalogue() {
    if (location.protocol === "file:") { $("offline").hidden = false; return; }
    try {
      const r = await fetch("catalogue.json", { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      state.catalogue = await r.json();
      $("version").textContent = "Logiciel AeroTrack " + state.catalogue.version
        + (state.catalogue.date ? " du " + new Date(state.catalogue.date).toLocaleDateString("fr-FR") : "");
    } catch (e) {
      log("catalogue.json : " + e.message);
      $("offline").hidden = false;
    }
  }

  // ── Étapes ─────────────────────────────────────────────────
  function renderBoards() {
    const box = $("boards");
    for (const b of BOARDS) {
      const roles = Object.keys(b.envs).map((r) => ROLE_TAG[r]).join(" ou ");
      const label = document.createElement("label");
      label.className = "choice";
      label.innerHTML = `<input type="radio" name="board" value="${b.id}"><span class="dot"></span>`
        + `<span class="t">${b.name}<span class="d">${b.detail}</span></span><span class="tag">${roles}</span>`;
      box.appendChild(label);
    }
  }

  function env() {
    return state.board && state.role ? state.board.envs[state.role] : null;
  }

  function refresh() {
    const b = state.board;
    // Rôles possibles pour cette carte ; un seul rôle = choisi d'office
    for (const input of document.querySelectorAll('input[name="role"]')) {
      input.disabled = !b || !b.envs[input.value];
      if (input.disabled && input.checked) { input.checked = false; state.role = null; }
    }
    if (b && Object.keys(b.envs).length === 1) {
      state.role = Object.keys(b.envs)[0];
      document.querySelector(`input[name="role"][value="${state.role}"]`).checked = true;
    }
    $("step-board").classList.toggle("done", !!b);
    $("step-role").classList.toggle("locked", !b);
    $("step-role").classList.toggle("done", !!state.role);
    $("step-install").classList.toggle("locked", !env());

    const uf2 = !!(b && b.uf2);
    $("esp-flow").hidden = uf2;
    $("more").hidden = uf2;
    $("uf2-flow").hidden = !uf2;
    if (uf2) {
      const entry = state.catalogue && state.catalogue.boards[b.envs.tracker];
      const a = $("uf2-link");
      a.href = entry ? entry.file : "https://github.com/DIYEveryday/aerotrack-lora/tree/main/binaires";
      a.textContent = entry ? `AeroTrack ${state.catalogue.version} pour T-Echo (.uf2)` : "fichier .uf2 (dossier binaires du projet)";
    }
    const source = state.file || (state.catalogue && state.catalogue.boards[env()]);
    $("go").disabled = state.busy || !env() || !state.mode || !navigator.serial || !source;
    $("go").textContent = state.file ? `Installer ${state.file.name}` : "Installer AeroTrack";
  }

  document.addEventListener("change", (e) => {
    const t = e.target;
    if (t.name === "board") { state.board = BOARDS.find((b) => b.id === t.value); clearResult(); }
    if (t.name === "role") { state.role = t.value; clearResult(); }
    if (t.name === "mode") state.mode = t.value;
    refresh();
  });

  // ── Progression : la crête de l'icône s'allume ─────────────
  let ridgeLen = 0;
  function progress(what, pct) {
    $("progress").classList.add("on");
    $("what").textContent = what;
    $("pct").textContent = Math.round(pct) + " %";
    $("ridge-lit").style.strokeDashoffset = String(ridgeLen * (1 - pct / 100));
  }

  function clearResult() {
    $("result").className = "result";
    $("result").innerHTML = "";
  }

  const ICON_OK = '<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="#B6E43C"/><path d="M7 12.5l3.2 3.2L17 9" fill="none" stroke="#0B1834" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ICON_ERR = '<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="#FF9A8F"/><path d="M12 6.5v7M12 17v.5" stroke="#45201D" stroke-width="2.6" stroke-linecap="round"/></svg>';

  function showResult(ok, title, html) {
    const r = $("result");
    r.className = "result on " + (ok ? "ok" : "err");
    r.innerHTML = `<h3>${ok ? ICON_OK : ICON_ERR}${title}</h3>${html}`;
    r.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  // ── Téléchargement + vérification ──────────────────────────
  async function download(entry) {
    const r = await fetch(entry.file, { cache: "no-store" });
    if (!r.ok) throw Object.assign(new Error("HTTP " + r.status), { kind: "download" });
    const total = entry.size || Number(r.headers.get("content-length")) || 0;
    const reader = r.body.getReader();
    const parts = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      got += value.length;
      if (total) progress("Téléchargement du logiciel…", Math.min(got / total, 1) * 10);
    }
    const data = new Uint8Array(got);
    let at = 0;
    for (const p of parts) { data.set(p, at); at += p.length; }
    if (entry.sha256) {
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
      const hex = Array.from(digest, (x) => x.toString(16).padStart(2, "0")).join("");
      if (hex !== entry.sha256) throw Object.assign(new Error("SHA-256 différent"), { kind: "download" });
    }
    return data;
  }

  // ── Installation ───────────────────────────────────────────
  async function install(getData, label) {
    const board = state.board;
    let port = null, transport = null;
    state.busy = true;
    refresh();
    clearResult();
    $("log").textContent = "";
    try {
      // La fenêtre de choix du port doit s'ouvrir tout de suite après le clic
      port = await navigator.serial.requestPort();
      const data = await getData();
      log(`${label} : ${data.length} octets`);

      progress("Connexion à la carte…", 10);
      transport = new window.esptool.Transport(port, true);
      const loader = new window.esptool.ESPLoader({ transport, baudrate: BAUD, terminal, debugLogging: false });
      await loader.main();
      const chip = loader.chip.CHIP_NAME;
      log("Puce : " + chip);
      if (board.chip && chip !== board.chip) {
        throw Object.assign(new Error(chip), { kind: "chip", chip });
      }

      const erase = state.mode === "first";
      progress(erase ? "Effacement de la carte…" : "Installation…", 12);
      await loader.writeFlash({
        fileArray: [{ data, address: 0 }],
        flashMode: "keep", flashFreq: "keep", flashSize: "keep",
        eraseAll: erase, compress: true,
        reportProgress: (_i, written, total) => progress("Installation…", 12 + 86 * written / total),
      });
      progress("Redémarrage…", 99);
      await loader.after("hard_reset");
      progress("Terminé", 100);
      showResult(true, "AeroTrack est installé", successHtml(board, erase));
    } catch (e) {
      log("Erreur : " + (e && (e.message || e)));
      if (e && e.name === "NotFoundError") {          // fenêtre fermée sans choisir de port
        $("progress").classList.remove("on");
      } else {
        showResult(false, ...explain(e, board));
      }
    } finally {
      try { if (transport) await transport.disconnect(); else if (port && port.readable) await port.close(); } catch (_) {}
      state.busy = false;
      refresh();
    }
  }

  function successHtml(board, erased) {
    const steps = [];
    if (board.id === "twatch") {
      steps.push("La première fois, la montre affiche « Ouvrez la montre et maintenez BOOT0 » : ouvrez le dos et maintenez le petit bouton BOOT0 jusqu'à « Relâchez BOOT0 ». Elle installe alors le programme de son module radio et GPS (une minute). À ne faire qu'une fois.");
    }
    steps.push("Si l'écran reste éteint, débranchez puis rebranchez la carte.");
    if (erased) {
      steps.push("Installez l'<a href=\"../app/AeroTrack-Android.apk\">application AeroTrack</a> sur votre téléphone Android, puis appairez la carte <strong>dans les 3 minutes</strong> qui suivent son allumage.");
    }
    return `<ol>${steps.map((s) => `<li>${s}</li>`).join("")}</ol>`;
  }

  function explain(e, board) {
    const msg = String((e && e.message) || e);
    if (e && e.kind === "chip") {
      const other = BOARDS.filter((b) => b.chip === e.chip).map((b) => b.name);
      return ["Ce n'est pas la carte choisie",
        `<p>La carte branchée est un ${e.chip}, alors que « ${board.name} » est un ${board.chip}. Rien n'a été écrit.`
        + (other.length ? ` Cartes possibles : ${other.join(", ")}.` : "") + " Choisissez la bonne carte à l'étape 1.</p>"];
    }
    if (e && e.kind === "download") {
      return ["Le logiciel n'a pas pu être téléchargé",
        "<p>Vérifiez la connexion Internet, puis réessayez. Rien n'a été écrit sur la carte.</p>"];
    }
    if (/already open|Failed to open|NetworkError|InvalidStateError/i.test(msg)) {
      return ["La carte est occupée par un autre programme",
        "<p>Fermez ce qui l'utilise (Arduino, PlatformIO, un autre onglet de cette page, un moniteur série), puis réessayez.</p>"];
    }
    if (/connect|sync|timeout|Timed out|No serial data/i.test(msg)) {
      return ["La carte ne répond pas",
        "<ol><li>Vérifiez que le câble transmet les données (essayez-en un autre).</li>"
        + "<li>Maintenez le bouton <strong>BOOT</strong> (ou PRG) de la carte, appuyez brièvement sur <strong>RST</strong>, relâchez BOOT.</li>"
        + "<li>Recliquez sur « Installer AeroTrack ».</li></ol>"];
    }
    return ["L'installation n'a pas abouti",
      "<p>Débranchez puis rebranchez la carte et réessayez. Si cela recommence, ouvrez « Avancé » et envoyez le journal à l'école.</p>"];
  }

  // Le bouton installe le fichier choisi dans « Avancé » s'il y en a un, sinon celui du catalogue
  // (la fenêtre de choix du port n'a le droit de s'ouvrir qu'après un vrai clic)
  $("go").addEventListener("click", () => {
    const f = state.file;
    if (f) install(async () => new Uint8Array(await f.arrayBuffer()), f.name);
    else install(() => download(state.catalogue.boards[env()]), env());
  });

  $("file").addEventListener("change", () => {
    state.file = $("file").files[0] || null;
    refresh();
  });

  // ── Démarrage ──────────────────────────────────────────────
  renderBoards();
  ridgeLen = $("ridge-lit").getTotalLength();
  $("ridge-lit").style.strokeDasharray = String(ridgeLen);
  $("ridge-lit").style.strokeDashoffset = String(ridgeLen);
  if (!("serial" in navigator)) $("no-serial").hidden = false;
  loadCatalogue().then(refresh);
  refresh();
})();
