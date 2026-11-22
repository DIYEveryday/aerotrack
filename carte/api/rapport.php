<?php
// AeroTrack — carte des bases : rapport d'une base (POST JSON, firmware base/carte.cpp).
// En-têtes : X-AeroTrack-Base (identifiant, 8 hexa), X-AeroTrack-Token (clé tirée par la base).
// Inscription à la 1re connexion ; la clé est ensuite exigée. Une base réinstallée (mémoire
// effacée, nouvelle clé) peut reprendre sa place après 1 h de silence.
declare(strict_types=1);
require __DIR__ . '/_commun.php';

const CORPS_MAX     = 32768;
const RAPPORT_MIN_S = 5;       // une base envoie au plus toutes les 60 s (15 s en SOS)
const REPRISE_S     = 3600;    // nouvelle clé acceptée après 1 h sans nouvelles

if ($_SERVER['REQUEST_METHOD'] !== 'POST') erreur(405, 'POST attendu');
$id  = strtoupper($_SERVER['HTTP_X_AEROTRACK_BASE'] ?? '');
$cle = strtolower($_SERVER['HTTP_X_AEROTRACK_TOKEN'] ?? '');
if (!preg_match('/^[0-9A-F]{8}$/', $id) || !preg_match('/^[0-9a-f]{32}$/', $cle)) erreur(400, 'identifiant ou clé invalide');
$brut = file_get_contents('php://input', false, null, 0, CORPS_MAX + 1);
if ($brut === false || strlen($brut) > CORPS_MAX) erreur(413, 'rapport trop gros');
$r = json_decode($brut, true);
if (!is_array($r) || ($r['v'] ?? 0) !== 1 || ($r['id'] ?? '') !== $id) erreur(400, 'rapport illisible');

$now = time();
$db = db();
$hache = hash('sha256', $cle);
$q = $db->prepare('SELECT cle, dernier FROM bases WHERE id = ?');
$q->execute([$id]);
$connue = $q->fetch();
if ($connue) {
    if (!hash_equals($connue['cle'], $hache)) {
        if ($now - (int)$connue['dernier'] < REPRISE_S) erreur(403, 'cette base est inscrite avec une autre clé');
        $db->prepare('UPDATE bases SET cle = ? WHERE id = ?')->execute([$hache, $id]);
    } elseif ($now - (int)$connue['dernier'] < RAPPORT_MIN_S) {
        erreur(429, 'trop de rapports');
    }
}

// ── Valeurs contrôlées ──────────────────────────────────────
function nombre($v, float $min, float $max): ?float {
    return (is_int($v) || is_float($v)) && $v >= $min && $v <= $max ? (float)$v : null;
}
function entier($v, int $min, int $max, ?int $defaut = null): ?int {
    return is_int($v) && $v >= $min && $v <= $max ? $v : $defaut;
}
function hexa($v, int $n): string {
    return is_string($v) && preg_match('/^[0-9A-F]{' . $n . '}$/', $v) ? $v : '';
}
// Nom de pilote saisi sur le tracker (FANET type 2) : UTF-8 valide, sans contrôles ni balises
function nom_pilote(string $v): string {
    if (!mb_check_encoding($v, 'UTF-8')) return '';
    return mb_substr(trim(preg_replace('/[\x00-\x1F\x7F<>]/u', '', $v) ?? ''), 0, 24);
}

$nom = is_string($r['nom'] ?? null) ? trim(preg_replace('/[\x00-\x1F<>]/u', '', $r['nom'])) : '';
$nom = mb_substr($nom, 0, 40);
$lat = nombre($r['lat'] ?? null, -90, 90);
$lon = nombre($r['lon'] ?? null, -180, 180);
if ($lat === null || $lon === null || ($lat == 0 && $lon == 0)) { $lat = $lon = null; }
$base = [
    'nom' => $nom, 'lat' => $lat, 'lon' => $lon,
    'alt' => entier($r['alt'] ?? null, -500, 9000),
    'flou' => ($r['flou'] ?? 0) ? 1 : 0,
    'mobile' => ($r['mobile'] ?? 0) ? 1 : 0,   // emportée de site en site : sa couverture est temporaire
    'fw' => is_string($r['fw'] ?? null) && preg_match('/^[0-9.]{1,12}$/', $r['fw']) ? $r['fw'] : '',
    'hw' => is_string($r['hw'] ?? null) && preg_match('/^[a-z0-9_]{1,32}$/', $r['hw']) ? $r['hw'] : '',
    'lien' => in_array($r['lien'] ?? '', ['WiFi', '4G', '--'], true) ? $r['lien'] : '--',
    'enligne' => ($r['enligne'] ?? 0) ? 1 : 0,
    'amont' => hexa($r['amont'] ?? null, 8),
    'bat' => entier($r['bat'] ?? null, -1, 100, -1),
    'trk' => entier($r['trk'] ?? null, 0, 255, 0),
    'rx' => entier($r['rx'] ?? null, 0, PHP_INT_MAX, 0),
    'fx' => entier($r['fx'] ?? null, 0, PHP_INT_MAX, 0),
    'up' => entier($r['up'] ?? null, 0, PHP_INT_MAX, 0),
];

