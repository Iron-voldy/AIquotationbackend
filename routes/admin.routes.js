const express = require('express');
const router = express.Router();
const adminController = require('../controllers/admin.controller');
const auth = require('../middleware/auth');
const adminAuth = require('../middleware/adminAuth');

router.use(auth);
router.use(adminAuth);

router.get('/stats', adminController.getStats);
router.get('/users', adminController.getUsers);
router.get('/users/:id', adminController.getUser);
router.patch('/users/:id/toggle', adminController.toggleUser);
router.get('/quotations', adminController.getQuotations);

module.exports = router;
