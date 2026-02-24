const express = require('express');
const router = express.Router();
const quotationController = require('../controllers/quotation.controller');
const auth = require('../middleware/auth');

router.use(auth);

router.get('/', quotationController.list);
router.get('/:id', quotationController.get);
router.post('/save', quotationController.saveFromChat);
router.patch('/:id/accept', quotationController.accept);
router.patch('/:id/reject', quotationController.reject);

module.exports = router;
