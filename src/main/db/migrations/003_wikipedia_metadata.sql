-- Procedência dos metadados: permite exibir a fonte e abrir o artigo original.
ALTER TABLE games ADD COLUMN metadata_source TEXT;
ALTER TABLE games ADD COLUMN metadata_url TEXT;

CREATE INDEX IF NOT EXISTS idx_games_metadata_source ON games(metadata_source);
