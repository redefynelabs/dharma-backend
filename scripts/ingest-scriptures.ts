/**
 * Scripture Ingestion Script
 *
 * Populates ChromaDB collections from the dharma/data JSON files.
 *
 * Usage:
 *   npx tsx scripts/ingest-scriptures.ts
 *   npx tsx scripts/ingest-scriptures.ts --scripture=gita
 */

import { ChromaClient, Collection, DefaultEmbeddingFunction } from 'chromadb';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const CHROMA_HOST = process.env.CHROMA_HOST ?? 'localhost';
const CHROMA_PORT = Number(process.env.CHROMA_PORT ?? 8000);

// Data files live in dharma/data/ relative to the monorepo root
// const DATA_DIR = path.join(__dirname, '..', '..', 'dharma', 'data');
const DATA_DIR = path.join(process.cwd(), 'data');

const client = new ChromaClient({ path: `http://${CHROMA_HOST}:${CHROMA_PORT}` });
const embedFn = new DefaultEmbeddingFunction();

// ─── Helpers ──────────────────────────────────────────

function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

async function getCollection(name: string): Promise<Collection> {
  return client.getOrCreateCollection({
    name,
    embeddingFunction: embedFn,
    metadata: { 'hnsw:space': 'cosine' },
  });
}

// ─── Gita ─────────────────────────────────────────────

interface GitaVerse {
  id: string;
  chapter: number;
  verse: number;
  reference: string;
  sanskrit: string;
  transliteration: string;
  english: string;
  hindi: string;
  word_meaning: string;
}

async function ingestGita(collection: Collection): Promise<void> {
  const filePath = path.join(DATA_DIR, 'bhagavad_gita.json');
  if (!fs.existsSync(filePath)) { console.warn('⚠️  bhagavad_gita.json not found'); return; }

  const verses: GitaVerse[] = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const batches = chunk(verses, 50);
  let count = 0;

  for (const batch of batches) {
    await collection.upsert({
      ids: batch.map((v) => v.id),
      documents: batch.map((v) =>
        [v.english, v.word_meaning, v.transliteration].filter(Boolean).join('\n')
      ),
      metadatas: batch.map((v) => ({
        scripture: 'gita',
        reference: v.reference,
        chapter: v.chapter,
        verse: v.verse,
        translation: v.english.substring(0, 500),
      })),
    });
    count += batch.length;
    process.stdout.write(`\r  Gita: ${count}/${verses.length}`);
  }
  console.log(`\n✅ Gita: ${verses.length} verses`);
}

// ─── Ramayana ─────────────────────────────────────────

interface RamayanaVerse {
  id: string;
  kanda: string;
  kanda_number: number;
  sarga: number;
  verse: number;
  reference: string;
  sanskrit: string;
  transliteration: string;
  english: string;
  word_meaning: string;
  commentary: string;
}

async function ingestRamayana(collection: Collection): Promise<void> {
  const filePath = path.join(DATA_DIR, 'ramayana.json');
  if (!fs.existsSync(filePath)) { console.warn('⚠️  ramayana.json not found'); return; }

  const verses: RamayanaVerse[] = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const batches = chunk(verses, 50);
  let count = 0;

  for (const batch of batches) {
    await collection.upsert({
      ids: batch.map((v) => v.id),
      documents: batch.map((v) =>
        [v.english, v.word_meaning, v.commentary].filter(Boolean).join('\n')
      ),
      metadatas: batch.map((v) => ({
        scripture: 'ramayana',
        reference: v.reference,
        kanda: v.kanda,
        kanda_number: v.kanda_number,
        sarga: v.sarga,
        verse: v.verse,
        translation: v.english.substring(0, 500),
      })),
    });
    count += batch.length;
    process.stdout.write(`\r  Ramayana: ${count}/${verses.length}`);
  }
  console.log(`\n✅ Ramayana: ${verses.length} verses`);
}

// ─── Mahabharata ──────────────────────────────────────

interface MahabharataVerse {
  id: string;
  parva: string;
  parva_number: number;
  chapter: number;
  verse: number;
  reference: string;
  sanskrit: string;
  transliteration: string;
  english: string;
  hindi: string;
  commentary: string;
}

async function ingestMahabharata(collection: Collection): Promise<void> {
  const filePath = path.join(DATA_DIR, 'mahabharata.json');
  if (!fs.existsSync(filePath)) { console.warn('⚠️  mahabharata.json not found'); return; }

  const verses: MahabharataVerse[] = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

  // Deduplicate IDs that appear more than once in the source data
  const seenIds = new Set<string>();
  const deduped = verses.map((v) => {
    let id = v.id;
    if (seenIds.has(id)) id = `${id}_${v.parva_number}_${v.chapter}_${v.verse}_dup`;
    seenIds.add(id);
    return { ...v, id };
  });

  const batches = chunk(deduped, 50);
  let count = 0;

  for (const batch of batches) {
    await collection.upsert({
      ids: batch.map((v) => v.id),
      documents: batch.map((v) =>
        [v.english, v.hindi, v.commentary].filter(Boolean).join('\n')
      ),
      metadatas: batch.map((v) => ({
        scripture: 'mahabharata',
        reference: v.reference,
        parva: v.parva,
        parva_number: v.parva_number,
        chapter: v.chapter,
        verse: v.verse,
        translation: v.english.substring(0, 500),
      })),
    });
    count += batch.length;
    process.stdout.write(`\r  Mahabharata: ${count}/${verses.length}`);
  }
  console.log(`\n✅ Mahabharata: ${verses.length} verses`);
}

// ─── Main ─────────────────────────────────────────────

async function main() {
  const target = process.argv.find((a) => a.startsWith('--scripture='))?.split('=')[1];

  console.log(`🔌 Connecting to ChromaDB at ${CHROMA_HOST}:${CHROMA_PORT}...`);

  const gitaName = process.env.CHROMA_COLLECTION_GITA ?? 'bhagavad_gita';
  const ramayanaName = process.env.CHROMA_COLLECTION_RAMAYANA ?? 'ramayana';
  const mbhName = process.env.CHROMA_COLLECTION_MAHABHARATA ?? 'mahabharata';

  if (!target || target === 'gita') {
    console.log(`📖 Ingesting Gita → ${gitaName}`);
    await ingestGita(await getCollection(gitaName));
  }
  if (!target || target === 'ramayana') {
    console.log(`📖 Ingesting Ramayana → ${ramayanaName}`);
    await ingestRamayana(await getCollection(ramayanaName));
  }
  if (!target || target === 'mahabharata') {
    console.log(`📖 Ingesting Mahabharata → ${mbhName}`);
    await ingestMahabharata(await getCollection(mbhName));
  }

  console.log('\n🕉️  Scripture ingestion complete');
}

main().catch((err) => {
  console.error('Ingestion failed:', err);
  process.exit(1);
});
