import { unlink } from 'node:fs/promises';
import path from 'node:path';

const storageKeyPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$/i;

export async function cleanupDeletedPhotos({ db, uploadDir, logger = console }) {
  const { rows } = await db.query(`SELECT q.storage_key FROM photo_cleanup_queue q
    WHERE NOT EXISTS (SELECT 1 FROM photos p WHERE p.storage_key = q.storage_key)
    ORDER BY q.queued_at, q.storage_key LIMIT 100`);
  let removed = 0;
  let failed = 0;
  for (const { storage_key: key } of rows) {
    // Never turn a database value into an arbitrary filesystem deletion.
    if (!storageKeyPattern.test(key)) {
      failed++;
      logger.warn('Photo cleanup skipped an invalid storage key.');
      continue;
    }
    try {
      try { await unlink(path.join(path.resolve(uploadDir), key)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      // Missing files are also successful; a crash after unlink is safe to retry.
      await db.query('DELETE FROM photo_cleanup_queue WHERE storage_key = $1', [key]);
      removed++;
    } catch (error) {
      failed++;
      logger.warn('Photo cleanup will retry a failed file removal:', error.code ?? error.name);
    }
  }
  return { removed, failed };
}

export function startPhotoCleanup(options, intervalMs = 30000) {
  let pending;
  function run() {
    if (pending) return;
    pending = cleanupDeletedPhotos(options)
      .catch(error => (options.logger ?? console).warn('Photo cleanup will retry:', error.code ?? error.name))
      .finally(() => { pending = undefined; });
  }
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return async () => { clearInterval(timer); await pending; };
}
