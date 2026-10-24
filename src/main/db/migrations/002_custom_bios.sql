-- BIOS personalizada: fingerprint local atestado pelo usuário.
-- A integridade continua sendo revalidada por MD5/SHA-1 antes de cada boot.

ALTER TABLE bios_files ADD COLUMN is_custom INTEGER NOT NULL DEFAULT 0 CHECK (is_custom IN (0, 1));
ALTER TABLE bios_files ADD COLUMN verification_method TEXT NOT NULL DEFAULT 'catalog-md5';
