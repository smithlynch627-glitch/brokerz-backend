import { Router } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const showcaseRouter = Router();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, '..', '..', 'public', 'metadata');

const GATEWAY = 'https://cloudflare-ipfs.com/ipfs/';

/**
 * Sample token images for the landing page gallery.
 *
 * Reads each token's own metadata rather than assuming a single CID — the
 * collection is spread across ten-plus IPFS folders, so a hardcoded CID only
 * ever resolves for the tokens inside it and silently breaks the rest.
 */
showcaseRouter.get('/showcase', (req, res) => {
  const count = Math.min(Number(req.query.count) || 24, 60);

  if (!fs.existsSync(DIR)) { res.json({ items: [] }); return; }

  // Spread the picks across the whole range so the gallery is not all
  // early tokens from one folder.
  const step = Math.max(1, Math.floor(2222 / count));
  const items: Array<{ tokenId: number; image: string }> = [];

  for (let i = 0; i < count; i++) {
    const tokenId = 1 + i * step + Math.floor(Math.random() * Math.min(step, 12));
    if (tokenId > 2222) break;

    const file = path.join(DIR, `${tokenId}.json`);
    if (!fs.existsSync(file)) continue;

    try {
      const meta = JSON.parse(fs.readFileSync(file, 'utf8')) as { image?: string };
      if (!meta.image) continue;
      items.push({
        tokenId,
        image: meta.image.startsWith('ipfs://')
          ? GATEWAY + meta.image.slice('ipfs://'.length)
          : meta.image,
      });
    } catch {
      continue;
    }
  }

  res.setHeader('Cache-Control', 'public, max-age=600');
  res.json({ items });
});
