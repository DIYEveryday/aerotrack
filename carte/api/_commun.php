<?php
// AeroTrack — carte des bases : fonctions communes (base SQLite, réponses JSON, téléchargements).
// Données dans ../donnees/ (protégé par .htaccess, jamais publié par le dépôt).
declare(strict_types=1);

const DOSSIER_DONNEES = __DIR__ . '/../donnees';
const GARDE_POINTS    = 7200;      // positions ordinaires gardées 2 h (trace affichée : 30 min)
const GARDE_SOS       = 86400;     // un SOS reste visible 24 h, même si le tracker s'est tu
const DUREE_TRACE     = 1800;      // trace affichée : 30 min
const GARDE_NOMS      = 2592000;   // nom de pilote (FANET type 2) oublié après 30 jours sans nouvelles
const CASE_DEG        = 0.005;     // case de couverture (identique au firmware : CARTE_CELL_DEG)

function donnees_pret(): void {
    if (!is_dir(DOSSIER_DONNEES)) mkdir(DOSSIER_DONNEES, 0750, true);
    $h = DOSSIER_DONNEES . '/.htaccess';
    if (!is_file($h)) {
        file_put_contents($h, "<IfModule mod_authz_core.c>\nRequire all denied\n</IfModule>\n"
            . "<IfModule !mod_authz_core.c>\nOrder allow,deny\nDeny from all\n</IfModule>\n");
    }
}

