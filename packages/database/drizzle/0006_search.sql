-- Full-text search (ADR-012). Generated tsvector columns + GIN indexes.
-- The 'simple' configuration avoids language-specific stemming so names and codes match predictably
-- across languages; ranking still favours title matches (weight A) over body text (weight B).
-- These columns are managed here, not in the Drizzle schema, and are never written by the app.
ALTER TABLE projects ADD COLUMN search tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('simple', coalesce(name, '')), 'A') ||
  setweight(to_tsvector('simple', coalesce(objective, '') || ' ' || coalesce(description, '')), 'B')
) STORED;
--> statement-breakpoint
CREATE INDEX projects_search_idx ON projects USING gin (search);
--> statement-breakpoint
ALTER TABLE tasks ADD COLUMN search tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
  setweight(to_tsvector('simple', coalesce(description, '')), 'B')
) STORED;
--> statement-breakpoint
CREATE INDEX tasks_search_idx ON tasks USING gin (search);
--> statement-breakpoint
ALTER TABLE comments ADD COLUMN search tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('simple', regexp_replace(coalesce(body, ''), '<@[0-9a-fA-F-]{36}>', ' ', 'g')), 'B')
) STORED;
--> statement-breakpoint
CREATE INDEX comments_search_idx ON comments USING gin (search);
