const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');
const auth = require('../middleware/auth');

router.post('/register', authController.register);
router.post('/login', authController.login);
router.post('/agent-login', authController.agentLogin);
router.post('/logout', auth, authController.logout);
router.get('/me', auth, authController.me);
router.put('/me/theme', auth, authController.updateTheme);
router.post('/refresh', auth, authController.refresh);

module.exports = router;