$db->beginTransaction();
if ($connue) {
    $db->prepare('UPDATE bases SET nom=:nom, lat=:lat, lon=:lon, alt=:alt, flou=:flou, mobile=:mobile, fw=:fw, hw=:hw, lien=:lien,
        enligne=:enligne, amont=:amont, bat=:bat, trk=:trk, rx=:rx, fx=:fx, up=:up, dernier=:now,
        rapports = rapports + 1 WHERE id = :id')->execute($base + ['now' => $now, 'id' => $id]);
} else {
    $db->prepare('INSERT INTO bases (id, cle, nom, lat, lon, alt, flou, mobile, fw, hw, lien, enligne, amont, bat, trk, rx, fx, up,
        premier, dernier, rapports) VALUES (:id, :cle, :nom, :lat, :lon, :alt, :flou, :mobile, :fw, :hw, :lien, :enligne, :amont,
        :bat, :trk, :rx, :fx, :up, :now, :now, 1)')->execute($base + ['id' => $id, 'cle' => $hache, 'now' => $now]);
}

// Bases entendues par radio : liens de relais, et « vue par radio » pour une base sans Internet
$voisin = $db->prepare('INSERT INTO voisins (base, autre, rssi, metrique, ts) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(base, autre) DO UPDATE SET rssi = excluded.rssi, metrique = excluded.metrique, ts = excluded.ts');
$vue = $db->prepare('UPDATE bases SET vu_radio = ?, vu_par = ? WHERE id = ? AND (vu_radio IS NULL OR vu_radio < ?)');
foreach (array_slice(is_array($r['bases'] ?? null) ? $r['bases'] : [], 0, 8) as $b) {
    if (!is_array($b) || count($b) < 4) continue;
    $autre = hexa($b[0], 8);
    $age = entier($b[3], 0, 600);
    if (!$autre || $autre === $id || $age === null) continue;
    $ts = $now - $age;
    $voisin->execute([$id, $autre, entier($b[1], -150, 0, -150), entier($b[2], 0, 15, 15), $ts]);
    $vue->execute([$ts, $id, $autre, $ts]);
}

// Positions publiables (le firmware applique déjà la règle OGN)
$point = $db->prepare('INSERT INTO points (cle, src, ts, lat, lon, alt, kmh, cap, vz, flags, cat, base, rssi, relais)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
$sos = 0;
foreach (array_slice(is_array($r['pos'] ?? null) ? $r['pos'] : [], 0, 80) as $p) {
    if (!is_array($p) || count($p) < 13) continue;
    $addr = hexa($p[0], 6);
    $src = in_array($p[1], ['A', 'F'], true) ? $p[1] : '';
    $age = entier($p[2], 0, 3600);
    $plat = nombre($p[3], -90, 90);
    $plon = nombre($p[4], -180, 180);
    if (!$addr || !$src || $age === null || $plat === null || $plon === null || ($plat == 0 && $plon == 0)) continue;
    $flags = entier($p[9], 0, 255, 0) & 0x07;
    $sos |= $flags & 1;
    $point->execute(['FNT' . $addr, $src, $now - $age, $plat, $plon, entier($p[5], -500, 12000), entier($p[6], 0, 999),
        entier($p[7], 0, 360), nombre($p[8], -99, 99), $flags, categorie_fanet(entier($p[12], 0, 15, 0)), $id,
        entier($p[10], -150, 0), hexa($p[11], 8) ?: null]);
    $cles['FNT' . $addr] = true;
}
// SOS arrêté : une position sans SOS plus récente efface le drapeau des points SOS d'avant (sinon, les
// positions ordinaires étant effacées après 2 h et les SOS gardés 24 h, le dernier point restant
// redeviendrait le SOS et la carte le croirait toujours en cours)
$finSos = $db->prepare('UPDATE points SET flags = flags & 254 WHERE cle = ? AND (flags & 1) = 1
    AND ts < (SELECT MAX(ts) FROM points WHERE cle = ? AND (flags & 1) = 0)');
foreach (array_keys($cles ?? []) as $cle) $finSos->execute([$cle, $cle]);

// Couverture (anonyme) : meilleur signal et nombre de positions reçues en direct par case. Chaque case
// garde si elle a été mesurée par une base MOBILE (couverture temporaire, montrée à part) ; celle d'une
// base mobile s'accumule d'un site à l'autre (choix d'Alexis : voir tous les sites déjà couverts).
$case = $db->prepare('INSERT INTO couverture (base, la, lo, src, rssi, n, ts, mobile) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(base, la, lo, src) DO UPDATE SET rssi = MAX(rssi, excluded.rssi), n = n + excluded.n,
    ts = excluded.ts, mobile = excluded.mobile');
foreach (array_slice(is_array($r['cov'] ?? null) ? $r['cov'] : [], 0, 100) as $c) {
    if (!is_array($c) || count($c) < 5) continue;
    $la = entier($c[0], -18000, 18000);
    $lo = entier($c[1], -36000, 36000);
    $src = in_array($c[4], ['A', 'F'], true) ? $c[4] : '';
    $rssi = entier($c[2], -150, 0);
    if ($la === null || $lo === null || !$src || $rssi === null) continue;
    $case->execute([$id, $la, $lo, $src, $rssi, entier($c[3], 1, 65535, 1), $now, $base['mobile']]);
}

// Noms de pilote (FANET type 2) : la base n'envoie que ceux d'appareils à position publiable
$majNom = $db->prepare('INSERT INTO noms (cle, nom, ts, base) VALUES (?, ?, ?, ?)
    ON CONFLICT(cle) DO UPDATE SET nom = excluded.nom, ts = excluded.ts, base = excluded.base');
foreach (array_slice(is_array($r['noms'] ?? null) ? $r['noms'] : [], 0, 16) as $n) {
    if (!is_array($n) || count($n) < 2 || !is_string($n[1])) continue;
    $addr = hexa($n[0], 6);
    $texte = nom_pilote($n[1]);
    if ($addr && $texte !== '') $majNom->execute(['FNT' . $addr, $texte, $now, $id]);
}
$db->commit();

if (mt_rand(1, 20) === 1) purger();
repondre(['ok' => 1, 'sos' => $sos]);
