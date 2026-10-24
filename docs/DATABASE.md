# Modelagem SQLite

Banco local: `<dataRoot>/data/w3labs.db`. Migrações versionadas em `src/main/db/migrations/`; a versão aplicada fica em `schema_migrations`.

## PRAGMAs de abertura

```sql
PRAGMA journal_mode = WAL;      -- leitura da biblioteca durante escrita de playtime
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA wal_autocheckpoint = 1000;
PRAGMA temp_store = MEMORY;
```

WAL permite um escritor e vários leitores concorrentes. As consultas da UI são prepared statements; a escrita de playtime não bloqueia a leitura da biblioteca.

## Diagrama lógico

```text
platforms 1 ─── n games 1 ─── n save_states
    │               │
    │               └──── n play_sessions
    │               └──── n achievements
    └──── n bios_files

library_roots ──(scan)→ games
controller_profiles   settings   secret_store   scrape_cache   logs
```

## Tabelas

### `platforms`

| Coluna                               | Tipo        | Nota                                     |
| ------------------------------------ | ----------- | ---------------------------------------- |
| `id`                                 | TEXT PK     | `ps1`, `ps2`, `nes`, `xbox`, `ps3`, `gb` |
| `name`, `short_name`, `manufacturer` | TEXT        | exibição                                 |
| `generation`                         | INTEGER     | geração do console                       |
| `rom_extensions`                     | TEXT        | JSON de extensões                        |
| `max_players`                        | INTEGER     | 2 ou 4                                   |
| `heavy`                              | INTEGER 0/1 | PS2/Xbox/PS3                             |
| `bios_required`                      | INTEGER 0/1 | PS1/PS2/Xbox                             |

Seed automático a partir de `config/platforms.js` no boot.

### `games`

| Coluna                                                                      | Tipo         | Nota                                           |
| --------------------------------------------------------------------------- | ------------ | ---------------------------------------------- |
| `id`                                                                        | TEXT PK      | UUID                                           |
| `platform_id`                                                               | TEXT FK      | RESTRICT                                       |
| `title`, `sort_title`                                                       | TEXT         | busca/ordenação                                |
| `file_path`                                                                 | TEXT UNIQUE  | caminho absoluto                               |
| `file_name`, `file_size`, `file_mtime_ms`                                   | TEXT/INTEGER | detecção de mudança                            |
| `rom_hash`                                                                  | TEXT         | SHA-1 usado no caminho de save                 |
| `rom_md5`                                                                   | TEXT         | metadados/RA                                   |
| `region`                                                                    | TEXT         | `ntsc-u`, `ntsc-j`, `pal`, `global`, `unknown` |
| `serial`, `disc_number`                                                     | TEXT/INTEGER | extraídos do nome                              |
| `ra_game_id`                                                                | INTEGER      | vínculo RetroAchievements                      |
| `cover_file`, `synopsis`, `release_year`, `publisher`, `developer`, `genre` | —            | scraping                                       |
| `favorite`, `is_missing`                                                    | INTEGER 0/1  | UI                                             |
| `scrape_status`, `scraped_at`                                               | TEXT         | cache de enriquecimento                        |
| `playtime_seconds`, `last_played_at`                                        | INTEGER/TEXT | estatísticas                                   |

Índices: `(platform_id, sort_title)`, `sort_title`, favoritos parciais, `last_played_at`, `is_missing`, `rom_hash`.

### `bios_files`

| Coluna                            | Tipo    | Nota                                   |
| --------------------------------- | ------- | -------------------------------------- |
| `id`                              | TEXT PK | UUID                                   |
| `platform_id`                     | TEXT FK | CASCADE                                |
| `region`                          | TEXT    | validada por catálogo ou atestada      |
| `kind`                            | TEXT    | `bios`, `bootrom`, `flash`, `firmware` |
| `label`, `file_name`, `file_path` | TEXT    | cópia gerenciada                       |
| `size_bytes`                      | INTEGER | catálogo ou regra da plataforma        |
| `md5`, `sha1`                     | TEXT    | fingerprints calculados                |
| `status`                          | TEXT    | `valid`, `invalid`, `missing`          |
| `verified_at`                     | TEXT    | ISO UTC                                |
| `is_custom`                       | INTEGER | 0 catálogo, 1 dump atestado            |
| `verification_method`             | TEXT    | `catalog-md5` ou `user-attested-hash`  |

