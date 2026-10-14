const { db } = require('./db');

const PAGE_SIZE = 24;

const COVER = '(SELECT filename FROM photos p WHERE p.item_id = i.id ORDER BY p.id LIMIT 1)';

/** Public listing with search + filters. */
function listItems({ q, type, category, status = 'open', page = 1 }) {
  const where = [];
  const params = [];
  if (['open', 'resolved', 'closed', 'expired'].includes(status)) {
    where.push('i.status = ?');
    params.push(status);
  }
  if (type === 'lost' || type === 'found') {
    where.push('i.type = ?');
    params.push(type);
  }
  if (category) {
    where.push('i.category = ?');
    params.push(category);
  }
  if (q && q.trim()) {
    const like = `%${q.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    where.push("(i.title LIKE ? ESCAPE '\\' OR i.description LIKE ? ESCAPE '\\' OR i.location LIKE ? ESCAPE '\\' OR i.category LIKE ? ESCAPE '\\')");
    params.push(like, like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) n FROM items i ${clause}`).get(...params).n;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const current = Math.min(Math.max(1, Number(page) || 1), pages);
  const rows = db.prepare(`
    SELECT i.*, ${COVER} AS photo, u.name AS poster_name, u.department AS poster_department,
           (SELECT COUNT(*) FROM responses r WHERE r.item_id = i.id AND r.status != 'withdrawn') AS response_count
    FROM items i JOIN users u ON u.id = i.user_id
    ${clause}
    ORDER BY i.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, PAGE_SIZE, (current - 1) * PAGE_SIZE);
  return { items: rows, total, page: current, pages };
}

function getItem(id) {
  const item = db.prepare(`
    SELECT i.*, u.name AS poster_name, u.department AS poster_department, u.phone AS poster_phone
    FROM items i JOIN users u ON u.id = i.user_id WHERE i.id = ?
  `).get(id);
  if (!item) return null;
  item.photos = db.prepare('SELECT filename FROM photos WHERE item_id = ? ORDER BY id').all(id).map((p) => p.filename);
  return item;
}

function getResponses(itemId) {
  return db.prepare(`
    SELECT r.*, u.name AS responder_name, u.department AS responder_department, u.phone AS responder_phone
    FROM responses r JOIN users u ON u.id = r.user_id
    WHERE r.item_id = ? ORDER BY r.created_at DESC
  `).all(itemId);
}

function stats() {
  return db.prepare(`
    SELECT
      SUM(status = 'open' AND type = 'lost')  AS open_lost,
      SUM(status = 'open' AND type = 'found') AS open_found,
      SUM(status = 'resolved')                AS returned
    FROM items
  `).get();
}

function userItems(userId) {
  return db.prepare(`
    SELECT i.*, ${COVER} AS photo,
      (SELECT COUNT(*) FROM responses r WHERE r.item_id = i.id AND r.status = 'pending') AS pending_count
    FROM items i WHERE i.user_id = ? ORDER BY i.created_at DESC
  `).all(userId);
}

function userResponses(userId) {
  return db.prepare(`
    SELECT r.*, i.title, i.type, i.status AS item_status, ${COVER} AS photo
    FROM responses r JOIN items i ON i.id = r.item_id
    WHERE r.user_id = ? ORDER BY r.created_at DESC
  `).all(userId);
}

module.exports = { listItems, getItem, getResponses, stats, userItems, userResponses, PAGE_SIZE };
