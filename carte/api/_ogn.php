<?php
// AeroTrack — carte des bases : aéronefs du réseau OGN autour des bases inscrites.
// Pas de tâche planifiée sur l'hébergement : la collecte se fait quand quelqu'un regarde la
// carte, au plus toutes les 20 s, en écoutant le flux APRS d'OGN 4 s (les aéronefs en vol
// émettent toutes les 1 à 5 s). Règles d'OGN respectées :
//   - « no tracking » (bit 0x40 du champ id, ou tracked=N dans la DDB) : jamais affiché ;
//   - « no identify » (identified=N dans la DDB) : affiché sans identifiant.
declare(strict_types=1);

const OGN_SERVEUR    = 'aprs.glidernet.org';
const OGN_PORT       = 14580;
const OGN_PERIODE_S  = 20;
const OGN_ECOUTE_S   = 4.0;
const OGN_RAYON_KM   = 60;
const OGN_DDB_URL    = 'https://ddb.glidernet.org/download/?j=1&t=1';

// Appareils à ne pas suivre / à ne pas identifier (DDB d'OGN, rafraîchie une fois par jour)
function ogn_ddb(): array {
    static $ddb = null;
    if ($ddb !== null) return $ddb;
    $cache = cache_lire('ogn-ddb.json', 86400);
    if ($cache === null && etat_prendre('ogn_ddb', 3600)) {
        $brut = telecharger(OGN_DDB_URL, 20);
        $j = $brut ? json_decode($brut, true) : null;
        if (is_array($j['devices'] ?? null)) {
            $masques = ['cache' => [], 'anonyme' => []];
            foreach ($j['devices'] as $d) {
                $id = strtoupper((string)($d['device_id'] ?? ''));
                if (($d['tracked'] ?? 'Y') === 'N') $masques['cache'][$id] = 1;
                elseif (($d['identified'] ?? 'Y') === 'N') $masques['anonyme'][$id] = 1;
            }
            $cache = json_encode($masques);
            cache_ecrire('ogn-ddb.json', $cache);
        }
    }
    if ($cache === null) $cache = @file_get_contents(DOSSIER_DONNEES . '/ogn-ddb.json') ?: '';   // périmée mais mieux que rien
    $ddb = json_decode($cache, true) ?: ['cache' => [], 'anonyme' => []];
    return $ddb;
}

// Une ligne APRS d'OGN → point, ou null (récepteur, ligne de service, aéronef à masquer)
function ogn_lire_ligne(string $l, int $now): ?array {
    if ($l === '' || $l[0] === '#') return null;
    $re = '#^([A-Z0-9]{3,9})>[^:]+:[/@](\d{2})(\d{2})(\d{2})h(\d{2})(\d{2}\.\d{2})([NS]).(\d{3})(\d{2}\.\d{2})([EW]).'
        . '(?:(\d{3})/(\d{3}))?/A=(-?\d{6})(.*)$#';
    if (!preg_match($re, $l, $m)) return null;
    if (str_contains(substr($l, 0, 24), '>OGADSB')) return null;  // avions de ligne captés en ADS-B : hors sujet
    if (!preg_match('/\bid([0-9A-F]{2})([0-9A-F]{6})\b/', $m[14], $id)) return null;   // récepteurs : pas de champ id
    $bits = hexdec($id[1]);
    if ($bits & 0x40) return null;                                // « no tracking »
    $type = ($bits >> 2) & 0x0F;
    if ($type === 15 || $type === 0) return null;                 // objet fixe / inconnu
    $ddb = ogn_ddb();
    if (isset($ddb['cache'][$id[2]])) return null;
    $anonyme = isset($ddb['anonyme'][$id[2]]) || ($bits & 0x80);  // DDB ou mode furtif

    $dlat = 0; $dlon = 0;
    if (preg_match('/!W(\d)(\d)!/', $m[14], $w)) { $dlat = (int)$w[1] / 1000; $dlon = (int)$w[2] / 1000; }
    $lat = (int)$m[5] + ((float)$m[6] + $dlat) / 60;
    $lon = (int)$m[8] + ((float)$m[9] + $dlon) / 60;
    if ($m[7] === 'S') $lat = -$lat;
    if ($m[10] === 'W') $lon = -$lon;
    $vz = preg_match('/([+-]\d+)fpm/', $m[14], $f) ? round((int)$f[1] * 0.00508, 1) : null;

    $ts = gmmktime((int)$m[2], (int)$m[3], (int)$m[4], (int)gmdate('n', $now), (int)gmdate('j', $now), (int)gmdate('Y', $now));
    if ($ts > $now + 300) $ts -= 86400;                           // juste avant minuit UTC
    if ($ts < $now - 600) return null;

    $cle = $anonyme ? 'OGN-' . substr(hash('sha256', $m[1] . gmdate('Ymd', $now)), 0, 6) : $m[1];
    $kmh = isset($m[12]) && $m[12] !== '' ? (int)round((int)$m[12] * 1.852) : null;
    return [
        'cle' => $cle, 'ts' => $ts, 'lat' => round($lat, 6), 'lon' => round($lon, 6),
        'alt' => (int)round((int)$m[13] * 0.3048), 'kmh' => $kmh, 'cap' => $kmh ? (int)$m[11] : null,
        'vz' => $vz, 'vol' => $kmh !== null && $kmh > 10, 'cat' => categorie_ogn($type),
        'anonyme' => $anonyme,
    ];
}

