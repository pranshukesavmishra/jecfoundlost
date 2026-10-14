const express = require('express');
const config = require('../config');
const { getCollectionPoints } = require('../db');
const { listItems, getItem, getResponses, stats } = require('../items');

const router = express.Router();

router.get('/', (req, res) => {
  const filters = {
    q: String(req.query.q || '').slice(0, 100),
    type: req.query.type || '',
    category: config.categories.includes(req.query.category) ? req.query.category : '',
    status: ['open', 'resolved'].includes(req.query.status) ? req.query.status : 'open',
    page: req.query.page,
  };
  const result = listItems(filters);
  res.render('home', { title: '', filters, ...result, stats: stats() });
});

router.get('/items/:id', (req, res, next) => {
  if (!/^\d+$/.test(req.params.id)) return next();
  const item = getItem(Number(req.params.id));
  if (!item) return next();
  const me = req.user;
  const isOwner = !!me && me.id === item.user_id;
  const isAdmin = !!me && me.role === 'admin';

  let responses = getResponses(item.id);
  const myResponse = me ? responses.find((r) => r.user_id === me.id && r.status !== 'withdrawn') : null;
  if (!isOwner && !isAdmin) responses = myResponse ? [myResponse] : [];

  // Phone numbers are only shown to the two people in an accepted match (admins see them in the admin box).
  const canSeePosterPhone = !!myResponse && myResponse.status === 'accepted';

  res.render('item', {
    title: `${item.type === 'lost' ? 'Lost' : 'Found'}: ${item.title}`,
    item,
    responses,
    myResponse,
    isOwner,
    isAdmin,
    canSeePosterPhone,
    canRespond: !!me && !isOwner && item.status === 'open' && !myResponse,
    collectionPoints: getCollectionPoints(),
    shareUrl: `${config.BASE_URL || `${req.protocol}://${req.get('host')}`}/items/${item.id}`,
  });
});

router.get('/about', (req, res) => res.render('about', { title: 'How it works' }));

module.exports = router;
