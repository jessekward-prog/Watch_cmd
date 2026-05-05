const { Pool } = require('pg');

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

async function init() {
  if (!pool) { console.log('[DB] No DATABASE_URL — watch history disabled'); return; }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS watch_history (
      id           SERIAL       PRIMARY KEY,
      tmdb_id      INTEGER      NOT NULL,
      media_type   VARCHAR(10)  NOT NULL,
      title        TEXT         NOT NULL,
      poster_path  TEXT,
      progress     FLOAT        NOT NULL DEFAULT 0,
      position_sec INTEGER      NOT NULL DEFAULT 0,
      duration_sec INTEGER      NOT NULL DEFAULT 0,
      watched      BOOLEAN      NOT NULL DEFAULT FALSE,
      season       INTEGER      NOT NULL DEFAULT -1,
      episode      INTEGER      NOT NULL DEFAULT -1,
      updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      UNIQUE (tmdb_id, media_type, season, episode)
    )
  `);
  console.log('[DB] watch_history ready');
}

module.exports = { pool, init };
