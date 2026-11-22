<?php
// AeroTrack — carte des bases : état en direct pour la page (GET, rafraîchi toutes les 15 s).
//   bases     : bases inscrites et placées (nom, état, dernière connexion, liaison…)
//   liens     : bases qui s'entendent par radio (relais entre bases)
//   aeronefs  : dernière position + trace de 30 min (AeroTrack et FANET reçus par nos bases,
//               autres aéronefs du réseau OGN), SOS gardés 24 h
declare(strict_types=1);
require __DIR__ . '/_commun.php';
require __DIR__ . '/_ogn.php';

$cache = cache_lire('donnees.json', 5);       // plusieurs visiteurs : un seul calcul toutes les 5 s
if ($cache !== null) {
    header('Content-Type: application/json; charset=utf-8');
    header('Access-Control-Allow-Origin: *');
    header('Cache-Control: no-store');
    if (extension_loaded('zlib')) ob_start('ob_gzhandler');
    echo $cache;
    exit;
}

try { ogn_collecter(); } catch (Throwable $e) { etat_ecrire('ogn_erreur', substr($e->getMessage(), 0, 200)); }

$db = db();
$now = time();

$bases = [];
foreach ($db->query('SELECT id, nom, lat, lon, alt, flou, mobile, fw, hw, lien, enligne, amont, bat, trk, premier, dernier,
        vu_radio, vu_par FROM bases WHERE lat IS NOT NULL ORDER BY nom') as $b) {
    foreach (['alt', 'flou', 'mobile', 'enligne', 'bat', 'trk', 'premier', 'dernier', 'vu_radio'] as $k) {
        $b[$k] = $b[$k] === null ? null : (int)$b[$k];
    }
    $b['lat'] = (float)$b['lat'];
    $b['lon'] = (float)$b['lon'];
    $b['amont'] = $b['amont'] ?: null;
    $bases[] = $b;
}

$liens = [];
$q = $db->prepare('SELECT base, autre, rssi, metrique, ts FROM voisins WHERE ts > ?');
$q->execute([$now - 900]);
foreach ($q as $l) $liens[] = ['a' => $l['base'], 'b' => $l['autre'], 'rssi' => (int)$l['rssi'],
    'metrique' => (int)$l['metrique'], 'ts' => (int)$l['ts']];

// Aéronefs : points récents groupés par appareil
function aeronef(array $p): array {
    $f = (int)$p['flags'];
    return [
        'id' => $p['cle'], 'src' => $p['src'], 'cat' => $p['cat'], 'ts' => (int)$p['ts'],
        'lat' => (float)$p['lat'], 'lon' => (float)$p['lon'],
        'alt' => $p['alt'] === null ? null : (int)$p['alt'], 'kmh' => $p['kmh'] === null ? null : (int)$p['kmh'],
        'cap' => $p['cap'] === null ? null : (int)$p['cap'], 'vz' => $p['vz'] === null ? null : (float)$p['vz'],
        'sos' => (bool)($f & 1), 'vol' => (bool)($f & 2), 'anonyme' => (bool)($f & 8),
        'base' => $p['base'], 'rssi' => $p['rssi'] === null ? null : (int)$p['rssi'], 'relais' => $p['relais'],
        'trace' => [],
    ];
}

$avions = [];
$q = $db->prepare('SELECT * FROM points WHERE ts > ? ORDER BY cle, ts');
$q->execute([$now - DUREE_TRACE]);
foreach ($q as $p) {
    $k = $p['cle'];
    $trace = $avions[$k]['trace'] ?? [];
    $trace[] = [(float)$p['lat'], (float)$p['lon'], $p['alt'] === null ? null : (int)$p['alt']];
    $avions[$k] = aeronef($p);
    $avions[$k]['trace'] = $trace;
}
// Doublons : OGN rediffuse nos trackers (ex. FLRFC1C14 = FNTFC1C14 reçu par une base). Même adresse
// (6 hexa) et nouvelles proches → on garde la position de la base, complétée par OGN (catégorie, altitude).
foreach ($avions as $k => $o) {
    if ($o['src'] !== 'O' || !preg_match('/^[A-Z]{3}([0-9A-F]{6})$/', $k, $m)) continue;
    $f = 'FNT' . $m[1];
    if (!isset($avions[$f]) || abs($avions[$f]['ts'] - $o['ts']) > 600) continue;
    if ($avions[$f]['cat'] === 'autre') $avions[$f]['cat'] = $o['cat'];
    if ($avions[$f]['alt'] === null && abs($avions[$f]['ts'] - $o['ts']) < 120) $avions[$f]['alt'] = $o['alt'];
    unset($avions[$k]);
}
// SOS plus anciens que la trace : le pilote ne donne peut-être plus de nouvelles, il reste affiché 24 h
$q = $db->prepare('SELECT DISTINCT cle FROM points WHERE (flags & 1) = 1 AND ts > ?');
$q->execute([$now - GARDE_SOS]);
$dernier = $db->prepare('SELECT * FROM points WHERE cle = ? ORDER BY ts DESC LIMIT 1');
foreach ($q->fetchAll(PDO::FETCH_COLUMN) as $k) {
    if (isset($avions[$k])) continue;
    $dernier->execute([$k]);
    $p = $dernier->fetch();
    if ($p && ((int)$p['flags'] & 1)) $avions[$k] = aeronef($p);
}

// Trackers AeroTrack (fabricant FANET 0xFC) au sol : la trame FANET « sol » ne dit pas le type d'aéronef
foreach ($avions as $k => $a) {
    if ($a['cat'] === 'autre' && str_starts_with($k, 'FNTFC')) $avions[$k]['cat'] = 'parapente';
}

// Nom du pilote (FANET type 2 reçu par une base) ; aussi pour nos trackers vus seulement par
// OGN (FLRFC1C14 = FNTFC1C14). Jamais pour un appareil anonyme.
$noms = [];
foreach ($db->query('SELECT cle, nom FROM noms') as $n) $noms[$n['cle']] = $n['nom'];
foreach ($avions as $k => $a) {
    $cle = ($a['src'] === 'O' && preg_match('/^[A-Z]{3}(FC[0-9A-F]{4})$/', $k, $m)) ? 'FNT' . $m[1] : $k;
    $avions[$k]['nom'] = $a['anonyme'] ? null : ($noms[$cle] ?? null);
}

$sortie = [
    'maj' => $now,
    'bases' => $bases,
    'liens' => $liens,
    'aeronefs' => array_values($avions),
    'ogn' => ['vus' => (int)etat_lire('ogn_n', '0'), 'erreur' => etat_lire('ogn_erreur')],
];
$json = json_encode($sortie, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
cache_ecrire('donnees.json', $json);
repondre($sortie);
