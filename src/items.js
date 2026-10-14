const { db } = require('./db');

const PAGE_SIZE = 24;

const COVER = '(SELECT filename FROM photos p WHERE p.item_id = i.id ORDER BY p.id LIMIT 1)';

/** Escape a user search term for LIKE (works the same in SQLite and Postgres). */
const likeTerm = (q) => `%${q.trim().toLowerCase().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;

/** Public listing with search + filters. */
async function listItems({ q, type, category, status = 'open', page = 1 }) {
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
    const like = likeTerm(q);
    where.push(`(LOWER(i.title) LIKE ? ESCAPE '\\' OR LOWER(i.description) LIKE ? ESCAPE '\\'
              OR LOWER(i.location) LIKE ? ESCAPE '\\' OR LOWER(i.category) LIKE ? ESCAPE '\\')`);
    params.push(like, like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (await db.get(`SELECT COUNT(*) AS n FROM items i ${clause}`, ...params)).n;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const current = Math.min(Math.max(1, Number(page) || 1), pages);
  const rows = await db.all(`
    SELECT i.*, ${COVER} AS photo, u.name AS poster_name, u.department AS poster_department,
           (SELECT COUNT(*) FROM responses r WHERE r.item_id = i.id AND r.status != 'withdrawn') AS response_count
    FROM items i JOIN users u ON u.id = i.user_id
    ${clause}
    ORDER BY i.created_at DESC
    LIMIT ? OFFSET ?
  `, ...params, PAGE_SIZE, (current - 1) * PAGE_SIZE);
  return { items: rows, total, page: current, pages };
}

async function getItem(id) {
  const item = await db.get(`
    SELECT i.*, u.name AS poster_name, u.department AS poster_department, u.phone AS poster_phone
    FROM items i JOIN users u ON u.id = i.user_id WHERE i.id = ?
  `, id);
  if (!item) return null;
  item.photos = (await db.all('SELECT filename FROM photos WHERE item_id = ? ORDER BY id', id)).map((p) => p.filename);
  return item;
}

function getResponses(itemId) {
  return db.all(`
    SELECT r.*, u.name AS responder_name, u.department AS responder_department, u.phone AS responder_phone
    FROM responses r JOIN users u ON u.id = r.user_id
    WHERE r.item_id = ? ORDER BY r.created_at DESC
  `, itemId);
}

const countIf = (cond) => `COALESCE(SUM(CASE WHEN ${cond} THEN 1 ELSE 0 END), 0)`;

function stats() {
  return db.get(`
    SELECT
      ${countIf("status = 'open' AND type = 'lost'")}  AS open_lost,
      ${countIf("status = 'open' AND type = 'found'")} AS open_found,
      ${countIf("status = 'resolved'")}                AS returned
    FROM items
  `);
}

function userItems(userId) {
  return db.all(`
    SELECT i.*, ${COVER} AS photo,
      (SELECT COUNT(*) FROM responses r WHERE r.item_id = i.id AND r.status = 'pending') AS pending_count
    FROM items i WHERE i.user_id = ? ORDER BY i.created_at DESC
  `, userId);
}

function userResponses(userId) {
  return db.all(`
    SELECT r.*, i.title, i.type, i.category, i.status AS item_status, ${COVER} AS photo
    FROM responses r JOIN items i ON i.id = r.item_id
    WHERE r.user_id = ? ORDER BY r.created_at DESC
  `, userId);
}

module.exports = { listItems, getItem, getResponses, stats, userItems, userResponses, countIf, likeTerm, PAGE_SIZE };
