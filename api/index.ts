import type { VercelRequest, VercelResponse } from '@vercel/node';
import app from '../src/server.js';

// Let Express parse the incoming JSON stream instead of consuming it in Vercel first.
export const config = { api: { bodyParser: false } };

const expressHandler = app as unknown as (req: VercelRequest, res: VercelResponse) => unknown;

// vercel.json rewrites every /api/* request to this single function.
// Vercel keeps the original URL (e.g. /api/auth/login), so Express routes work as usual.
export default function handler(req: VercelRequest, res: VercelResponse) {
  return expressHandler(req, res);
}
