-- Additive napplet namespaces in the existing NStack authority database.
CREATE TABLE IF NOT EXISTS flightdeck_pg_napplets (
 workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
 app_npub TEXT NOT NULL, napplet_id TEXT COLLATE "C" NOT NULL,
 owner_npub TEXT NOT NULL, publisher_npub TEXT NOT NULL,
 display_name TEXT NOT NULL, audience_npubs JSONB NOT NULL,
 bundle JSONB NOT NULL, manifest JSONB NOT NULL, pending_release JSONB,
 revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
 removed BOOLEAN NOT NULL DEFAULT false,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY (workspace_id, app_npub, napplet_id)
);
CREATE TABLE IF NOT EXISTS flightdeck_pg_napplet_releases (
 workspace_id UUID NOT NULL, app_npub TEXT NOT NULL, napplet_id TEXT COLLATE "C" NOT NULL,
 revision INTEGER NOT NULL, bundle JSONB NOT NULL, manifest JSONB NOT NULL,
 publisher_npub TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY (workspace_id, app_npub, napplet_id, revision),
 FOREIGN KEY (workspace_id,app_npub,napplet_id) REFERENCES flightdeck_pg_napplets ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS flightdeck_pg_napplet_collections (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id UUID NOT NULL, app_npub TEXT NOT NULL, napplet_id TEXT COLLATE "C" NOT NULL,
 name TEXT NOT NULL, scope TEXT NOT NULL CHECK (scope IN ('personal','team')),
 owner_npub TEXT NOT NULL, read_npubs JSONB NOT NULL DEFAULT '[]', write_npubs JSONB NOT NULL DEFAULT '[]',
 schema_version INTEGER NOT NULL CHECK (schema_version > 0), revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY (workspace_id,app_npub,napplet_id) REFERENCES flightdeck_pg_napplets ON DELETE CASCADE,
 UNIQUE(workspace_id,app_npub,napplet_id,name,scope,owner_npub)
);
CREATE TABLE IF NOT EXISTS flightdeck_pg_napplet_records (
 collection_id UUID NOT NULL REFERENCES flightdeck_pg_napplet_collections(id) ON DELETE CASCADE,
 id TEXT COLLATE "C" NOT NULL, revision INTEGER NOT NULL CHECK (revision > 0),
 schema_version INTEGER NOT NULL CHECK (schema_version > 0), data JSONB,
 deleted BOOLEAN NOT NULL DEFAULT false, provenance JSONB,
 updated_by_npub TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(collection_id,id)
);
CREATE TABLE IF NOT EXISTS flightdeck_pg_napplet_record_versions (
 collection_id UUID NOT NULL, id TEXT COLLATE "C" NOT NULL, revision INTEGER NOT NULL,
 schema_version INTEGER NOT NULL, data JSONB, deleted BOOLEAN NOT NULL, provenance JSONB,
 updated_by_npub TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
 PRIMARY KEY(collection_id,id,revision),
 FOREIGN KEY(collection_id,id) REFERENCES flightdeck_pg_napplet_records ON DELETE CASCADE
);
