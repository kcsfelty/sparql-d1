CREATE TABLE IF NOT EXISTS rdf_quads (
  id INTEGER PRIMARY KEY,
  subject_key TEXT NOT NULL,
  subject_json TEXT NOT NULL,
  predicate_key TEXT NOT NULL,
  predicate_json TEXT NOT NULL,
  object_key TEXT NOT NULL,
  object_json TEXT NOT NULL,
  graph_key TEXT NOT NULL,
  graph_json TEXT NOT NULL,
  UNIQUE(subject_key, predicate_key, object_key, graph_key)
) STRICT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS rdf_quads_spog_idx
  ON rdf_quads(subject_key, predicate_key, object_key, graph_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS rdf_quads_pogs_idx
  ON rdf_quads(predicate_key, object_key, graph_key, subject_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS rdf_quads_ogsp_idx
  ON rdf_quads(object_key, graph_key, subject_key, predicate_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS rdf_quads_gspo_idx
  ON rdf_quads(graph_key, subject_key, predicate_key, object_key);
