-- Preserve old records. Only confirmed membership is visible.
ALTER TABLE gpt_chat ADD COLUMN project_id TEXT;
ALTER TABLE gpt_chat ADD COLUMN scope_observed_at TEXT NOT NULL DEFAULT '2023-01-01T00:00:00.000Z';
ALTER TABLE codex_chat ADD COLUMN project_id TEXT;
ALTER TABLE codex_chat ADD COLUMN scope_observed_at TEXT NOT NULL DEFAULT '2023-01-01T00:00:00.000Z';
UPDATE gpt_chat SET project_id='g-p-6ab08ead99b88191ab18129fe14730d9', scope_observed_at=observed_at
 WHERE substr(url,1,58)='https://chatgpt.com/g/g-p-6ab08ead99b88191ab18129fe14730d9' AND substr(url,59,1) IN ('/','-');
CREATE INDEX gpt_chat_project_observed ON gpt_chat(project_id, observed_at DESC);
CREATE INDEX codex_chat_project_observed ON codex_chat(project_id, observed_at DESC);
