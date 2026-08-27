import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import type { Express } from 'express';
import { config } from '../config.js';

export function applySecurityMiddleware(app: Express): void {
  // helmet sets a batch of standard security headers (X-Content-Type-Options,
  // X-Frame-Options, a reasonable default CSP, etc.) - this API serves JSON
  // and SSE only, so most of helmet's browser-page-focused defaults are
  // harmless no-ops here, but cost nothing to leave on.
  app.use(helmet());
  app.use(compression());

  // Locks the API to your actual frontend's origin(s) only - a browser
  // running this app anywhere else can't call these endpoints at all.
  // Doesn't block curl/Postman/server-to-server calls (CORS is enforced by
  // browsers, not by this server) - that's expected and normal; it stops
  // OTHER WEBSITES from making authenticated-feeling requests using a
  // visitor's browser, which is what CORS is actually for.
  app.use(
    cors({
      origin: config.allowedOrigins,
      methods: ['GET', 'POST'], // GET for read-only routes, POST for access-code redemption
    })
  );
}
