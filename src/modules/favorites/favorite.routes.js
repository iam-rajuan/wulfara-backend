const express = require('express');
const {
  addFavorite,
  getFavorites,
  removeFavorite
} = require('./favorite.controller');

const router = express.Router();
const { protect } = require('../../middlewares/auth');

router.use(protect);

router.route('/')
  .post(addFavorite)
  .get(getFavorites);

router.route('/:id')
  .delete(removeFavorite);

module.exports = router;
