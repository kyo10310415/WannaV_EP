require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../src/config/database');
const storage = require('../src/services/objectStorage');
const media = require('../src/services/lessonMedia');

async function localFile(root, filename) {
  if (!filename || path.basename(filename) !== filename || filename === 'external') throw new Error('Invalid local filename');
  const base = await fs.promises.realpath(root);
  const target = path.resolve(base,filename);
  if (path.dirname(target) !== base) throw new Error('File outside upload directory');
  const stat = await fs.promises.lstat(target);
  if (stat.isSymbolicLink() || !stat.isFile() || await fs.promises.realpath(target) !== target) throw new Error('Not a regular local file');
  return { target, size:stat.size };
}

async function migrate({ apply = false, images = false, deleteLocal = false,
  root = process.env.UPLOAD_DIR || path.join(__dirname,'../uploads'), log = console.log } = {}) {
  if (deleteLocal && !apply) throw new Error('--delete-local requires --apply');
  if (apply && !storage.enabled()) throw new Error('Enable object storage before migration');
  const lessons = (await db.query('SELECT * FROM lessons ORDER BY id')).rows;
  const result = { migrated:0, skipped:0, failed:0, deleted:0, dryRun:!apply };
  for (const lesson of lessons) {
    const kind = lesson.content_type === 'image' ? 'image' : 'video';
    if ((kind === 'image' && !images) || !['video','image'].includes(lesson.content_type) ||
        !lesson[`${kind}_url`]?.startsWith('/uploads/') || lesson[`${kind}_filename`] === 'external') { result.skipped++; continue; }
    let uploaded;
    try {
      let objectKey = lesson[`${kind}_storage_key`];
      if (objectKey && !deleteLocal) { result.skipped++; log(`lesson ${lesson.id}: already migrated, skip`); continue; }
      const file = await localFile(root,lesson[`${kind}_filename`]);
      log(`lesson ${lesson.id}: ${kind}, ${file.size} bytes, ${apply ? 'apply' : 'dry-run'}`);
      if (!apply) continue;
      if (!objectKey) {
        uploaded = storage.key(kind,lesson[`${kind}_filename`]);
        await storage.upload(file.target,uploaded);
        const saved = await db.query(`UPDATE lessons SET ${kind}_storage_key = $1, updated_at = CURRENT_TIMESTAMP
          WHERE id = $2 AND ${kind}_storage_key IS NULL AND ${kind}_filename = $3 RETURNING *`,
        [uploaded,lesson.id,lesson[`${kind}_filename`]]);
        if (!saved.rows.length) { await media.discard([uploaded]); result.skipped++; continue; }
        objectKey = uploaded;
        result.migrated++;
      } else result.skipped++;
      if (deleteLocal) {
        await storage.verify(objectKey,file.size);
        const current = (await db.query(`SELECT * FROM lessons WHERE id = $1`,[lesson.id])).rows[0];
        if (current?.[`${kind}_storage_key`] !== objectKey || current?.[`${kind}_filename`] !== lesson[`${kind}_filename`]) throw new Error('Lesson changed; local deletion aborted');
        const checked = await localFile(root,lesson[`${kind}_filename`]);
        if (checked.size !== file.size) throw new Error('Local file changed; deletion aborted');
        await fs.promises.unlink(checked.target);
        result.deleted++;
      }
    } catch (_) {
      if (uploaded) await media.discard([uploaded]);
      result.failed++;
      log(`lesson ${lesson.id}: failed; retained local file, check configuration/file/DB`);
    }
  }
  log(JSON.stringify(result));
  return result;
}
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--apply','--dry-run','--images','--delete-local'].includes(arg)) || (args.includes('--apply') && args.includes('--dry-run'))) {
    console.error('Usage: node scripts/migrate-media-to-object-storage.js [--dry-run | --apply] [--images] [--delete-local]');
    process.exitCode = 1;
    void db.pool.end();
  } else {
    migrate({ apply:args.includes('--apply'), images:args.includes('--images'), deleteLocal:args.includes('--delete-local') })
      .then(result => { if (result.failed) process.exitCode = 1; })
      .catch(() => { console.error('Migration aborted; check configuration. No local deletion unless explicitly requested.'); process.exitCode = 1; })
      .finally(() => db.pool.end());
  }
}
module.exports = { migrate, localFile };
