# Memact Memory

Memory is the storage layer that keeps the context you have approved.

## What Memory Does

Memory acts as the database for your provider. It stores:
- Your approved context (the facts you accept or edit).
- The evidence chains showing which apps suggested what data and when.
- The age and decay status of each fact.
- Your review history (what you accepted, modified, or rejected).

## Core Responsibilities
- **Secure Persistence**: Holds approved statements securely.
- **Index & Retrieval**: Fast indexing to retrieve only relevant approved statements when queried by authorized apps.

## Database Persistence (PostgreSQL)
For production environments, Memact Memory provides a PostgreSQL adapter aligned with the V1 Supabase architecture.

### Setup
1. Run the database migration script located at `database/migration_v1.sql` to create the required `memact_memory_entries` and `memact_app_permissions` tables.
2. Initialize the adapter in your server code:
```javascript
import pg from 'pg';
import { createMemoryRepository } from 'memact-memory/storage';
import { createPostgresMemoryAdapter } from 'memact-memory/adapters/postgresql';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const memoryStore = createMemoryRepository(
  createPostgresMemoryAdapter({ pool, userId: 'user-uuid-here' })
);
```

## Local Backup and Restore

You can export approved memory entries to an AES-256-GCM encrypted JSON backup and restore them later. Only approved states (`active`, `accepted`, `approved`, `edited`, `user_verified`) are included. Pending, deleted, or forgotten entries are skipped.

The encryption key is read from these environment variables:
- `MEMACT_MEMORY_ENCRYPTION_KEY`: 32-byte key as base64 or 64-char hex (required).
- `MEMACT_MEMORY_ENCRYPTION_KEY_ID`: key identifier recorded in the envelope (optional, defaults to `primary`).

```sh
# Back up a memory store to an encrypted file
node ./scripts/memory-backup.mjs backup --store memory.json --out backup.json

# Restrict the export to specific states
node ./scripts/memory-backup.mjs backup --store memory.json --out backup.json --states approved,user_verified

# Restore a memory store from an encrypted backup
node ./scripts/memory-backup.mjs restore --in backup.json --out restored.json
```

These operations are also available programmatically through `backup-restore.mjs`.

## Vector Search & Embeddings OAuth

Memact Memory supports retrieving memories using hybrid semantic search. To securely integrate with enterprise embedding providers (like Azure OpenAI) and restrict search access, Memory implements an OAuth 2.0 Client Credentials flow.

### Inbound Authorization
When querying via the API or CLI, clients must provide a JWT containing either the `vector:search` or `vector:read` scope to access semantic capabilities.
```sh
node ./src/cli.mjs --query "startup execution" \
  --access-token "header.eyJzY29wZSI6InZlY3RvcjpzZWFyY2gifQ.sig"
```

### Outbound Authentication
You can configure Memory to acquire its own Bearer tokens dynamically to invoke external embedding models, eliminating the need to hardcode static API keys.
```sh
node ./src/cli.mjs --query "startup execution" \
  --oauth-client-id "client_123" \
  --oauth-client-secret "secret_456" \
  --oauth-endpoint "https://auth.enterprise.com/token" \
  --embedding-provider "azure"
```

## Development

To install and run tests:
```sh
npm install
npm test
```

## License

Memory is open source under the Apache 2.0 license.
