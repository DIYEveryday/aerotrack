/* AeroTrack — carte des bases.
 * Données : api/donnees.php (15 s), api/couverture.php (2 min), api/sites.php (sites FFVL, balises).
 * La page est servie par chooksprod.com/aerotrack/carte/ et par GitHub Pages : l'API reste
 * toujours sur chooksprod (seul serveur qui reçoit les rapports des bases). */
(() => {
  'use strict';

  const API = /(^|\.)chooksprod\.com$/.test(location.hostname) ? 'api/' : 'https://chooksprod.com/aerotrack/carte/api/';
  const RAFRAICHIR_MS = 15000;
  const COUVERTURE_MS = 120000;
  const BALISES_MS = 600000;
  const ZOOM_DETAILS = 10;          // sites et balises : à partir de ce zoom
  const ZOOM_ICONES = 12;           // sites : grandes icônes (rose des vents) à partir de ce zoom
  const ZOOM_NOMS = 13;             // sites : nom sous l'icône
  const MAX_DETAILS = 500;          // marqueurs de sites / balises affichés à la fois
  const BASE_RECENTE_S = 420;       // une base envoie toutes les 1 à 5 min
  const AVION_VIEUX_S = 300;

  const NOMS_CARTES = {
    base_heltec_v2: 'Heltec LoRa32 V2', base_heltec_wt: 'Heltec Wireless Tracker', base_tbeam: 'LILYGO T-Beam',
    base_tsim7000g: 'LILYGO T-SIM7000G (4G)', base_lora32_v21: 'LILYGO LoRa32 V2.1',
  };
  const CATEGORIES = {
    parapente: 'Parapente', delta: 'Delta', planeur: 'Planeur', avion: 'Avion', helico: 'Hélicoptère',
    ballon: 'Ballon', drone: 'Drone', parachute: 'Parachute', autre: 'Aéronef',
  };
  const SOURCES = { A: 'AeroTrack', F: 'FANET', O: 'Réseau OGN' };
  const COULEURS = { A: '#B6E43C', F: '#26B3C4', O: '#E8EEF8', sos: '#FF5A4E' };

  // ── Outils ───────────────────────────────────────
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nombre = (n) => Number(n).toLocaleString('fr-FR');
  function depuis(s) {
    if (s < 20) return 'à l\'instant';
    if (s < 60) return `il y a ${Math.round(s)} s`;
    if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
    if (s < 86400) return `il y a ${Math.round(s / 3600)} h`;
    const j = Math.round(s / 86400);
    return `il y a ${j} jour${j > 1 ? 's' : ''}`;
  }
  const heure = (ts) => new Date(ts * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const date = (ts) => new Date(ts * 1000).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const dateHeure = (ts) => new Date(ts * 1000).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const largeurFiche = () => Math.min(320, window.innerWidth - 40);   // fiche entière sur un téléphone
  const cardinal = (d) => ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'][Math.round(((d % 360) + 360) % 360 / 45) % 8];
  async function lire(url) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  // ── Carte ────────────────────────────────────────
  // Une fiche ouverte se recentre sans passer sous les boutons de zoom et de fonds de carte
  L.Popup.prototype.options.autoPanPaddingTopLeft = L.point(10, 64);
  L.Popup.prototype.options.autoPanPaddingBottomRight = L.point(10, 24);
  const carte = L.map('carte', { zoomControl: true, worldCopyJump: true }).setView([46.5, 2.5], 6);
  const fonds = {
    'Relief': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      maxZoom: 17, subdomains: 'abc',
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, SRTM · <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
    }),
    'Plan': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }),
    'Satellite': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 18, attribution: 'Imagerie © Esri, Maxar, Earthstar Geographics',
    }),
  };
  fonds['Relief'].addTo(carte);
  L.control.layers(fonds, null, { position: 'topright' }).addTo(carte);
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(carte);

  [['couverture', 350], ['liens', 390], ['traces', 400], ['details', 580], ['bases', 650], ['avions', 660]]
    .forEach(([nom, z]) => { carte.createPane(nom).style.zIndex = z; });
  // Calques : à l'ouverture, seuls les trackers et le vol libre FANET / OGN sont affichés (cases de index.html,
  // remises à leur état par défaut : un navigateur peut restaurer les cases cochées lors d'un rechargement)
  const calques = {
    couverture: L.layerGroup(), couvmobile: L.layerGroup(), liens: L.layerGroup(), traces: L.layerGroup(), aerotrack: L.layerGroup(),
    fanet: L.layerGroup(), autres: L.layerGroup(), sites: L.layerGroup(), balises: L.layerGroup(),
    bases: L.layerGroup().addTo(carte), chemins: L.layerGroup(),
  };
  document.querySelectorAll('[data-calque]').forEach((c) => {
    c.checked = c.defaultChecked;
    if (c.checked) calques[c.dataset.calque].addTo(carte);
  });
  // Vol libre (parapente, delta, varios FANET) d'un côté ; avions, hélicos, planeurs… de l'autre
  const MOTORISES = new Set(['avion', 'helico', 'planeur', 'ballon', 'drone', 'parachute']);
  const estAeroTrack = (a) => a.src === 'A' || (a.src === 'F' && a.id.startsWith('FNTFC'));   // fabricant FANET 0xFC
  const groupeDe = (a) => (estAeroTrack(a) ? 'aerotrack'
    : (a.cat === 'parapente' || a.cat === 'delta' || (a.src === 'F' && !MOTORISES.has(a.cat))) ? 'fanet' : 'autres');
  const avionVisible = (a) => carte.hasLayer(calques[groupeDe(a)]);

  const etat = {
    donnees: null, couverture: null, filtreBase: null, sites: null, balises: null, balisesLues: 0,
    marqueursBases: new Map(), marqueursAvions: new Map(), cadree: false, erreur: false,
  };

  // ── Bases ────────────────────────────────────────
  const nomBase = (b) => (b && b.nom) || (b ? `Base ${b.id.slice(-4)}` : 'base inconnue');
  const baseParId = (id) => etat.donnees?.bases.find((b) => b.id === id);
  const nomParId = (id) => { const b = baseParId(id); return b ? nomBase(b) : `Base ${String(id).slice(-4)}`; };

  function etatBase(b, now) {
    const recente = b.dernier && now - b.dernier < BASE_RECENTE_S;
    if (recente && b.enligne) return { cls: 'enligne', texte: 'En ligne', detail: 'Reçoit les trackers et les envoie à la FFVL' };
    if (recente && b.amont) return { cls: 'relais', texte: 'Relais radio', detail: `Fait suivre par radio vers ${nomParId(b.amont)}` };
    if (!recente && b.vu_radio && now - b.vu_radio < 600) {
      return { cls: 'relais', texte: 'Relais radio', detail: `Sans Internet, entendue par ${nomParId(b.vu_par)}` };
    }
    if (recente) return { cls: 'attention', texte: 'Connectée, envoi FFVL indisponible', detail: 'Internet présent mais la FFVL ne reçoit rien (firmware non officiel ?)' };
    return { cls: 'horsligne', texte: 'Hors ligne', detail: b.dernier ? `Dernière connexion ${depuis(now - b.dernier)}` : '' };
  }

  const SVG_ANTENNE = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="10" r="1.8"/><path d="M12 12v9M9 21h6M8.2 6.2a5.4 5.4 0 0 0 0 7.6M15.8 6.2a5.4 5.4 0 0 1 0 7.6M5.2 3.2a9.6 9.6 0 0 0 0 13.6M18.8 3.2a9.6 9.6 0 0 1 0 13.6"/></svg>';

  function ficheBase(b, now) {
    const e = etatBase(b, now);
    const lien = b.amont ? `Relais radio vers ${esc(nomParId(b.amont))}` : (b.lien === '--' ? '—' : esc(b.lien));
    return `<div class="fiche">
      <h3>${esc(nomBase(b))}</h3>
      <div class="sous">Base ${esc(b.id)}${b.hw ? ' · ' + esc(NOMS_CARTES[b.hw] || b.hw) : ''}</div>
      <span class="etiquette ${e.cls}">${esc(e.texte)}</span>${b.mobile ? '<span class="etiquette mobile">Base mobile</span>' : ''}
      <dl>
        <dt>Dernière connexion</dt><dd>${b.dernier ? `${depuis(now - b.dernier)} <span class="sous">(${dateHeure(b.dernier)})</span>` : '—'}</dd>
        <dt>Liaison</dt><dd>${lien}</dd>
        <dt>Trackers actifs</dt><dd>${b.trk ?? 0}</dd>
        ${b.bat !== null && b.bat >= 0 ? `<dt>Batterie</dt><dd>${b.bat} %</dd>` : ''}
        ${b.alt !== null ? `<dt>Altitude</dt><dd>${nombre(b.alt)} m</dd>` : ''}
        ${b.fw ? `<dt>Version</dt><dd>${esc(b.fw)}</dd>` : ''}
        ${b.premier ? `<dt>Sur la carte depuis</dt><dd>${date(b.premier)}</dd>` : ''}
      </dl>
      ${e.detail ? `<div class="note">${esc(e.detail)}</div>` : ''}
      <div class="actions">
        <button type="button" data-couv="${esc(b.id)}">Sa couverture seule</button>
        <button type="button" data-couv="">Toutes les couvertures</button>
      </div>
      ${b.mobile ? '<div class="note">Base mobile : emportée de site en site. Elle est placée là où elle a été installée la dernière fois ; sa couverture est montrée à part (temporaire).</div>' : ''}
      ${b.flou ? '<div class="note">Position volontairement approximative (≈ 1 km), choisie par le propriétaire.</div>' : ''}
    </div>`;
  }

  function dessinerBases(now) {
    const vues = new Set();
    for (const b of etat.donnees.bases) {
      vues.add(b.id);
      const e = etatBase(b, now);
      const html = `<div class="m-base ${e.cls}${b.mobile ? ' mobile' : ''}"><div class="rond">${SVG_ANTENNE}</div><div class="nom">${esc(nomBase(b))}</div></div>`;
      const icone = L.divIcon({ className: '', html, iconSize: [140, 52], iconAnchor: [70, 16], popupAnchor: [0, -14] });
      let m = etat.marqueursBases.get(b.id);
      if (!m) {
        m = L.marker([b.lat, b.lon], { icon: icone, pane: 'bases', title: nomBase(b), riseOnHover: true }).addTo(calques.bases);
        m.bindPopup('', { maxWidth: largeurFiche() });
        etat.marqueursBases.set(b.id, m);
      } else {
        m.setLatLng([b.lat, b.lon]);
        m.setIcon(icone);
      }
      m.setPopupContent(ficheBase(b, now));
    }
    for (const [id, m] of etat.marqueursBases) {
      if (!vues.has(id)) { calques.bases.removeLayer(m); etat.marqueursBases.delete(id); }
    }
  }

  function dessinerListe(now) {
    const ul = $('#liste-bases');
    const bases = [...etat.donnees.bases];
    const rang = { enligne: 0, relais: 1, attention: 2, horsligne: 3 };
    bases.sort((a, b) => rang[etatBase(a, now).cls] - rang[etatBase(b, now).cls] || nomBase(a).localeCompare(nomBase(b), 'fr'));
    if (!bases.length) {
      ul.innerHTML = '<li class="vide">Aucune base sur la carte pour l\'instant. Dans l\'application : réglages de la base → « Apparaître sur la carte ».</li>';
      return;
    }
    ul.innerHTML = bases.map((b) => {
      const e = etatBase(b, now);
      const sous = e.cls === 'horsligne' ? (b.dernier ? `Vue ${depuis(now - b.dernier)}` : 'Hors ligne') : e.texte;
      return `<li><button type="button" data-base="${esc(b.id)}">
        <span class="point ${e.cls}"></span>
        <span><span class="nom">${esc(nomBase(b))}</span><span class="etat">${esc(sous)}${b.mobile ? ' · base mobile' : ''}</span></span>
        <span class="trk">${b.trk ? `${b.trk} tracker${b.trk > 1 ? 's' : ''}` : ''}</span></button></li>`;
    }).join('');
  }

  function montrerBase(id) {
    const b = baseParId(id);
    const m = etat.marqueursBases.get(id);
    if (!b || !m) return;
    fermerPanneau();
    carte.flyTo([b.lat, b.lon], Math.max(carte.getZoom(), 11), { duration: 0.8 });
    carte.once('moveend', () => m.openPopup());
  }

  // ── Liaisons entre bases ─────────────────────────
  function dessinerLiens() {
    calques.liens.clearLayers();
    const vus = new Set();
    const tracer = (a, b, relais, texte) => {
      const A = baseParId(a), B = baseParId(b);
      const cle = [a, b].sort().join('-');
      if (!A || !B || vus.has(cle)) return;
      vus.add(cle);
      L.polyline([[A.lat, A.lon], [B.lat, B.lon]], {
        pane: 'liens', color: '#26B3C4', weight: relais ? 3 : 1.5, opacity: relais ? 0.9 : 0.6,
        dashArray: relais ? '8 6' : '2 6', interactive: true,
      }).bindTooltip(texte, { sticky: true }).addTo(calques.liens);
    };
    for (const b of etat.donnees.bases) {
      if (b.amont) tracer(b.id, b.amont, true, `${nomBase(b)} relaie par radio vers ${nomParId(b.amont)}`);
    }
    for (const l of etat.donnees.liens) {
      const A = baseParId(l.a);
      const relais = A && A.enligne && l.metrique >= 1 && l.metrique < 15;
      tracer(l.a, l.b, relais, relais ? `${nomParId(l.b)} relaie par radio vers ${nomParId(l.a)} (${l.rssi} dBm)`
        : `${nomParId(l.a)} entend ${nomParId(l.b)} : ${l.rssi} dBm`);
    }
  }

  // ── Aéronefs ─────────────────────────────────────
  // Identifiant court : 35E4 pour nos trackers, adresse sans préfixe pour les autres
  function idCourt(a) {
    if (a.anonyme) return 'anonyme';
    if (a.id.startsWith('FNT') && a.src !== 'O') return a.id.slice(-4);
    return a.id.replace(/^(FLR|ICA|OGN|FNT|PAW|SKY|NAV|RND)/, '');
  }
  // Nom affiché : celui du pilote (saisi sur son tracker) s'il est connu, sinon l'identifiant
  function nomCourt(a) { return a.nom || idCourt(a); }
  // « Alexis (35E4) » dans les bandeaux, où il n'y a pas de seconde ligne
  function nomEtId(a) { return a.nom ? `${a.nom} (${idCourt(a)})` : idCourt(a); }

  function iconeAvion(a, now) {
    const couleur = a.sos ? COULEURS.sos : COULEURS[a.src] || COULEURS.O;
    const vieux = now - a.ts > AVION_VIEUX_S;
    const forme = a.cap !== null && a.kmh > 3
      ? `<g transform="rotate(${a.cap} 16 16)"><path d="M16 3 L25 27 L16 21.5 L7 27 Z" fill="${couleur}" stroke="#0B1834" stroke-width="1.5" stroke-linejoin="round"/></g>`
      : `<circle cx="16" cy="16" r="7" fill="${couleur}" stroke="#0B1834" stroke-width="2"/>`;
    const alt = a.alt !== null ? `${nombre(a.alt)} m` : null;
    // Nom du pilote en gros, identifiant (et altitude) en petit dessous
    const etiq = a.nom
      ? `<b>${esc(a.nom)}</b><small>${esc([idCourt(a), alt].filter(Boolean).join(' · '))}</small>`
      : esc([idCourt(a), alt].filter(Boolean).join(' · '));
    const html = `<div class="m-avion${vieux ? ' vieux' : ''}${a.sos ? ' sos' : ''}"><svg viewBox="0 0 32 32" aria-hidden="true">${forme}</svg><span class="etiq${a.nom ? ' deux' : ''}">${etiq}</span></div>`;
    return L.divIcon({ className: '', html, iconSize: [26, 26], iconAnchor: [13, 13], popupAnchor: [0, -12] });
  }

  // Chemin radio d'une position : appareil → dernier relais (tracker ou base) → base qui l'a reçue.
  // Une trame ne garde que le DERNIER relais : avec deux relais, le premier reste inconnu.
  function relaisDe(a) {
    if (!a.relais) return null;
    const b = baseParId(a.relais);
    if (b) return { lat: b.lat, lon: b.lon, nom: nomBase(b) };
    const court = a.relais.slice(-4);
    const t = etat.donnees.aeronefs.find((x) => x.src !== 'O' && x.id.startsWith('FNT') && x.id.endsWith(court));
    return t ? { lat: t.lat, lon: t.lon, nom: nomCourt(t) } : { nom: court };
  }
  function cheminTexte(a) {
    const r = relaisDe(a);
    const etapes = [nomCourt(a), r ? r.nom : null, a.base ? nomParId(a.base) : null].filter(Boolean);
    return etapes.join(' → ') + (a.rssi !== null && a.base ? ` (${a.rssi} dBm)` : '');
  }

  function dessinerChemins(now) {
    calques.chemins.clearLayers();
    if (!carte.hasLayer(calques.chemins)) return;
    for (const a of etat.donnees.aeronefs) {
      if (!a.base || a.src === 'O' || now - a.ts > 600) continue;
      const B = baseParId(a.base);
      if (!B) continue;
      if (!avionVisible(a)) continue;
      const r = relaisDe(a);
      const final = a.sos ? COULEURS.sos : couleurSignal(a.rssi ?? -120);   // dernier saut : qualité reçue par la base
      const texte = `Chemin de la position : ${esc(cheminTexte(a))}`;
      const ligne = (pts, couleur) => {
        // Liseré sombre sous le pointillé animé : lisible sur le relief comme sur la couverture
        L.polyline(pts, { pane: 'liens', color: '#0B1834', weight: 7, opacity: 0.45, lineCap: 'round', interactive: false })
          .addTo(calques.chemins);
        L.polyline(pts, { pane: 'liens', color: couleur, weight: 3.5, opacity: 1, dashArray: '1 8', lineCap: 'round', className: 'chemin' })
          .bindTooltip(texte, { sticky: true }).addTo(calques.chemins);
      };
      if (r && r.lat !== undefined) {
        ligne([[a.lat, a.lon], [r.lat, r.lon]], '#26B3C4');
        ligne([[r.lat, r.lon], [B.lat, B.lon]], final);
      } else {
        ligne([[a.lat, a.lon], [B.lat, B.lon]], r ? '#8A9AB5' : final);    // relais de position inconnue : gris
      }
    }
  }

  function ficheAvion(a, now) {
    let source = SOURCES[a.src] || a.src;
    if (a.base) source += ` : ${esc(cheminTexte(a))}`;
    if (relaisDe(a)?.lat === undefined && a.relais) source += ' (position du relais inconnue)';
    const vz = a.vz === null ? null : `${a.vz > 0 ? '+' : ''}${a.vz.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} m/s`;
    return `<div class="fiche">
      <h3>${esc(CATEGORIES[a.cat] || 'Aéronef')} ${esc(nomCourt(a))}</h3>
      <div class="sous">${a.anonyme ? 'Identité masquée à la demande de son propriétaire' : esc(a.id)}</div>
      ${a.sos ? '<span class="etiquette sos">SOS en cours</span>' : (a.vol ? '<span class="etiquette enligne">En vol</span>' : '<span class="etiquette">Au sol</span>')}
      <dl>
        <dt>Position</dt><dd>${depuis(now - a.ts)} <span class="sous">(${heure(a.ts)})</span></dd>
        ${a.alt !== null ? `<dt>Altitude</dt><dd>${nombre(a.alt)} m</dd>` : ''}
        ${a.kmh !== null ? `<dt>Vitesse</dt><dd>${a.kmh} km/h</dd>` : ''}
        ${vz ? `<dt>Vario</dt><dd>${vz}</dd>` : ''}
        <dt>Source</dt><dd>${source}</dd>
      </dl>
      ${a.sos ? '<div class="note"><strong>AeroTrack n\'appelle pas les secours.</strong> En cas de doute, appelez le 112 et donnez cette position.</div>' : ''}
      <div class="actions">
        <button type="button" class="principal" data-suivre="${esc(a.id)}">${suivi.id === a.id.toUpperCase() ? 'Ne plus suivre' : 'Suivre'}</button>
        <a href="https://www.google.com/maps?q=${a.lat},${a.lon}" target="_blank" rel="noopener">Itinéraire</a>
        <button type="button" data-copier="${a.lat.toFixed(5)}, ${a.lon.toFixed(5)}">Copier ${a.lat.toFixed(5)}, ${a.lon.toFixed(5)}</button>
      </div>
    </div>`;
  }

  function dessinerAvions(now) {
    calques.traces.clearLayers();
    const vus = new Set();
    for (const a of etat.donnees.aeronefs) {
      if (!a.sos && now - a.ts > 1800) continue;
      vus.add(a.id);
      const groupe = calques[groupeDe(a)];
      let m = etat.marqueursAvions.get(a.id);
      if (m && m._groupe !== groupe) { m._groupe.removeLayer(m); m = null; etat.marqueursAvions.delete(a.id); }
      if (!m) {
        m = L.marker([a.lat, a.lon], { pane: 'avions', icon: iconeAvion(a, now), zIndexOffset: a.sos ? 1000 : 0 });
        m.bindPopup('', { maxWidth: largeurFiche() });
        m._groupe = groupe;
        m.addTo(groupe);
        etat.marqueursAvions.set(a.id, m);
      } else {
        m.setLatLng([a.lat, a.lon]);
        m.setIcon(iconeAvion(a, now));
        m.setZIndexOffset(a.sos ? 1000 : 0);
      }
      m.setPopupContent(ficheAvion(a, now));
      const visible = carte.hasLayer(groupe);
      if (visible && a.trace && a.trace.length > 1) {
        L.polyline(a.trace.map((p) => [p[0], p[1]]), {
          pane: 'traces', color: a.sos ? COULEURS.sos : COULEURS[a.src] || COULEURS.O, weight: 2,
          opacity: a.src === 'O' ? 0.45 : 0.8, dashArray: a.src === 'O' ? '3 5' : null, interactive: false,
        }).addTo(calques.traces);
      }
    }
    for (const [id, m] of etat.marqueursAvions) {
      if (!vus.has(id)) { m._groupe.removeLayer(m); etat.marqueursAvions.delete(id); }
    }
  }

  // ── Suivre un aéronef : la carte reste centrée sur lui à chaque actualisation ──
  // ?suivre=FNTFC1C14 dans l'adresse (lien depuis l'application) ; glisser la carte met le suivi en pause.
  const suivi = { id: (new URLSearchParams(location.search).get('suivre') || '').toUpperCase() || null, pause: false };
  function suivre(id) {
    suivi.id = id; suivi.pause = false;
    appliquerSuivi(true);
  }
  function arreterSuivi() {
    suivi.id = null;
    appliquerSuivi(false);
  }
  function appliquerSuivi(zoomer) {
    const el = $('#suivi');
    if (!suivi.id || !etat.donnees) { el.hidden = true; return; }
    const now = etat.donnees.maj;
    const a = etat.donnees.aeronefs.find((x) => x.id.toUpperCase() === suivi.id);
    const boutons = `${suivi.pause && a ? '<button type="button" data-suivi="reprendre">Recentrer</button>' : ''}
      <button type="button" data-suivi="arreter" aria-label="Arrêter le suivi">Arrêter</button>`;
    el.hidden = false;
    el.classList.toggle('sos', !!a?.sos);
    if (!a) {
      el.innerHTML = `<span class="voyant perdu"></span><div class="detail"><strong>Suivi en attente</strong>
        <span>Aucune position récente de ${esc(suivi.id)}</span></div>${boutons}`;
      return;
    }
    const infos = [a.alt !== null ? `${nombre(a.alt)} m` : null, a.kmh !== null ? `${a.kmh} km/h` : null,
      `position ${depuis(now - a.ts)}`].filter(Boolean).join(' · ');
    el.innerHTML = `<span class="voyant${now - a.ts > AVION_VIEUX_S ? ' perdu' : ''}"></span>
      <div class="detail"><strong>${a.sos ? 'SOS · ' : ''}Suivi : ${esc(CATEGORIES[a.cat] || 'Aéronef')} ${esc(nomEtId(a))}</strong>
      <span>${infos}${suivi.pause ? ' · en pause' : ''}</span></div>${boutons}`;
    if (suivi.pause) return;
    const ll = [a.lat, a.lon];
    if (zoomer) carte.setView(ll, Math.max(carte.getZoom(), 13));
    else carte.panTo(ll);
  }

  // ── Liste des appareils (panneau) : ceux des calques cochés ──
  function dessinerListeAvions(now) {
    const ul = $('#liste-avions');
    // SOS d'abord, puis trackers AeroTrack, vol libre, autres aéronefs ; dans chaque groupe, en vol d'abord
    const ORDRE = { aerotrack: 0, fanet: 1, autres: 2 };
    const rang = (a) => (a.sos ? 0 : 1 + ORDRE[groupeDe(a)] * 2 + (a.vol ? 0 : 1));
    const liste = etat.donnees.aeronefs
      .filter((a) => (a.sos || now - a.ts <= 1800) && avionVisible(a))
      .sort((a, b) => rang(a) - rang(b) || nomCourt(a).localeCompare(nomCourt(b), 'fr', { numeric: true }));
    $('#n-liste').textContent = liste.length ? `(${liste.length})` : '';
    if (!liste.length) {
      const coche = ['aerotrack', 'fanet', 'autres'].some((k) => carte.hasLayer(calques[k]));
      ul.innerHTML = `<li class="vide">${coche ? 'Aucun appareil en ce moment autour des bases.' : 'Cochez un type d\'aéronef dans « Afficher ».'}</li>`;
      return;
    }
    ul.innerHTML = liste.map((a) => {
      const vieux = now - a.ts > AVION_VIEUX_S;
      const detail = [a.nom ? idCourt(a) : null, a.alt !== null ? `${nombre(a.alt)} m` : null, depuis(now - a.ts)]
        .filter(Boolean).join(' · ');
      const badge = a.sos ? '<span class="badge sos">SOS</span>' : (a.vol ? '<span class="badge">en vol</span>' : '');
      return `<li><button type="button" data-avion="${esc(a.id)}"${vieux ? ' class="vieux"' : ''}>
        <span class="pt ${a.sos ? 'sos' : estAeroTrack(a) ? 'A' : esc(a.src)}"></span>
        <span><span class="nom">${esc(CATEGORIES[a.cat] || 'Aéronef')} ${esc(nomCourt(a))}</span><span class="detail">${esc(detail)}</span></span>
        ${badge}</button></li>`;
    }).join('');
  }

  // Bilan du panneau : aéronefs des calques cochés
  function compterAvions(now) {
    $('#n-aeronefs').textContent = etat.donnees.aeronefs.filter((a) => (a.sos || now - a.ts < 1800) && avionVisible(a)).length;
  }
  // Légendes de la couverture et des sites : seulement quand leur calque est affiché
  function legendes() {
    $('#legende-couverture').hidden = !carte.hasLayer(calques.couverture);
    $('#legende-couverture-mobile').hidden = !carte.hasLayer(calques.couvmobile);
    const sites = carte.hasLayer(calques.sites);
    $('#legende-sites').hidden = !sites;
    $('#aide-zoom').hidden = carte.getZoom() >= ZOOM_DETAILS || !(sites || carte.hasLayer(calques.balises));
  }

  function montrerAvion(id) {
    const m = etat.marqueursAvions.get(id);
    if (!m) return;
    fermerPanneau();
    carte.flyTo(m.getLatLng(), Math.max(carte.getZoom(), 13), { duration: 0.8 });
    carte.once('moveend', () => m.openPopup());
  }

  // Bandeaux SOS : chacun peut être réduit en une pastille (place sur un téléphone) ; un NOUVEAU SOS
  // s'affiche toujours en grand. La pastille rouvre tous les bandeaux réduits.
  const sosReduits = new Set();
  function dessinerAlertes(now) {
    const sos = etat.donnees.aeronefs.filter((a) => a.sos).sort((a, b) => b.ts - a.ts);
    for (const id of sosReduits) if (!sos.some((a) => a.id === id)) sosReduits.delete(id);
    const reduits = sos.filter((a) => sosReduits.has(a.id));
    $('#alertes').innerHTML = sos.filter((a) => !sosReduits.has(a.id)).map((a) => `<div class="alerte">
        <strong>SOS</strong>
        <div class="detail">${esc(CATEGORIES[a.cat] || 'Aéronef')} ${esc(nomEtId(a))}${a.alt !== null ? ` · ${nombre(a.alt)} m` : ''}
          <span>Dernière position ${depuis(now - a.ts)}${a.base ? ` · reçue par ${esc(nomParId(a.base))}` : ''}</span></div>
        <button type="button" data-sos="${esc(a.id)}">Voir</button>
        <button type="button" class="reduire" data-sos-reduire="${esc(a.id)}" aria-label="Réduire l'alerte" title="Réduire">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg></button></div>`).join('')
      + (reduits.length ? `<button type="button" class="alerte-mini" data-sos-ouvrir title="Afficher les alertes">
        <span class="voyant"></span>SOS · ${reduits.map((a) => esc(nomCourt(a))).join(', ')}</button>` : '');
    document.title = sos.length ? `SOS (${sos.length}) · Carte des bases AeroTrack` : 'Carte des bases AeroTrack';
  }

  // ── Couverture ───────────────────────────────────
  const PALIERS = [[-120, [232, 85, 61]], [-110, [242, 153, 74]], [-100, [255, 210, 122]], [-90, [182, 228, 60]]];
  // Bases mobiles : même échelle de signal, autres couleurs (temporaire, à ne pas confondre)
  const PALIERS_MOBILE = [[-120, [107, 79, 179]], [-110, [126, 111, 217]], [-100, [95, 163, 232]], [-90, [111, 214, 224]]];
  function rgbSignal(rssi, paliers = PALIERS) {
    if (rssi <= paliers[0][0]) return paliers[0][1];
    for (let i = 1; i < paliers.length; i++) {
      const [r1, c1] = paliers[i - 1], [r2, c2] = paliers[i];
      if (rssi <= r2) {
        const t = (rssi - r1) / (r2 - r1);
        return c1.map((v, k) => Math.round(v + (c2[k] - v) * t));
      }
    }
    return paliers[paliers.length - 1][1];
  }
  const couleurSignal = (rssi) => `rgb(${rgbSignal(rssi).join(',')})`;

  // Couverture « diffuse » : chaque case est peinte en halo (dégradé radial) sur un canvas, les
  // meilleurs signaux par-dessus, puis le tout posé en transparence : les cases voisines se fondent
  // en une tache continue, sans contour carré. Pas de filtre CSS (absent de Safari) : que des dégradés.
  const CoucheCouverture = L.Layer.extend({
    initialize(paliers = PALIERS) { this._cases = []; this._index = new Map(); this._deg = 0.005; this._paliers = paliers; },
    setCases(cases, deg) {
      this._deg = deg;
      this._cases = [...cases].sort((a, b) => a.rssi - b.rssi);     // les meilleurs dessinés en dernier
      this._index = new Map(cases.map((c) => [`${c.la},${c.lo}`, c]));
      this._dessiner();
    },
    onAdd(map) {
      this._carte = map;
      this._canvas = L.DomUtil.create('canvas', 'couverture-floue');
      map.getPane('couverture').appendChild(this._canvas);
      map.on('moveend resize', this._dessiner, this);
      map.on('zoomstart', this._cacher, this);
      map.on('mousemove', this._survol, this);
      map.on('mouseout', this._finSurvol, this);
      this._dessiner();
    },
    onRemove(map) {
      this._canvas.remove();
      map.off('moveend resize', this._dessiner, this);
      map.off('zoomstart', this._cacher, this);
      map.off('mousemove', this._survol, this);
      map.off('mouseout', this._finSurvol, this);
      this._finSurvol();
      this._carte = null;
    },
    _cacher() { if (this._canvas) this._canvas.style.visibility = 'hidden'; },
    _dessiner() {
      const map = this._carte;
      if (!map) return;
      const t = map.getSize(), dpr = window.devicePixelRatio || 1, c = this._canvas;
      c.width = Math.round(t.x * dpr); c.height = Math.round(t.y * dpr);
      c.style.width = `${t.x}px`; c.style.height = `${t.y}px`;
      L.DomUtil.setPosition(c, map.containerPointToLayerPoint([0, 0]));
      c.style.visibility = '';
      const ctx = c.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, t.x, t.y);
      if (!this._cases.length) return;

      // Calque intermédiaire opaque, posé ensuite à 60 % : les recouvrements ne s'assombrissent pas
      const off = this._tampon || (this._tampon = document.createElement('canvas'));
      off.width = c.width; off.height = c.height;
      const o = off.getContext('2d');
      o.setTransform(dpr, 0, 0, dpr, 0, 0);
      const deg = this._deg, vue = map.getBounds().pad(0.15);
      const p0 = map.latLngToContainerPoint(vue.getCenter());
      const p1 = map.latLngToContainerPoint([vue.getCenter().lat + deg, vue.getCenter().lng + deg]);
      const cote = Math.max(Math.abs(p1.x - p0.x), Math.abs(p1.y - p0.y));   // côté d'une case, en pixels
      const r = Math.max(7, cote * 1.05);                                     // halo : déborde sur les voisines
      for (const k of this._cases) {
        const lat = (k.la + 0.5) * deg, lon = (k.lo + 0.5) * deg;
        if (!vue.contains([lat, lon])) continue;
        const p = map.latLngToContainerPoint([lat, lon]);
        const [cr, cg, cb] = rgbSignal(k.rssi, this._paliers);
        const g = o.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
        g.addColorStop(0, `rgba(${cr},${cg},${cb},1)`);
        g.addColorStop(0.45, `rgba(${cr},${cg},${cb},0.92)`);
        g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
        o.fillStyle = g;
        o.fillRect(p.x - r, p.y - r, 2 * r, 2 * r);
      }
      ctx.globalAlpha = 0.72;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(off, 0, 0);
      ctx.globalAlpha = 1;
    },
    // Survol : la case sous la souris donne son meilleur signal et le nombre de positions
    _survol(e) {
      const k = this._index.get(`${Math.floor(e.latlng.lat / this._deg)},${Math.floor(e.latlng.lng / this._deg)}`);
      if (!k) { this._finSurvol(); return; }
      const sources = [...k.src].map((s) => (s === 'A' ? 'AeroTrack' : 'FANET')).join(' et ');
      const texte = `${this._paliers === PALIERS_MOBILE ? '<b>Base mobile (temporaire)</b><br>' : ''}Meilleur signal ${k.rssi} dBm · ${nombre(k.n)} position${k.n > 1 ? 's' : ''} ${sources}<br>${esc([...k.bases].map(nomParId).join(', '))}`;
      if (!this._bulle) this._bulle = L.tooltip({ direction: 'top', offset: [0, -8], opacity: 0.95 });
      this._bulle.setLatLng(e.latlng).setContent(texte);
      if (!this._carte.hasLayer(this._bulle)) this._bulle.addTo(this._carte);
    },
    _finSurvol() { if (this._bulle && this._carte) this._carte.removeLayer(this._bulle); },
  });
  const coucheCouverture = new CoucheCouverture().addTo(calques.couverture);
  const coucheCouvMobile = new CoucheCouverture(PALIERS_MOBILE).addTo(calques.couvmobile);

  function dessinerCouverture() {
    if (!etat.couverture) return;
    const { deg, cases } = etat.couverture;
    const fixes = new Map(), mobiles = new Map();          // une case par calque : fixe ou mobile
    for (const [base, la, lo, src, rssi, n, , mobile] of cases) {
      if (etat.filtreBase && base !== etat.filtreBase) continue;
      const fusion = mobile ? mobiles : fixes;
      const k = `${la},${lo}`;
      const c = fusion.get(k);
      if (!c) fusion.set(k, { la, lo, rssi, n, src: new Set([src]), bases: new Set([base]) });
      else { c.rssi = Math.max(c.rssi, rssi); c.n += n; c.src.add(src); c.bases.add(base); }
    }
    coucheCouverture.setCases([...fixes.values()], deg);
    coucheCouvMobile.setCases([...mobiles.values()], deg);
  }

  async function chargerCouverture() {
    try {
      etat.couverture = await lire(API + 'couverture.php');
      dessinerCouverture();
    } catch (e) { /* nouvel essai au prochain tour */ }
  }

  // ── Sites de vol et balises de la FFVL ───────────
  const FONCTIONS = { D: 'Décollage', A: 'Atterrissage', T: 'Treuil', P: 'Pente-école' };
  const STATUTS = { ok: 'Praticable', autorisation: 'Autorisation systématique requise', interdit: 'Interdit', temporaire: 'Fermé temporairement' };

  function dansLaVue(lat, lon, bornes) { return bornes.contains([lat, lon]); }

  // Rose des orientations : 8 secteurs de 45° centrés sur N, NE… NO ; vert anis = favorable
  const DIRECTIONS = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
  const orientations = (texte) => new Set(String(texte || '').toUpperCase().split(/[^A-Z]+/).filter((d) => DIRECTIONS.includes(d)));
  function secteurs(favorables, cx, r1, r2, autre) {
    const pt = (r, a) => `${(cx + r * Math.cos(a)).toFixed(2)} ${(cx + r * Math.sin(a)).toFixed(2)}`;
    return DIRECTIONS.map((d, i) => {
      const a0 = ((i * 45 - 22.5 - 90) * Math.PI) / 180, a1 = a0 + Math.PI / 4;
      const ok = favorables.has(d);
      return `<path d="M${pt(r2, a0)} A${r2} ${r2} 0 0 1 ${pt(r2, a1)} L${pt(r1, a1)} A${r1} ${r1} 0 0 0 ${pt(r1, a0)} Z"
        fill="${ok ? '#B6E43C' : autre}" stroke="#0B1834" stroke-width="0.9"/>`;
    }).join('');
  }
  // Voile vue de face, comme sur l'icône de l'application
  const VOILE = (cx, cy, e) => `<path d="M${cx - 5.6 * e} ${cy - 0.6 * e} Q${cx} ${cy - 6 * e} ${cx + 5.6 * e} ${cy - 0.6 * e}" fill="none" stroke="#fff" stroke-width="${2 * e}" stroke-linecap="round"/>
    <path d="M${cx - 4.6 * e} ${cy - 0.4 * e} L${cx} ${cy + 4.6 * e} L${cx + 4.6 * e} ${cy - 0.4 * e}" fill="none" stroke="#fff" stroke-width="${0.8 * e}"/>
    <circle cx="${cx}" cy="${cy + 5.2 * e}" r="${1.3 * e}" fill="#fff"/>`;
  const BARRE = '<line x1="6" y1="28" x2="28" y2="6" stroke="#FF5A4E" stroke-width="3" stroke-linecap="round"/>';
  const ALERTE = '<circle cx="28.5" cy="6" r="5" fill="#FFD27A" stroke="#0B1834" stroke-width="1.2"/><path d="M28.5 3.4v3.4M28.5 8.7v.2" stroke="#0B1834" stroke-width="1.6" stroke-linecap="round"/>';

  // Décollage : disque nuit avec la voile, couronne des orientations ; atterrissage : cible
  function svgSite(fn, orient, statut) {
    const deco = fn.includes('D'), atterro = fn.includes('A');
    const marque = statut === 'interdit' ? BARRE : (statut === 'ok' ? '' : ALERTE);
    let corps;
    if (deco) {
      corps = secteurs(orientations(orient), 17, 10, 16, 'rgba(11,24,52,.62)')
        + '<circle cx="17" cy="17" r="10" fill="#0B1834" stroke="#fff" stroke-width="1.3"/>' + VOILE(17, 17, 1)
        + (atterro ? '<circle cx="27.5" cy="27.5" r="4.6" fill="#F2B25C" stroke="#0B1834" stroke-width="1.2"/><circle cx="27.5" cy="27.5" r="1.5" fill="#0B1834"/>' : '');
    } else if (atterro) {
      corps = '<circle cx="17" cy="17" r="10.5" fill="#F2B25C" stroke="#0B1834" stroke-width="1.6"/>'
        + '<circle cx="17" cy="17" r="6" fill="none" stroke="#0B1834" stroke-width="1.8"/><circle cx="17" cy="17" r="2.1" fill="#0B1834"/>';
    } else {
      corps = `<rect x="7" y="7" width="20" height="20" rx="6" fill="#C9B6F2" stroke="#0B1834" stroke-width="1.5"/>
        <text x="17" y="21.5" text-anchor="middle" font-size="12" font-weight="700" fill="#0B1834" font-family="Segoe UI, Roboto, sans-serif">${fn.includes('T') ? 'T' : 'P'}</text>`;
    }
    return `<svg viewBox="0 0 34 34" width="34" height="34" aria-hidden="true"${statut === 'interdit' ? ' opacity="0.75"' : ''}>${corps}${marque}</svg>`;
  }

  // Grande rose pour la fiche du site
  const svgRose = (orient) => `<svg viewBox="-8 -8 96 96" width="96" height="96" aria-hidden="true">
    ${secteurs(orientations(orient), 40, 13, 34, '#14306A')}<circle cx="40" cy="40" r="13" fill="#0B1834" stroke="#fff" stroke-width="1.2"/>${VOILE(40, 40, 1.35)}
    ${DIRECTIONS.filter((d, i) => i % 2 === 0).map((d, i) => {
      const a = ((i * 90 - 90) * Math.PI) / 180;
      return `<text x="${(40 + 39 * Math.cos(a)).toFixed(1)}" y="${(40 + 39 * Math.sin(a) + 3.5).toFixed(1)}" text-anchor="middle" font-size="9" font-weight="700" fill="#BFD3EE">${d}</text>`;
    }).join('')}</svg>`;

  // Met à jour un calque de marqueurs sans tout effacer : seuls ceux qui sortent de la vue (ou
  // changent d'apparence) sont remplacés. Une fiche ouverte reste ouverte quand la carte se décale.
  function synchroniser(groupe, cache, voulus) {
    for (const [cle, m] of cache) {
      if (!voulus.has(cle)) { groupe.removeLayer(m); cache.delete(cle); }
    }
    for (const [cle, v] of voulus) {
      const m = cache.get(cle);
      if (m && m._variante === v.variante) continue;
      if (m) groupe.removeLayer(m);
      const n = v.creer();
      n._variante = v.variante;
      n.addTo(groupe);
      cache.set(cle, n);
    }
  }
  const marqueursSites = new Map(), marqueursBalises = new Map();

  function marqueurSite(s, z) {
    const [suid, nom, fn, lat, lon, alt, orient, statut, pratiques] = s;
    // Vue large : petits points (les Alpes comptent des centaines de sites) ; de près : rose et nom
    const type = fn.includes('D') ? 'D' : fn.includes('A') ? 'A' : 'T';
    const icone = z < ZOOM_ICONES
      ? L.divIcon({ className: '', iconSize: [12, 12], iconAnchor: [6, 6], popupAnchor: [0, -6],
          html: `<div class="m-site-point ${type}${statut === 'interdit' ? ' interdit' : ''}"></div>` })
      : L.divIcon({ className: '', iconSize: [34, 34], iconAnchor: [17, 17], popupAnchor: [0, -14],
          html: `<div class="m-site">${svgSite(fn, orient, statut)}${z >= ZOOM_NOMS ? `<span class="nom">${esc(nom)}</span>` : ''}</div>` });
    const fonctions = [...fn].map((c) => FONCTIONS[c]).filter(Boolean).join(', ');
    const favorables = [...orientations(orient)];
    return L.marker([lat, lon], { icon: icone, pane: 'details', title: nom, riseOnHover: true }).bindPopup(`<div class="fiche">
      <h3>${esc(nom)}</h3><div class="sous">${esc(fonctions)} · site FFVL n° ${suid}</div>
      <span class="etiquette ${statut === 'ok' ? 'enligne' : statut === 'interdit' ? 'sos' : 'attention'}">${esc(STATUTS[statut] || statut)}</span>
      <div class="fiche-site">
        ${fn.includes('D') ? `<div class="rose">${svgRose(orient)}</div>` : ''}
        <dl>${alt !== null ? `<dt>Altitude</dt><dd>${nombre(alt)} m</dd>` : ''}
        ${fn.includes('D') ? `<dt>Vents</dt><dd>${favorables.length ? esc(favorables.join(', ')) : 'non renseignés'}</dd>` : ''}
        <dt>Pratiques</dt><dd>${esc(pratiques)}</dd></dl>
      </div>
      <div class="actions"><a href="https://www.google.com/maps?q=${lat},${lon}" target="_blank" rel="noopener">Itinéraire</a></div>
      <div class="note">Données FFVL. Vérifiez toujours les consignes locales du site.</div></div>`, { maxWidth: largeurFiche() });
  }

  function marqueurBalise(b, now) {
    const [id, nom, lat, lon, alt, ts, moy, max, dir, temp] = b;
    const vieux = !ts || now - ts > 3 * 3600;
    const couleur = vieux || moy === null ? '#8A9AB5' : moy < 15 ? '#B6E43C' : moy < 25 ? '#FFD27A' : '#FF5A4E';
    const fleche = dir === null || vieux ? `<circle cx="15" cy="15" r="6" fill="${couleur}" stroke="#0B1834" stroke-width="2"/>`
      : `<g transform="rotate(${dir + 180} 15 15)"><path d="M15 3 L21 16 L16.5 14.5 L16.5 27 L13.5 27 L13.5 14.5 L9 16 Z" fill="${couleur}" stroke="#0B1834" stroke-width="1.2" stroke-linejoin="round"/></g>`;
    const icone = L.divIcon({ className: '', iconSize: [30, 42], iconAnchor: [15, 15],
      html: `<div class="m-balise"><svg viewBox="0 0 30 30" aria-hidden="true">${fleche}</svg><span class="v">${vieux || moy === null ? '' : moy}</span></div>` });
    return L.marker([lat, lon], { icon: icone, pane: 'details', title: nom }).bindPopup(`<div class="fiche">
      <h3>${esc(nom)}</h3><div class="sous">Balise FFVL${alt !== null ? ` · ${nombre(alt)} m` : ''}</div>
      <dl>${moy !== null ? `<dt>Vent moyen</dt><dd>${moy} km/h${dir !== null ? ` du ${cardinal(dir)} (${dir}°)` : ''}</dd>` : ''}
      ${max !== null ? `<dt>Rafales</dt><dd>${max} km/h</dd>` : ''}
      ${temp !== null ? `<dt>Température</dt><dd>${temp} °C</dd>` : ''}
      <dt>Relevé</dt><dd>${ts ? `${heure(ts)} (${depuis(now - ts)})` : '—'}</dd></dl>
      <div class="actions"><a href="https://www.balisemeteo.com/balise.php?idBalise=${id}" target="_blank" rel="noopener">Relevés en direct</a></div>
      <div class="note">Les relevés publiés en données ouvertes peuvent avoir jusqu'à une heure de retard.</div></div>`, { maxWidth: largeurFiche() });
  }

  async function dessinerDetails() {
    const z = carte.getZoom();
    const zoomOk = z >= ZOOM_DETAILS;
    $('#aide-zoom').hidden = zoomOk || !(carte.hasLayer(calques.sites) || carte.hasLayer(calques.balises));
    const bornes = carte.getBounds().pad(0.1);
    const sites = new Map(), balises = new Map();

    if (zoomOk && carte.hasLayer(calques.sites)) {
      if (!etat.sites) { try { etat.sites = await lire(API + 'sites.php?quoi=sites'); } catch (e) { etat.sites = null; } }
      const variante = z < ZOOM_ICONES ? 'point' : z < ZOOM_NOMS ? 'icone' : 'nom';
      for (const s of etat.sites || []) {
        if (!dansLaVue(s[3], s[4], bornes)) continue;
        if (sites.size >= MAX_DETAILS) break;
        sites.set(s[0], { variante, creer: () => marqueurSite(s, z) });
      }
    }
    if (zoomOk && carte.hasLayer(calques.balises)) {
      if (!etat.balises || Date.now() - etat.balisesLues > BALISES_MS) {
        try { etat.balises = await lire(API + 'sites.php?quoi=balises'); etat.balisesLues = Date.now(); } catch (e) { /* garde l'ancien */ }
      }
      const now = Date.now() / 1000;
      for (const b of etat.balises || []) {
        if (!dansLaVue(b[2], b[3], bornes)) continue;
        if (balises.size >= MAX_DETAILS) break;
        balises.set(b[0], { variante: `${b[5]}-${b[6]}`, creer: () => marqueurBalise(b, now) });
      }
    }
    synchroniser(calques.sites, marqueursSites, sites);
    synchroniser(calques.balises, marqueursBalises, balises);
  }

  // ── Chargement ───────────────────────────────────
  async function charger() {
    try {
      etat.donnees = await lire(API + 'donnees.php');
      etat.erreur = false;
    } catch (e) {
      etat.erreur = true;
      $('#maj').textContent = 'Serveur injoignable, nouvel essai dans 15 s';
      return;
    }
    const now = etat.donnees.maj;
    dessinerBases(now);
    dessinerListe(now);
    dessinerLiens();
    dessinerAvions(now);
    dessinerChemins(now);
    dessinerAlertes(now);
    dessinerListeAvions(now);
    const bases = etat.donnees.bases;
    $('#n-bases').textContent = bases.length;
    $('#n-enligne').textContent = bases.filter((b) => etatBase(b, now).cls === 'enligne').length;
    compterAvions(now);
    $('#maj').textContent = `actualisé à ${new Date().toLocaleTimeString('fr-FR')}`;

    const premier = !etat.cadree;
    if (!etat.cadree) {
      etat.cadree = true;
      const voulue = new URLSearchParams(location.search).get('base');
      if (suivi.id && etat.donnees.aeronefs.some((x) => x.id.toUpperCase() === suivi.id)) {
        /* appareil suivi : appliquerSuivi() centre la carte dessus */
      } else if (vueDemandee) {
        /* vue donnée par l'adresse (#zoom/lat/lon) : on n'y touche pas */
      } else if (voulue && baseParId(voulue.toUpperCase())) {
        montrerBase(voulue.toUpperCase());
      } else if (bases.length) {
        carte.fitBounds(L.latLngBounds(bases.map((b) => [b.lat, b.lon])).pad(0.3), { maxZoom: 11 });
      }
    }
    appliquerSuivi(premier);
  }

  // ── Interface ────────────────────────────────────
  const panneau = $('#panneau'), bouton = $('#ouvrir-panneau');
  function fermerPanneau() { panneau.classList.remove('ouvert'); bouton.setAttribute('aria-expanded', 'false'); }
  bouton.addEventListener('click', () => {
    const ouvert = panneau.classList.toggle('ouvert');
    bouton.setAttribute('aria-expanded', String(ouvert));
  });
  carte.on('click', fermerPanneau);

  $('#liste-bases').addEventListener('click', (e) => {
    const b = e.target.closest('[data-base]');
    if (b) montrerBase(b.dataset.base);
  });
  $('#alertes').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sos], [data-sos-reduire], [data-sos-ouvrir]');
    if (!b) return;
    if (b.dataset.sos) montrerAvion(b.dataset.sos);
    else if (b.dataset.sosReduire) sosReduits.add(b.dataset.sosReduire);
    else sosReduits.clear();
    if (!b.dataset.sos && etat.donnees) dessinerAlertes(etat.donnees.maj);
  });
  $('#liste-avions').addEventListener('click', (e) => {
    const b = e.target.closest('[data-avion]');
    if (b) montrerAvion(b.dataset.avion);
  });
  // Boutons des fiches : écoutés sur la carte entière, car le contenu d'une fiche ouverte est
  // remplacé à chaque actualisation (15 s) et perdrait des écouteurs posés à l'ouverture.
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.leaflet-popup [data-couv], .leaflet-popup [data-suivre], .leaflet-popup [data-copier]');
    if (!btn) return;
    if (btn.dataset.couv !== undefined) {
      etat.filtreBase = btn.dataset.couv || null;
      const nom = baseParId(etat.filtreBase)?.mobile ? 'couvmobile' : 'couverture';
      if (!carte.hasLayer(calques[nom])) { calques[nom].addTo(carte); document.querySelector(`[data-calque="${nom}"]`).checked = true; legendes(); }
      dessinerCouverture();
    } else if (btn.dataset.suivre !== undefined) {
      const id = btn.dataset.suivre.toUpperCase();
      if (suivi.id === id) { arreterSuivi(); btn.textContent = 'Suivre'; }
      else { suivre(id); btn.textContent = 'Ne plus suivre'; }
    } else {
      try { await navigator.clipboard.writeText(btn.dataset.copier); btn.textContent = 'Copié'; } catch (err) { /* sans presse-papiers */ }
    }
  });

  document.querySelectorAll('[data-calque]').forEach((c) => c.addEventListener('change', () => {
    const g = calques[c.dataset.calque];
    if (c.checked) g.addTo(carte); else carte.removeLayer(g);
    const k = c.dataset.calque, avions = ['aerotrack', 'fanet', 'autres'].includes(k);
    if (k === 'sites' || k === 'balises') dessinerDetails();
    legendes();
    if (!etat.donnees) return;
    const now = etat.donnees.maj;
    if (k === 'traces' || avions) dessinerAvions(now);
    if (k === 'chemins' || avions) dessinerChemins(now);
    if (avions) { dessinerListeAvions(now); compterAvions(now); }
  }));
  carte.on('moveend', dessinerDetails);
  carte.on('dragstart', () => { if (suivi.id && !suivi.pause) { suivi.pause = true; appliquerSuivi(false); } });
  $('#suivi').addEventListener('click', (e) => {
    const b = e.target.closest('[data-suivi]');
    if (!b) return;
    if (b.dataset.suivi === 'arreter') arreterSuivi();
    else { suivi.pause = false; appliquerSuivi(false); }
  });

  // Dans l'application AeroTrack (?app=1) : le logo devient « Retour » vers l'application
  if (new URLSearchParams(location.search).has('app')) {
    document.body.classList.add('app');
    const marque = document.querySelector('.marque');
    marque.setAttribute('aria-label', 'Retour à l\'application');
    marque.insertAdjacentHTML('afterbegin', '<svg class="retour" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>');
    marque.addEventListener('click', (e) => {
      if (window.AeroTrackApp) { e.preventDefault(); window.AeroTrackApp.postMessage('fermer'); }
    });
  }

  // Adresse partageable : #zoom/lat/lon suit la vue (sans recharger ni encombrer l'historique)
  const vueDemandee = /^#(\d{1,2})\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)$/.exec(location.hash);
  if (vueDemandee) carte.setView([+vueDemandee[2], +vueDemandee[3]], +vueDemandee[1]);
  carte.on('moveend', () => {
    const c = carte.getCenter();
    history.replaceState(null, '', `${location.pathname}${location.search}#${carte.getZoom()}/${c.lat.toFixed(4)}/${c.lng.toFixed(4)}`);
  });

  // Message bref en bas de la carte (« Ma position »…)
  let minuterieMessage = 0;
  function message(texte, ms = 4000) {
    let el = $('#message');
    if (!el) {
      el = document.createElement('div');
      el.id = 'message'; el.className = 'message'; el.setAttribute('role', 'status');
      $('.cadre').appendChild(el);
    }
    el.textContent = texte; el.hidden = !texte;
    clearTimeout(minuterieMessage);
    if (texte && ms) minuterieMessage = setTimeout(() => { el.hidden = true; }, ms);
  }

  let moi = null;
  $('#ma-position').addEventListener('click', () => {
    if (!navigator.geolocation) { message('Localisation indisponible sur cet appareil'); return; }
    message('Recherche de votre position…', 0);
    const placer = (p) => {
      message('');
      const ll = [p.coords.latitude, p.coords.longitude];
      if (moi) moi.setLatLng(ll);
      else moi = L.circleMarker(ll, { radius: 7, color: '#fff', weight: 2, fillColor: '#4C8DFF', fillOpacity: 1, pane: 'avions' }).addTo(carte);
      carte.flyTo(ll, Math.max(carte.getZoom(), 11));
    };
    const echec = (e) => message(e.code === 1 ? 'Localisation refusée : autorisez-la pour ce site ou cette application'
      : 'Position introuvable pour le moment (GPS, localisation du téléphone activée ?)', 6000);
    // GPS d'abord ; sans réponse en 10 s (à l'intérieur), la position approximative du téléphone
    navigator.geolocation.getCurrentPosition(placer, (e) => {
      if (e.code === 1) return echec(e);
      navigator.geolocation.getCurrentPosition(placer, echec, { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
    }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
  });

  $('#legende-sites').innerHTML = [
    [svgSite('D', 'S;SO;O', 'ok'), 'Décollage : les secteurs verts sont les vents favorables'],
    [svgSite('A', '', 'ok'), 'Atterrissage'],
    [svgSite('D', 'N;NE', 'autorisation'), 'Autorisation requise ou fermé un temps'],
    [svgSite('A', '', 'interdit'), 'Interdit'],
  ].map(([svg, texte]) => `<li>${svg}<span>${texte}</span></li>`).join('');

  charger();
  chargerCouverture();
  setInterval(() => { if (!document.hidden) charger(); }, RAFRAICHIR_MS);
  setInterval(() => { if (!document.hidden) chargerCouverture(); }, COUVERTURE_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) charger(); });
})();