function db(): PDO {
    static $db = null;
    if ($db) return $db;
    donnees_pret();
    $db = new PDO('sqlite:' . DOSSIER_DONNEES . '/carte.sqlite');
    $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
    $db->exec('PRAGMA busy_timeout = 8000');
    $db->exec(<<<SQL
CREATE TABLE IF NOT EXISTS bases (
  id TEXT PRIMARY KEY, cle TEXT NOT NULL, nom TEXT DEFAULT '', lat REAL, lon REAL, alt INTEGER,
  flou INTEGER DEFAULT 0, fw TEXT, hw TEXT, lien TEXT, enligne INTEGER DEFAULT 0, amont TEXT,
  bat INTEGER, trk INTEGER DEFAULT 0, rx INTEGER DEFAULT 0, fx INTEGER DEFAULT 0, up INTEGER DEFAULT 0,
  premier INTEGER, dernier INTEGER, rapports INTEGER DEFAULT 0, vu_radio INTEGER, vu_par TEXT,
  mobile INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS voisins (
  base TEXT, autre TEXT, rssi INTEGER, metrique INTEGER, ts INTEGER, PRIMARY KEY (base, autre));
CREATE TABLE IF NOT EXISTS points (
  cle TEXT, src TEXT, ts INTEGER, lat REAL, lon REAL, alt INTEGER, kmh INTEGER, cap INTEGER,
  vz REAL, flags INTEGER, cat TEXT, base TEXT, rssi INTEGER, relais TEXT);
CREATE INDEX IF NOT EXISTS points_ts ON points (ts);
CREATE INDEX IF NOT EXISTS points_cle ON points (cle, ts);
CREATE TABLE IF NOT EXISTS couverture (
  base TEXT, la INTEGER, lo INTEGER, src TEXT, rssi INTEGER, n INTEGER, ts INTEGER, mobile INTEGER DEFAULT 0,
  PRIMARY KEY (base, la, lo, src));
CREATE TABLE IF NOT EXISTS etat (cle TEXT PRIMARY KEY, valeur TEXT);
CREATE TABLE IF NOT EXISTS noms (cle TEXT PRIMARY KEY, nom TEXT NOT NULL, ts INTEGER, base TEXT);
SQL);
    migrer($db);
    return $db;
}

// Évolutions du schéma d'une base SQLite déjà en place (CREATE TABLE IF NOT EXISTS ne modifie pas une
// table existante). PRAGMA user_version = numéro de la dernière étape appliquée.
function migrer(PDO $db): void {
    $v = (int)$db->query('PRAGMA user_version')->fetchColumn();
    if ($v >= 1) return;
    // 1 : bases mobiles (emportées de site en site) et couverture mesurée par elles
    foreach (['bases', 'couverture'] as $table) {
        $colonnes = array_column($db->query("PRAGMA table_info($table)")->fetchAll(), 'name');
        if (!in_array('mobile', $colonnes, true)) $db->exec("ALTER TABLE $table ADD COLUMN mobile INTEGER DEFAULT 0");
    }
    $db->exec('PRAGMA user_version = 1');
}

function etat_lire(string $cle, string $defaut = ''): string {
    $q = db()->prepare('SELECT valeur FROM etat WHERE cle = ?');
    $q->execute([$cle]);
    $v = $q->fetchColumn();
    return $v === false ? $defaut : (string)$v;
}

function etat_ecrire(string $cle, string $valeur): void {
    db()->prepare('INSERT INTO etat (cle, valeur) VALUES (?, ?) ON CONFLICT(cle) DO UPDATE SET valeur = excluded.valeur')
        ->execute([$cle, $valeur]);
}

// Prend un « jeton » de travail : true pour un seul visiteur toutes les $periode secondes
function etat_prendre(string $cle, int $periode): bool {
    $now = time();
    db()->prepare('INSERT OR IGNORE INTO etat (cle, valeur) VALUES (?, 0)')->execute([$cle]);
    $q = db()->prepare('UPDATE etat SET valeur = ? WHERE cle = ? AND CAST(valeur AS INTEGER) <= ?');
    $q->execute([$now, $cle, $now - $periode]);
    return $q->rowCount() === 1;
}

function repondre($donnees, int $code = 200, int $cache_s = 0): void {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    header('Access-Control-Allow-Origin: *');            // la carte est aussi publiée sur github.io
    header($cache_s > 0 ? "Cache-Control: public, max-age=$cache_s" : 'Cache-Control: no-store');
    if (!headers_sent() && extension_loaded('zlib')) ob_start('ob_gzhandler');
    echo json_encode($donnees, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION);
    exit;
}

function erreur(int $code, string $message): void {
    repondre(['erreur' => $message], $code);
}

// Téléchargement (données ouvertes FFVL, base OGN) : contenu, ou null en cas d'échec
function telecharger(string $url, int $delai = 25): ?string {
    $c = curl_init($url);
    curl_setopt_array($c, [
        CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => true, CURLOPT_MAXREDIRS => 4,
        CURLOPT_TIMEOUT => $delai, CURLOPT_CONNECTTIMEOUT => 8,
        CURLOPT_USERAGENT => 'AeroTrack-Carte/1.0 (carte des bases AeroTrack LoRa)',
        CURLOPT_ENCODING => '',
    ]);
    $r = curl_exec($c);
    $code = (int)curl_getinfo($c, CURLINFO_HTTP_CODE);
    curl_close($c);
    return ($r === false || $code !== 200) ? null : $r;
}

// Fichier de cache dans ../donnees : contenu s'il a moins de $age_max s, sinon null
function cache_lire(string $nom, int $age_max): ?string {
    $f = DOSSIER_DONNEES . '/' . $nom;
    if (!is_file($f) || time() - filemtime($f) > $age_max) return null;
    $r = file_get_contents($f);
    return $r === false ? null : $r;
}

function cache_ecrire(string $nom, string $contenu): void {
    donnees_pret();
    $f = DOSSIER_DONNEES . '/' . $nom;
    file_put_contents("$f.tmp", $contenu, LOCK_EX);
    rename("$f.tmp", $f);
}

// Catégorie d'aéronef commune (FANET et OGN) → texte court pour la carte
function categorie_fanet(int $t): string {
    return [1 => 'parapente', 2 => 'delta', 3 => 'ballon', 4 => 'planeur', 5 => 'avion', 6 => 'helico', 7 => 'drone'][$t] ?? 'autre';
}

function categorie_ogn(int $t): string {
    return [1 => 'planeur', 2 => 'avion', 3 => 'helico', 4 => 'parachute', 5 => 'avion', 6 => 'delta',
            7 => 'parapente', 8 => 'avion', 9 => 'avion', 11 => 'ballon', 12 => 'ballon', 13 => 'drone'][$t] ?? 'autre';
}

// Nettoyage des vieilles données (appelé de temps en temps)
function purger(): void {
    $now = time();
    $db = db();
    $db->prepare('DELETE FROM points WHERE ts < ? AND (flags & 1) = 0')->execute([$now - GARDE_POINTS]);
    $db->prepare('DELETE FROM points WHERE ts < ?')->execute([$now - GARDE_SOS]);
    $db->prepare('DELETE FROM voisins WHERE ts < ?')->execute([$now - 86400]);
    $db->prepare('DELETE FROM noms WHERE ts < ?')->execute([$now - GARDE_NOMS]);
}
