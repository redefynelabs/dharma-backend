# ChromaDB Scripture Ingestion

## Overview

Dharma uses ChromaDB as a vector store for RAG (Retrieval-Augmented Generation). Scripture verses are embedded using `chromadb-default-embed` (all-MiniLM-L6-v2, 384-dimensional vectors) and stored in three collections. At query time, the user's question is embedded with the same model and the closest matching verses are retrieved and passed to Claude as context.

---

## Architecture

```
dharma/data/*.json  →  ingest-scriptures.ts  →  ChromaDB (Docker)
                               ↓
                    DefaultEmbeddingFunction
                    (all-MiniLM-L6-v2, 384d)
                               ↓
                   ┌───────────────────────┐
                   │  bhagavad_gita        │  701 verses
                   │  ramayana             │  23,402 verses
                   │  mahabharata          │  73,452 verses
                   └───────────────────────┘
                               ↓
                    rag.service.ts  →  Claude API
```

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | ≥ 18 | Required for tsx |
| Docker | any | Runs ChromaDB container |
| `chromadb` npm package | 1.10.5 | Client library |
| `chromadb-default-embed` | latest | Local embedding model |

---

## ChromaDB Docker Setup

ChromaDB runs as a Docker container defined in `docker-compose.yaml`:

```bash
# Start ChromaDB
docker compose up chromadb -d

# Verify it's running
curl http://localhost:8000/api/v2
# → {"nanosecond heartbeat": ...}
```

**Important:** The ChromaDB server (v1.4.1+) uses the `/api/v2/` endpoints. The healthcheck in `docker-compose.yaml` uses the deprecated `/api/v1/heartbeat` — this causes the container to show as `(unhealthy)` in `docker ps` but the server works correctly. The npm client connects fine.

---

## Collections

| Collection | Env var | Scripture | Verses | Embedding dim |
|---|---|---|---|---|
| `bhagavad_gita` | `CHROMA_COLLECTION_GITA` | Bhagavad Gita | 701 | 384 |
| `ramayana` | `CHROMA_COLLECTION_RAMAYANA` | Valmiki Ramayana | 23,402 | 384 |
| `mahabharata` | `CHROMA_COLLECTION_MAHABHARATA` | Mahabharata | 73,452 | 384 |

All collections use **cosine similarity** (`hnsw:space: cosine`).

Each document stored in ChromaDB is a concatenation of:
- **Gita**: `english + word_meaning + transliteration`
- **Ramayana**: `english + word_meaning + commentary`
- **Mahabharata**: `english + hindi + commentary`

---

## Running the Ingestion

> **One-time setup** — only needs to be re-run if the source JSON data changes.

### All three scriptures

```bash
cd dharma-backend
npx tsx scripts/ingest-scriptures.ts
```

### Single scripture

```bash
npx tsx scripts/ingest-scriptures.ts --scripture=gita
npx tsx scripts/ingest-scriptures.ts --scripture=ramayana
npx tsx scripts/ingest-scriptures.ts --scripture=mahabharata
```

### Expected output

```
🔌 Connecting to ChromaDB at localhost:8000...
📖 Ingesting Gita → bhagavad_gita
  Gita: 701/701
✅ Gita: 701 verses
📖 Ingesting Ramayana → ramayana
  Ramayana: 23402/23402
✅ Ramayana: 23402 verses
📖 Ingesting Mahabharata → mahabharata
  Mahabharata: 73452/73452
✅ Mahabharata: 73452 verses

🕉️  Scripture ingestion complete
```

### Estimated time

| Scripture | Verses | Approx. time |
|---|---|---|
| Gita | 701 | ~2 min |
| Ramayana | 23,402 | ~25–35 min |
| Mahabharata | 73,452 | ~70–90 min |

Times depend on CPU speed — the embedding model runs locally via ONNX Runtime.

---

## Data Source

