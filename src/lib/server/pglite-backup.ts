import { createHash, timingSafeEqual } from 'node:crypto';

/** Construct once per server process. Not mounted by any application route yet. */
export function createPgliteBackupHandler(options: {
  enabled: boolean;
  token: string;
  getDatabase: () => Promise<{ dumpDataDir(): Promise<Blob> }>;
}) {
  let exporting = false;
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  return async (request: Request, peer: string | undefined): Promise<Response> => {
    const reject = (status: number) => Response.json({ error: 'backup_unavailable' }, { status, headers });
    if (!options.enabled || options.token.length < 32) return reject(404);
    const url = new URL(request.url);
    if (!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(peer ?? '') ||
        !['127.0.0.1','localhost','[::1]'].includes(url.hostname) ||
        request.headers.get('origin') !== url.origin) return reject(403);
    if (request.method !== 'POST') return reject(405);
    const supplied = Buffer.from(request.headers.get('x-loom-backup-token') ?? '');
    const expected = Buffer.from(options.token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return reject(403);
    // No request body, SQL, path, or database selector is accepted.
    if (request.body !== null || url.search) return reject(400);
    if (exporting) return reject(409);
    exporting = true;
    try {
      const db = await options.getDatabase();
      const bytes = new Uint8Array(await (await db.dumpDataDir()).arrayBuffer());
      return new Response(bytes, { headers: {
        ...headers,
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="loom-pglite-backup.bin"',
        'Content-Length': String(bytes.byteLength),
        'X-Backup-SHA256': createHash('sha256').update(bytes).digest('hex'),
      } });
    } catch {
      return reject(500);
    } finally { exporting = false; }
  };
}
