const pool = require('../config/database');
const fetch = require('node-fetch');
const appleTokenService = require('../services/appleToken.service');
const webhookService = require('../services/webhook.service');

// GET /api/chat/sessions
exports.getSessions = async (req, res, next) => {
    try {
        const [sessions] = await pool.query(
            `SELECT cs.id, cs.title, cs.created_at, cs.updated_at,
        (SELECT COUNT(*) FROM chat_messages cm WHERE cm.chat_session_id = cs.id) as message_count,
        (SELECT cm2.content FROM chat_messages cm2 WHERE cm2.chat_session_id = cs.id ORDER BY cm2.created_at DESC LIMIT 1) as last_message
       FROM chat_sessions cs
       WHERE cs.user_id = ?
       ORDER BY cs.updated_at DESC`,
            [req.user.id]
        );
        res.json({ success: true, sessions });
    } catch (error) {
        next(error);
    }
};

// POST /api/chat/sessions
exports.createSession = async (req, res, next) => {
    try {
        const { title } = req.body;
        const [result] = await pool.query(
            'INSERT INTO chat_sessions (user_id, title) VALUES (?, ?)',
            [req.user.id, title || 'New Chat']
        );
        const [rows] = await pool.query('SELECT * FROM chat_sessions WHERE id = ?', [result.insertId]);
        res.status(201).json({ success: true, session: rows[0] });
    } catch (error) {
        next(error);
    }
};

// DELETE /api/chat/sessions/:id
exports.deleteSession = async (req, res, next) => {
    try {
        const { id } = req.params;
        const [rows] = await pool.query(
            'SELECT id FROM chat_sessions WHERE id = ? AND user_id = ?',
            [id, req.user.id]
        );
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Chat session not found.' });
        }
        await pool.query('DELETE FROM chat_sessions WHERE id = ?', [id]);
        res.json({ success: true, message: 'Session deleted.' });
    } catch (error) {
        next(error);
    }
};

// GET /api/chat/sessions/:id/messages
exports.getMessages = async (req, res, next) => {
    try {
        const { id } = req.params;
        const [session] = await pool.query(
            'SELECT id FROM chat_sessions WHERE id = ? AND user_id = ?',
            [id, req.user.id]
        );
        if (session.length === 0) {
            return res.status(404).json({ error: 'Chat session not found.' });
        }
        const [messages] = await pool.query(
            'SELECT id, role, content, quotation_no, is_success, response_data, created_at FROM chat_messages WHERE chat_session_id = ? ORDER BY created_at ASC',
            [id]
        );
        res.json({ success: true, messages });
    } catch (error) {
        next(error);
    }
};

// POST /api/chat/send
exports.sendMessage = async (req, res, next) => {
    try {
        const { chatSessionId, message } = req.body;

        if (!message || !message.trim()) {
            return res.status(400).json({ error: 'Message is required.' });
        }

        const userId = req.user.id;
        let sessionId = chatSessionId;

        // Create session if needed
        if (!sessionId) {
            const title = message.trim().substring(0, 60) || 'New Chat';
            const [result] = await pool.query(
                'INSERT INTO chat_sessions (user_id, title) VALUES (?, ?)',
                [userId, title]
            );
            sessionId = result.insertId;
        } else {
            // Verify session belongs to user
            const [session] = await pool.query(
                'SELECT id FROM chat_sessions WHERE id = ? AND user_id = ?',
                [sessionId, userId]
            );
            if (session.length === 0) {
                return res.status(404).json({ error: 'Chat session not found.' });
            }
            // Update session timestamp
            await pool.query('UPDATE chat_sessions SET updated_at = NOW() WHERE id = ?', [sessionId]);
        }

        // Save user message
        await pool.query(
            'INSERT INTO chat_messages (chat_session_id, user_id, role, content) VALUES (?, ?, ?, ?)',
            [sessionId, userId, 'user', message.trim()]
        );

        // Get shared Apple token
        let appleToken;
        try {
            appleToken = await appleTokenService.getValidToken();
        } catch (tokenErr) {
            console.error('[CHAT SEND] Failed to get Apple token:', tokenErr.message);
            const errMsg = 'AI service is temporarily unavailable. Please try again later.';
            await pool.query(
                'INSERT INTO chat_messages (chat_session_id, user_id, role, content, is_success) VALUES (?, ?, ?, ?, ?)',
                [sessionId, userId, 'assistant', errMsg, false]
            );
            return res.status(503).json({
                success: false,
                error: errMsg,
                chatSessionId: sessionId
            });
        }

        // Call n8n webhook
        const webhookResponse = await webhookService.sendToN8N(message.trim(), appleToken);

        console.log('[CHAT SEND] Webhook response:', webhookResponse);

        // Parse response: check for quotation_no
        const quotationNo = webhookResponse?.quotation_no;
        const isSuccess = quotationNo && String(quotationNo).length > 2;

        let assistantContent;
        let savedQuotationNo = null;

        if (isSuccess) {
            savedQuotationNo = String(quotationNo);
            assistantContent = webhookResponse.message || `Your travel quotation has been created successfully! Quotation number: ${savedQuotationNo}`;

            // Do NOT save to quotations table yet — only save when user accepts
            // Store the response_data in the chat message for later retrieval

            // Update session title with quotation number if it's still default
            await pool.query(
                'UPDATE chat_sessions SET title = ?, updated_at = NOW() WHERE id = ? AND title = ?',
                [`Quotation #${savedQuotationNo}`, sessionId, 'New Chat']
            );

            // Fire quotation email webhook (fire-and-forget)
            try {
                const userEmail = req.user.email;
                fetch('https://aahaas-ai.app.n8n.cloud/webhook/send-quotation-email', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        quotationID: `${savedQuotationNo}/R1`,
                        email: userEmail
                    })
                }).then(r => console.log(`[CHAT] Quotation email webhook sent for ${savedQuotationNo}, status: ${r.status}`))
                  .catch(err => console.error('[CHAT] Quotation email webhook failed:', err.message));
            } catch (emailErr) {
                console.error('[CHAT] Failed to trigger quotation email:', emailErr.message);
            }
        } else {
            assistantContent = webhookResponse?.error ||
                'Sorry, I could not create a quotation at this time. Please try rephrasing your request with destination, dates, and number of travelers.';
        }

        // Save assistant message with response_data for later quotation save
        const [msgResult] = await pool.query(
            'INSERT INTO chat_messages (chat_session_id, user_id, role, content, quotation_no, is_success, response_data) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [sessionId, userId, 'assistant', assistantContent, savedQuotationNo, isSuccess ? 1 : 0, isSuccess ? JSON.stringify(webhookResponse) : null]
        );

        const [savedMsg] = await pool.query('SELECT * FROM chat_messages WHERE id = ?', [msgResult.insertId]);

        res.json({
            success: true,
            message: savedMsg[0],
            quotationNo: savedQuotationNo,
            isSuccess,
            chatSessionId: sessionId
        });
    } catch (error) {
        next(error);
    }
};
