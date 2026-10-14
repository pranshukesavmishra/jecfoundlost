const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const config = require('./config');

const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };

const upload = multer({
  storage: multer.diskStorage({
    destination: config.UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + EXT[file.mimetype]),
  }),
  limits: { fileSize: config.MAX_PHOTO_MB * 1024 * 1024, files: config.MAX_PHOTOS, fields: 30 },
  fileFilter: (req, file, cb) => {
    if (EXT[file.mimetype]) return cb(null, true);
    const err = new Error('Only JPG, PNG, WEBP or GIF photos are allowed.');
    err.userFacing = true;
    cb(err);
  },
});

// Check the file really is an image (first bytes), not just named like one.
function looksLikeImage(file) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(12);
  fs.readSync(fd, buf, 0, 12, 0);
  fs.closeSync(fd);
  return (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) // jpeg
    || buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) // png
    || (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP')
    || buf.toString('ascii', 0, 3) === 'GIF';
}

function removeFiles(files) {
  for (const f of files || []) fs.rm(path.join(config.UPLOAD_DIR, path.basename(f.filename || f)), { force: true }, () => {});
}

/**
 * Wraps multer so upload errors become a friendly message in req.uploadError instead of a crash,
 * and files that are not real images are dropped.
 */
function photos(field, max) {
  const mw = max === 1 ? upload.single(field) : upload.array(field, max);
  return (req, res, next) => {
    mw(req, res, (err) => {
      if (err) {
        req.uploadError = err.userFacing ? err.message
          : err.code === 'LIMIT_FILE_SIZE' ? `Each photo must be under ${config.MAX_PHOTO_MB} MB.`
          : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE' ? `You can upload at most ${max} photo(s).`
          : 'Photo upload failed.';
        removeFiles(req.files || (req.file ? [req.file] : []));
        req.files = [];
        req.file = undefined;
        req.body = req.body || {};
        return next();
      }
      const all = req.files || (req.file ? [req.file] : []);
      const bad = all.filter((f) => !looksLikeImage(f.path));
      if (bad.length) {
        removeFiles(all);
        req.uploadError = 'One of the files is not a valid image.';
        req.files = [];
        req.file = undefined;
      }
      next();
    });
  };
}

module.exports = { photos, removeFiles };
