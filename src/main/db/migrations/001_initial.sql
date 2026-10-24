-- W3Labs Entertainment System — esquema inicial
-- Timestamps são ISO-8601 em UTC. Hashes são hexadecimais minúsculos.

CREATE TABLE IF NOT EXISTS platforms (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  short_name         TEXT NOT NULL,
  manufacturer       TEXT NOT NULL,
  generation         INTEGER NOT NULL,
  rom_extensions     TEXT NOT NULL,
  max_players        INTEGER NOT NULL DEFAULT 2,
  heavy              INTEGER NOT NULL DEFAULT 0 CHECK (heavy IN (0, 1)),
  bios_required      INTEGER NOT NULL DEFAULT 0 CHECK (bios_required IN (0, 1)),
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS library_roots (
  id                 TEXT PRIMARY KEY,
  path               TEXT NOT NULL UNIQUE,
  platform_id        TEXT REFERENCES platforms(id) ON DELETE SET NULL,
  recursive          INTEGER NOT NULL DEFAULT 1 CHECK (recursive IN (0, 1)),
  enabled            INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  last_scan_at       TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS games (
  id                 TEXT PRIMARY KEY,
  platform_id        TEXT NOT NULL REFERENCES platforms(id) ON DELETE RESTRICT,
  title              TEXT NOT NULL,
  sort_title         TEXT NOT NULL,
  file_path          TEXT NOT NULL UNIQUE,
  file_name          TEXT NOT NULL,
  file_size          INTEGER NOT NULL DEFAULT 0 CHECK (file_size >= 0),
  file_mtime_ms      INTEGER NOT NULL DEFAULT 0,
  rom_hash           TEXT NOT NULL,
  rom_md5            TEXT,
  region             TEXT NOT NULL DEFAULT 'unknown'
                      CHECK (region IN ('ntsc-u', 'ntsc-j', 'pal', 'global', 'unknown')),
  serial             TEXT,
  disc_number        INTEGER NOT NULL DEFAULT 1,
  ra_game_id         INTEGER,
  cover_file         TEXT,
  synopsis           TEXT,
  release_year       INTEGER,
  publisher          TEXT,
  developer          TEXT,
  genre              TEXT,
  favorite           INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1)),
  is_missing         INTEGER NOT NULL DEFAULT 0 CHECK (is_missing IN (0, 1)),
  scrape_status      TEXT NOT NULL DEFAULT 'pending'
                      CHECK (scrape_status IN ('pending', 'completed', 'failed', 'skipped')),
  scraped_at         TEXT,
  playtime_seconds   INTEGER NOT NULL DEFAULT 0 CHECK (playtime_seconds >= 0),
  last_played_at     TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_games_platform_title ON games(platform_id, sort_title);
CREATE INDEX IF NOT EXISTS idx_games_title ON games(sort_title);
CREATE INDEX IF NOT EXISTS idx_games_favorite ON games(favorite, sort_title) WHERE favorite = 1;
CREATE INDEX IF NOT EXISTS idx_games_last_played ON games(last_played_at DESC) WHERE last_played_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_games_missing ON games(is_missing);
CREATE INDEX IF NOT EXISTS idx_games_rom_hash ON games(rom_hash);

CREATE TABLE IF NOT EXISTS bios_files (
  id                 TEXT PRIMARY KEY,
  platform_id        TEXT NOT NULL REFERENCES platforms(id) ON DELETE CASCADE,
  region             TEXT NOT NULL
                      CHECK (region IN ('ntsc-u', 'ntsc-j', 'pal', 'global', 'unknown')),
  kind               TEXT NOT NULL CHECK (kind IN ('bios', 'bootrom', 'flash', 'firmware')),
  label              TEXT NOT NULL,
  file_name          TEXT NOT NULL,
  file_path          TEXT NOT NULL UNIQUE,
  size_bytes         INTEGER NOT NULL CHECK (size_bytes > 0),
  md5                TEXT NOT NULL,
  sha1               TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'valid'
                      CHECK (status IN ('valid', 'invalid', 'missing')),
  verified_at        TEXT NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (platform_id, md5, kind)
);

CREATE INDEX IF NOT EXISTS idx_bios_lookup ON bios_files(platform_id, region, kind, status);

CREATE TABLE IF NOT EXISTS save_states (
  id                 TEXT PRIMARY KEY,
  game_id            TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  slot               INTEGER NOT NULL CHECK (slot >= 0 AND slot <= 99),
  state_path         TEXT NOT NULL UNIQUE,
  size_bytes         INTEGER NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  core_id            TEXT NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (game_id, slot)
);

CREATE INDEX IF NOT EXISTS idx_save_states_game ON save_states(game_id, slot);

CREATE TABLE IF NOT EXISTS play_sessions (
  id                 TEXT PRIMARY KEY,
  game_id            TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  core_id            TEXT NOT NULL,
  started_at         TEXT NOT NULL,
  ended_at           TEXT,
  duration_seconds   INTEGER NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
  hardcore           INTEGER NOT NULL DEFAULT 0 CHECK (hardcore IN (0, 1)),
  status             TEXT NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running', 'paused', 'stopped', 'crashed')),
  exit_code          INTEGER,
  error_message      TEXT
);

CREATE INDEX IF NOT EXISTS idx_play_sessions_game ON play_sessions(game_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_play_sessions_running ON play_sessions(status) WHERE status IN ('running', 'paused');

CREATE TABLE IF NOT EXISTS controller_profiles (
  id                 TEXT PRIMARY KEY,
  player_index       INTEGER NOT NULL CHECK (player_index BETWEEN 1 AND 4),
  name               TEXT NOT NULL,
  api                TEXT NOT NULL CHECK (api IN ('xinput', 'directinput', 'keyboard')),
  hardware_guid      TEXT NOT NULL,
  product_name       TEXT,
  is_valid           INTEGER NOT NULL DEFAULT 1 CHECK (is_valid IN (0, 1)),
  mapping_json       TEXT NOT NULL DEFAULT '{}',
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (hardware_guid),
  UNIQUE (player_index)
);

CREATE TABLE IF NOT EXISTS settings (
  key                TEXT PRIMARY KEY,
  value_json         TEXT NOT NULL,
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS secret_store (
  name               TEXT PRIMARY KEY,
  ciphertext         TEXT NOT NULL,
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS scrape_cache (
  cache_key          TEXT PRIMARY KEY,
  provider           TEXT NOT NULL,
  payload_json       TEXT NOT NULL,
  expires_at         TEXT NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_scrape_cache_expiry ON scrape_cache(expires_at);

CREATE TABLE IF NOT EXISTS achievements (
  id                 TEXT PRIMARY KEY,
  game_id            TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  ra_achievement_id  INTEGER NOT NULL,
  title              TEXT NOT NULL,
  description        TEXT,
  points             INTEGER NOT NULL DEFAULT 0,
  badge_url          TEXT,
  earned_at          TEXT,
  hardcore           INTEGER NOT NULL DEFAULT 0 CHECK (hardcore IN (0, 1)),
  UNIQUE (game_id, ra_achievement_id)
);

CREATE TABLE IF NOT EXISTS logs (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  level              TEXT NOT NULL,
  scope              TEXT NOT NULL,
  message            TEXT NOT NULL,
  meta_json          TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level, created_at DESC);