`UNIQUE(platform_id, md5, kind)` impede duplicar a mesma BIOS para o mesmo papel. A resolução de execução exige região do jogo ou `global`. BIOS personalizadas também têm o hash revalidado no boot; a diferença é que a identidade/região foi atestada pelo usuário, não pelo catálogo.

### `save_states`

| Coluna                     | Tipo        | Nota                   |
| -------------------------- | ----------- | ---------------------- |
| `id`                       | TEXT PK     | UUID                   |
| `game_id`                  | TEXT FK     | CASCADE                |
| `slot`                     | INTEGER     | `CHECK 0..99`          |
| `state_path`               | TEXT UNIQUE | caminho canônico       |
| `size_bytes`               | INTEGER     | verificado após gravar |
| `core_id`                  | TEXT        | núcleo que gerou       |
| `created_at`, `updated_at` | TEXT        | histórico              |

`UNIQUE(game_id, slot)`. O caminho é regravado a cada save para garantir a regra:

```text
<dataRoot>/saves/<platform>/<sha1>/<slot>.state
```

### `play_sessions`

| Coluna                       | Tipo        | Nota                                      |
| ---------------------------- | ----------- | ----------------------------------------- |
| `id`                         | TEXT PK     | igual ao sessionId do core                |
| `game_id`                    | TEXT FK     | CASCADE                                   |
| `core_id`                    | TEXT        | núcleo                                    |
| `started_at`, `ended_at`     | TEXT        | ISO UTC                                   |
| `duration_seconds`           | INTEGER     | incrementos de 15 s                       |
| `hardcore`                   | INTEGER 0/1 | estado no início                          |
| `status`                     | TEXT        | `running`, `paused`, `stopped`, `crashed` |
| `exit_code`, `error_message` | —           | diagnóstico                               |

Índices por jogo/data e parcial para sessões ativas.

### `controller_profiles`

| Coluna          | Tipo        | Nota                                |
| --------------- | ----------- | ----------------------------------- |
| `id`            | TEXT PK     | UUID                                |
| `player_index`  | INTEGER     | `CHECK 1..4`, UNIQUE                |
| `name`          | TEXT        | rótulo                              |
| `api`           | TEXT        | `xinput`, `directinput`, `keyboard` |
| `hardware_guid` | TEXT UNIQUE | UUID reportado pelo SO              |
| `product_name`  | TEXT        | descrição                           |
| `is_valid`      | INTEGER     | 1 após validação                    |
| `mapping_json`  | TEXT        | botões/eixos                        |

O backend não cria perfil físico sem GUID válido. Teclado usa GUID fixo.

### `settings` e `secret_store`

- `settings(key PK, value_json, updated_at)`: preferências não sensíveis.
- `secret_store(name PK, ciphertext, updated_at)`: API keys e credenciais em AES-256-GCM (`v1:iv:tag:data` em base64).

Chaves usadas: `metadata.screenscraper`, `metadata.igdb`, `retroachievements.apiKey`.

### `scrape_cache`

`cache_key PK`, `provider`, `payload_json`, `expires_at`. TTL padrão de 14 dias; evita reconsultar a mesma ROM.

### `achievements`

`game_id`, `ra_achievement_id`, título, descrição, pontos, badge, `earned_at`, `hardcore`. `UNIQUE(game_id, ra_achievement_id)`.

### `logs`

`id`, `level`, `scope`, `message`, `meta_json`, `created_at`. Espelho em `<dataRoot>/logs/w3labs-YYYY-MM-DD.txt`.

## Consulta de biblioteca

```sql
SELECT g.*
FROM games g
JOIN platforms p ON p.id = g.platform_id
WHERE g.is_missing = 0
  AND (? = '' OR g.title LIKE ? COLLATE NOCASE
       OR g.genre LIKE ? COLLATE NOCASE
       OR p.name LIKE ? COLLATE NOCASE)
  AND (? IS NULL OR g.platform_id = ?)
ORDER BY g.favorite DESC, g.sort_title COLLATE NOCASE
LIMIT ? OFFSET ?;
```

O teste `database.test.js` mede essa listagem com 1.000 jogos e exige < 100 ms.

## Backup e consistência

- Fechar o app executa `PRAGMA wal_checkpoint(TRUNCATE)` antes de fechar a conexão.
- Backup a quente: copiar `w3labs.db`, `w3labs.db-wal` e `w3labs.db-shm` juntos, ou usar `VACUUM INTO`.
- Hashes de BIOS são revalidados no launch; se o arquivo mudar, o status vira `invalid`.
- Remover um jogo apaga a linha e os estados associados, mas nunca o arquivo ROM/ISO.
