import { Router } from 'express';
import { supabase } from '../supabase.js';

export const raffleShareRouter = Router();

const SITE = 'https://brokerz.homes';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Server-rendered share page for a single raffle.
 *
 * Twitter's crawler does not run JavaScript, so a client-rendered SPA serves
 * the same meta tags for every URL — every shared raffle would show the
 * generic site card instead of that project's banner. Slugs are dynamic, so
 * static files are not an option either. This renders the tags per raffle and
 * sends real visitors on to the app.
 */
raffleShareRouter.get('/:slug', async (req, res) => {
  const { slug } = req.params;

  const { data: r } = await supabase
    .from('raffle_public')
    .select('slug, project_name, project_description, banner_url, logo_url, spots, kind, status, ends_at')
    .eq('slug', slug)
    .maybeSingle();

  const target = `${SITE}/?raffle=${encodeURIComponent(slug)}`;

  if (!r) {
    res.status(404).send(
      `<!doctype html><meta charset="utf-8">
       <meta http-equiv="refresh" content="0; url=${SITE}">
       <p>Raffle not found. <a href="${SITE}">Go to Brokerz Homes</a></p>`
    );
    return;
  }

  const kindLabel =
    r.kind === 'nft_holder' ? 'Brokerz Homes holders raffle'
    : r.kind === 'brkz_entry' ? 'Enter with $BRKZ'
    : 'Guaranteed spots, first come first served';

  const title = `${r.project_name} — ${r.spots} whitelist spots | Brokerz Rafflor`;
  const desc = r.project_description
    ? String(r.project_description).slice(0, 180)
    : `${kindLabel}. ${r.spots} whitelist spots up for grabs on Brokerz Rafflor.`;
  const image = r.banner_url || r.logo_url || `${SITE}/social-card.png`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}" />
<link rel="canonical" href="${SITE}/raffle/${esc(slug)}" />

<meta property="og:type" content="website" />
<meta property="og:site_name" content="Brokerz Rafflor" />
<meta property="og:url" content="${SITE}/raffle/${esc(slug)}" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(desc)}" />
<meta property="og:image" content="${esc(image)}" />
<meta property="og:image:alt" content="${esc(r.project_name)}" />

<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:site" content="@BrokerzHomesNFT" />
<meta name="twitter:title" content="${esc(title)}" />
<meta name="twitter:description" content="${esc(desc)}" />
<meta name="twitter:image" content="${esc(image)}" />
<meta name="twitter:image:src" content="${esc(image)}" />

<script>window.location.replace(${JSON.stringify(target)});</script>
<noscript><meta http-equiv="refresh" content="0; url=${target}" /></noscript>
</head>
<body style="background:#030504;color:#00ff7f;font-family:monospace;padding:24px">
  Opening ${esc(r.project_name)}… <a href="${target}" style="color:#00e5ff">continue</a>
</body>
</html>`);
});