function ogn_collecter(): void {
    $db = db();
    if (!etat_prendre('ogn', OGN_PERIODE_S)) return;
    // Zone : autour des bases placées qui ont donné des nouvelles cette semaine
    $bases = $db->query('SELECT lat, lon FROM bases WHERE lat IS NOT NULL AND dernier > ' . (time() - 7 * 86400)
        . ' ORDER BY dernier DESC LIMIT 8')->fetchAll();
    if (!$bases) return;
    $filtre = implode(' ', array_map(fn($b) => sprintf('r/%.3f/%.3f/%d', $b['lat'], $b['lon'], OGN_RAYON_KM), $bases));

    $s = @fsockopen(OGN_SERVEUR, OGN_PORT, $errno, $errstr, 4);
    if (!$s) { etat_ecrire('ogn_erreur', "$errno $errstr"); return; }
    stream_set_timeout($s, 1);
    fwrite($s, "user AEROCARTE pass -1 vers AeroTrack-Carte 1.0 filter $filtre\r\n");
    $fin = microtime(true) + OGN_ECOUTE_S;
    $vus = [];
    $now = time();
    while (microtime(true) < $fin && !feof($s)) {
        $l = fgets($s, 1024);
        if ($l === false) continue;
        $p = ogn_lire_ligne(trim($l), $now);
        if ($p) $vus[$p['cle']] = $p;           // dernière position de chaque aéronef
    }
    fclose($s);

    // Les aéronefs déjà suivis par nos bases (FNT…) gardent la position reçue par la base
    $ins = $db->prepare('INSERT INTO points (cle, src, ts, lat, lon, alt, kmh, cap, vz, flags, cat, base, rssi, relais)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)');
    // OGN rediffuse aussi nos trackers sous un autre préfixe (FLR…, OGN…) : comparer l'adresse (6 hexa).
    // 5 min : une base envoie ses positions à la carte toutes les 1 à 5 min.
    $recent = $db->prepare("SELECT 1 FROM points WHERE cle = ? AND src IN ('A','F') AND ts > ? LIMIT 1");
    $db->beginTransaction();
    foreach ($vus as $p) {
        $nous = preg_match('/^[A-Z]{3}([0-9A-F]{6})$/', $p['cle'], $m) ? 'FNT' . $m[1] : $p['cle'];
        $recent->execute([$nous, $now - 300]);
        if ($recent->fetchColumn()) continue;
        $flags = ($p['vol'] ? 2 : 0) | ($p['anonyme'] ? 8 : 0);
        $ins->execute([$p['cle'], 'O', $p['ts'], $p['lat'], $p['lon'], $p['alt'], $p['kmh'], $p['cap'], $p['vz'],
            $flags, $p['cat']]);
    }
    $db->commit();
    etat_ecrire('ogn_n', (string)count($vus));
}
