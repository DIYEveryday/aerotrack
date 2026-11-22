<?php
// AeroTrack — carte des bases : couverture radio mesurée (GET).
// Une case ≈ 550 m : meilleur signal reçu EN DIRECT par la base (AeroTrack « A » ou FANET « F »)
// et nombre de positions. Anonyme : aucune case ne dit qui volait là.
// Réponse : { deg, cases: [[base, la, lo, src, rssi, n, age_jours, mobile]] } ; coin sud-ouest = (la·deg, lo·deg).
// mobile = 1 : mesurée par une base mobile (temporaire, calque à part sur la carte).
declare(strict_types=1);
require __DIR__ . '/_commun.php';

$cache = cache_lire('couverture-v2.json', 60);
if ($cache === null) {
    $now = time();
    $cases = [];
    $q = db()->prepare('SELECT base, la, lo, src, rssi, n, ts, mobile FROM couverture WHERE ts > ?');
    $q->execute([$now - 400 * 86400]);
    foreach ($q as $c) {
        $cases[] = [$c['base'], (int)$c['la'], (int)$c['lo'], $c['src'], (int)$c['rssi'], (int)$c['n'],
            intdiv($now - (int)$c['ts'], 86400), (int)$c['mobile']];
    }
    $cache = json_encode(['deg' => CASE_DEG, 'cases' => $cases]);
    cache_ecrire('couverture-v2.json', $cache);
}
header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Cache-Control: public, max-age=60');
if (extension_loaded('zlib')) ob_start('ob_gzhandler');
echo $cache;
