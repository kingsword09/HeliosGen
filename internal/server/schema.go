package server

const schema = `
    CREATE TABLE IF NOT EXISTS shared_assets (
      id TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, media_type TEXT NOT NULL,
      source TEXT NOT NULL, title TEXT NOT NULL, prompt TEXT, model TEXT,
      tags TEXT NOT NULL DEFAULT '[]', favorite INTEGER NOT NULL DEFAULT 0,
      hidden INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS shared_asset_index (id TEXT PRIMARY KEY, updated_at TEXT);
    CREATE TABLE IF NOT EXISTS generations (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      task_id TEXT UNIQUE,
      generation_type TEXT,
      status TEXT,
      prompt TEXT, model TEXT, aspect_ratio TEXT, quality TEXT,
      azure_resolution TEXT, duration INTEGER, kling_mode TEXT, sound INTEGER,
      reference_image_urls TEXT,
      image_url TEXT, image_urls TEXT,
      video_url TEXT, error_msg TEXT,
      created_at TEXT, updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_gen_gallery
      ON generations (user_id, generation_type, status, created_at DESC);

    CREATE TABLE IF NOT EXISTS uploads (
      id TEXT PRIMARY KEY, user_id TEXT, r2_url TEXT, mime_type TEXT,
      source TEXT, created_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_uploads_user ON uploads (user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS asset_cache (
      hash TEXT PRIMARY KEY, cdn_url TEXT, mime_type TEXT, byte_size INTEGER
    );

    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

    CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY, user_id TEXT, name TEXT, parent_id TEXT,
      order_index INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT, color TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_folders_user ON folders (user_id, order_index);

    CREATE TABLE IF NOT EXISTS folder_items (
      folder_id TEXT, item_id TEXT, user_id TEXT, created_at TEXT,
      PRIMARY KEY (folder_id, item_id)
    );

    CREATE TABLE IF NOT EXISTS spaces (
      id TEXT PRIMARY KEY, name TEXT, data TEXT, updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS integration_jobs (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL, request_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL, request TEXT NOT NULL, state TEXT NOT NULL,
      task_id TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(client_id, request_id)
    );
    CREATE TABLE IF NOT EXISTS integration_assets (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL, url TEXT NOT NULL,
      mime_type TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS integration_job_reviews (
      job_id TEXT PRIMARY KEY REFERENCES integration_jobs(id) ON DELETE CASCADE,
      original_request TEXT NOT NULL, edited INTEGER NOT NULL DEFAULT 0,
      approved_at TEXT
    );
    CREATE TABLE IF NOT EXISTS integration_inbox_dismissals (
      job_id TEXT PRIMARY KEY REFERENCES integration_jobs(id) ON DELETE CASCADE,
      dismissed_at TEXT NOT NULL
    );
  `
