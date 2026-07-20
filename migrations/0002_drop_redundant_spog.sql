-- The UNIQUE constraint already owns the identical SPOG covering index.
DROP INDEX IF EXISTS rdf_quads_spog_idx;

-- Ephemeral transaction guards support optimistic quad-patch preconditions.
CREATE TABLE IF NOT EXISTS rdf_patch_guards (
  patch_id TEXT PRIMARY KEY
) STRICT;