Source JSON files live in `dharma/data/` (the mobile app's data directory):

| File | Size | Used for |
|---|---|---|
| `dharma/data/bhagavad_gita.json` | 2.1 MB | Gita ingestion |
| `dharma/data/ramayana.json` | 31 MB | Ramayana ingestion |
| `dharma/data/mahabharata.json` | 80 MB | Mahabharata ingestion |

The ingest script resolves the path as `../../dharma/data` relative to `dharma-backend/`.

### Source JSON fields

**Gita** (`bhagavad_gita.json`):
```json
{
  "id": "gita_1_1",
  "book": "gita",
  "chapter": 1,
  "verse": 1,
  "reference": "BG 1.1",
  "sanskrit": "...",
  "transliteration": "...",
  "english": "...",
  "hindi": "...",
  "word_meaning": "..."
}
```

**Ramayana** (`ramayana.json`):
```json
{
  "id": "ramayana_bala_kanda_1_1",
  "kanda": "Bala Kanda",
  "kanda_number": 1,
  "sarga": 1,
  "verse": 1,
  "reference": "...",
  "english": "...",
  "word_meaning": "...",
  "commentary": "..."
}
```

**Mahabharata** (`mahabharata.json`):
```json
{
  "id": "mahabharata_adi_parva_1_1",
  "parva": "Ādi Parva",
  "parva_number": 1,
  "chapter": 1,
  "verse": 1,
  "reference": "...",
  "english": "...",
  "hindi": "...",
  "commentary": "..."
}
```

> **Note:** The Mahabharata source data contains one duplicate ID (`mahabharata_adi_parva_1_1`). The ingest script deduplicates automatically by appending `_dup` to the second occurrence.

---

## Environment Variables

Defined in `.env`:

```env
CHROMA_HOST=localhost
CHROMA_PORT=8000

CHROMA_COLLECTION_GITA=bhagavad_gita
CHROMA_COLLECTION_RAMAYANA=ramayana
CHROMA_COLLECTION_MAHABHARATA=mahabharata
```

---

## How RAG Queries Work

At runtime (`src/modules/ai/rag.service.ts`):

1. User sends a question via `POST /api/v1/chat/sessions/:id/ask`
2. `retrieveRelevantChunks()` embeds the question using `DefaultEmbeddingFunction`
3. ChromaDB returns the top-K most similar verses (cosine similarity, default K=6)
4. Chunks with score > 0.6 are passed as context to Claude (`claude-opus-4-5`)
5. Claude generates a grounded answer citing specific scripture references

The same `DefaultEmbeddingFunction` must be used for both ingestion and querying — mixing different embedding models will produce incorrect similarity scores.

---

## Verifying Collections

Check that collections are populated:

```bash
# List collections with dimensions
curl -s "http://localhost:8000/api/v2/tenants/default_tenant/databases/default_database/collections" \
  | python3 -c "import json,sys; [print(c['name'], '— dim:', c['dimension']) for c in json.load(sys.stdin)]"

# Expected after full ingestion:
# bhagavad_gita — dim: 384
# ramayana — dim: 384
# mahabharata — dim: 384
```

`dimension: null` means the collection exists but has no data — run ingestion.

---

## Troubleshooting

### `Please install chromadb-default-embed`
```bash
npm install chromadb-default-embed
```
Then restart the backend.

### `ID's must be unique, found duplicates`
The source data has a duplicate `id` field. The ingest script handles this automatically for the Mahabharata. For other collections, inspect the JSON:
```bash
python3 -c "
import json
from collections import Counter
data = json.load(open('path/to/file.json'))
dups = {k:v for k,v in Counter(d['id'] for d in data).items() if v > 1}
print(dups)
"
```

### `Firestore has already been initialized`
The `getFirestore()` function in `src/config/firebase.ts` was not a singleton. Fixed — it now caches the instance and only calls `settings()` once.

### ChromaDB container is `(unhealthy)`
The Docker healthcheck uses the deprecated v1 API (`/api/v1/heartbeat`). The server works correctly — the unhealthy status is a false alarm. Verify with:
```bash
curl http://localhost:8000/api/v2
```
