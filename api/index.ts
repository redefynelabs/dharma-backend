// Vercel serverless entry point
// Exports the Express app as a handler — Vercel calls this per request.
// NOTE: ChromaDB must be hosted externally (Railway / Render / VPS).
//       Set CHROMA_HOST + CHROMA_PORT in Vercel environment variables.

import { getFirebaseApp } from '../src/config/firebase';
import app from '../src/app';

// Eagerly initialise Firebase on cold start so the first request
// doesn't pay the initialisation cost.
getFirebaseApp();

export default app;
