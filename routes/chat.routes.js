const express = require('express');
const router = express.Router();
const chatController = require('../controllers/chat.controller');
const auth = require('../middleware/auth');

router.use(auth);

router.get('/sessions', chatController.getSessions);
router.post('/sessions', chatController.createSession);
router.delete('/sessions/:id', chatController.deleteSession);
router.get('/sessions/:id/messages', chatController.getMessages);
router.post('/send', chatController.sendMessage);

module.exports = router;
