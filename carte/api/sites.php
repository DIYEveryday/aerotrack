<?php
// AeroTrack — carte des bases : sites de vol et balises météo de la FFVL (GET).
// Données ouvertes de la FFVL publiées sur data.gouv.fr (Licence Ouverte 2.0), mises en cache ici.
//   ?quoi=sites    → [[suid, nom, fonction, lat, lon, alt, orientations, statut, pratiques]]  (cache 24 h)
//                    fonction : lettres D décollage, A atterrissage, T treuil, P pente-école
//                    statut   : ok, autorisation, interdit, temporaire
//   ?quoi=balises  → [[id, nom, lat, lon, alt, ts, vent_moy, vent_max, direction, temperature]] (cache 10 min)
// Les coordonnées personnelles des responsables de balises (téléphone, courriel) ne sont JAMAIS reprises.
declare(strict_types=1);
require __DIR__ . '/_commun.php';

const URL_TERRAINS = 'https://www.data.gouv.fr/fr/datasets/r/4375c95d-cf26-4e71-b72d-2e09be5a0e36';
const URL_BALISES  = 'https://www.data.gouv.fr/fr/datasets/r/8d795154-9145-4ab2-99de-6768a36f31ea';
const URL_RELEVES  = 'https://www.data.gouv.fr/fr/datasets/r/047b2ab9-627f-4e5f-9d68-5b948433c61d';

function envoyer_cache(string $json, int $age): void {
    header('Content-Type: application/json; charset=utf-8');
    header('Access-Control-Allow-Origin: *');
    header("Cache-Control: public, max-age=$age");
    if (extension_loaded('zlib')) ob_start('ob_gzhandler');
    echo $json;
    exit;
}

function sites_ffvl(): string {
    $c = cache_lire('ffvl-sites.json', 86400);
    if ($c !== null) return $c;
    $brut = etat_prendre('ffvl_sites', 600) ? telecharger(URL_TERRAINS, 40) : null;
    $liste = $brut ? json_decode($brut, true) : null;
    if (!is_array($liste)) return @file_get_contents(DOSSIER_DONNEES . '/ffvl-sites.json') ?: '[]';
    $statuts = ['actif' => 'ok', 'actif_autorisation_systematique_requise' => 'autorisation', 'interdit' => 'interdit',
                'interdit_sauf_autorisation' => 'interdit', 'non_praticable_temporaire' => 'temporaire'];
    $sortie = [];
    foreach ($liste as $t) {
        $pratiques = (string)($t['possible_usages_text'] ?? '');
        if (!preg_match('/parapente|delta|speed/', $pratiques)) continue;       // kite : hors sujet
        $lat = $t['latitude'] ?? null; $lon = $t['longitude'] ?? null;
        if (!is_numeric($lat) || !is_numeric($lon)) continue;
        $fn = (string)($t['flying_functions_text'] ?? '');
        $code = (str_contains($fn, 'décollage') ? 'D' : '') . (str_contains($fn, 'atterrissage') ? 'A' : '')
              . (str_contains($fn, 'treuil') ? 'T' : '') . (str_contains($fn, 'pente') ? 'P' : '');
        if ($code === '') continue;
        $sortie[] = [(int)$t['suid'], (string)($t['toponym'] ?? ''), $code, round((float)$lat, 5), round((float)$lon, 5),
            is_numeric($t['altitude'] ?? null) ? (int)$t['altitude'] : null, (string)($t['wind_orientations_ok'] ?? ''),
            $statuts[$t['status'] ?? ''] ?? 'ok', str_replace(';', ', ', $pratiques)];
    }
    $json = json_encode($sortie, JSON_UNESCAPED_UNICODE);
    cache_ecrire('ffvl-sites.json', $json);
    return $json;
}

function balises_ffvl(): string {
    $c = cache_lire('ffvl-balises.json', 600);
    if ($c !== null) return $c;
    $liste = cache_lire('ffvl-balises-liste.json', 86400);
    if ($liste === null && etat_prendre('ffvl_balises', 600)) {
        $brut = telecharger(URL_BALISES, 30);
        $b = $brut ? json_decode($brut, true) : null;
        if (is_array($b)) {
            $propre = [];
            foreach ($b as $x) {       // seulement l'utile : jamais les contacts
                if (!is_numeric($x['latitude'] ?? null) || !is_numeric($x['longitude'] ?? null)) continue;
                $propre[(int)$x['idBalise']] = [(int)$x['idBalise'], (string)($x['nom'] ?? ''), round((float)$x['latitude'], 5),
                    round((float)$x['longitude'], 5), is_numeric($x['altitude'] ?? null) ? (int)$x['altitude'] : null,
                    (int)($x['en_maintenance'] ?? 0)];
            }
            $liste = json_encode($propre, JSON_UNESCAPED_UNICODE);
            cache_ecrire('ffvl-balises-liste.json', $liste);
        }
    }
    $liste = json_decode($liste ?? (@file_get_contents(DOSSIER_DONNEES . '/ffvl-balises-liste.json') ?: '{}'), true) ?: [];
    $brut = etat_prendre('ffvl_releves', 300) ? telecharger(URL_RELEVES, 20) : null;
    $releves = $brut ? json_decode($brut, true) : null;
    if (!is_array($releves)) return @file_get_contents(DOSSIER_DONNEES . '/ffvl-balises.json') ?: '[]';
    $sortie = [];
    foreach ($releves as $r) {
        $b = $liste[(int)($r['idbalise'] ?? 0)] ?? null;
        if (!$b || $b[5]) continue;                       // inconnue ou en maintenance
        $ts = strtotime((string)($r['date'] ?? '')) ?: null;
        $sortie[] = [$b[0], $b[1], $b[2], $b[3], $b[4], $ts, $r['vitesseVentMoy'] ?? null, $r['vitesseVentMax'] ?? null,
            $r['directVentMoy'] ?? null, $r['temperature'] ?? null];
    }
    $json = json_encode($sortie, JSON_UNESCAPED_UNICODE);
    cache_ecrire('ffvl-balises.json', $json);
    return $json;
}

$quoi = $_GET['quoi'] ?? 'sites';
if ($quoi === 'balises') envoyer_cache(balises_ffvl(), 300);
envoyer_cache(sites_ffvl(), 21600);
