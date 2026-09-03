import { Router } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const metadataRouter = Router();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, '..', '..', 'public', 'metadata');

/**
 * Serves token metadata as static JSON.
 *
 * Exists because reveal() sets a single base URI, so all 2,222 files must sit
 * under one address — they cannot be split across several IPFS CIDs the way
 * the images were. Hosting here sidesteps the file-count caps on IPFS free
 * tiers entirely, and setBaseURI can be repointed at IPFS later without
 * touching anything else.
 */
// Marketplaces send OPTIONS before GET on some paths.
metadataRouter.options('/:tokenId.json', (_req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.sendStatus(204);
});

metadataRouter.get('/:tokenId.json', (req, res) => {
  const id = Number(req.params.tokenId);

  if (!Number.isInteger(id) || id < 1 || id > 2222) {
    res.status(404).json({ error: 'Token not found' });
    return;
  }

  const file = path.join(DIR, `${id}.json`);
  if (!fs.existsSync(file)) {
    res.status(404).json({ error: 'Metadata not found' });
    return;
  }

  // Long cache: metadata is immutable once revealed, and marketplaces poll it
  // constantly. CORS open because any marketplace must be able to read it.
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.sendFile(file);
});

/** Quick check that the folder actually deployed with the right file count. */
metadataRouter.get('/status', (_req, res) => {
  const count = fs.existsSync(DIR)
    ? fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).length
    : 0;
  res.json({ files: count, expected: 2222, complete: count === 2222 });
});
