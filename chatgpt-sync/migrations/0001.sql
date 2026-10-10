-- ChatGPT metadata only. Never store message bodies, credentials or shared links.
CREATE TABLE IF NOT EXISTS gpt_chat (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  url TEXT NOT NULL CHECK (length(url) BETWEEN 50 AND 300),
  title TEXT NOT NULL DEFAULT '' CHECK (length(title) <= 120),
  observed_at TEXT NOT NULL CHECK (length(observed_at) = 24),
  memo TEXT NOT NULL DEFAULT '' CHECK (length(memo) <= 500 AND instr(CAST(memo AS BLOB), x'00') = 0),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  closed_at TEXT CHECK (closed_at IS NULL OR length(closed_at) = 24)
);
CREATE INDEX IF NOT EXISTS gpt_chat_observed_at ON gpt_chat(observed_at DESC);
CREATE TRIGGER IF NOT EXISTS gpt_chat_no_delete
BEFORE DELETE ON gpt_chat BEGIN SELECT RAISE(ABORT, 'records must not be deleted'); END;
CREATE TRIGGER IF NOT EXISTS gpt_chat_fixed_id
BEFORE UPDATE ON gpt_chat WHEN NEW.id IS NOT OLD.id
BEGIN SELECT RAISE(ABORT, 'chat identity is immutable'); END;
