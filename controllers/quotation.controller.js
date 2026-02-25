const pool = require('../config/database');
const fetch = require('node-fetch');

// GET /api/quotations
exports.list = async (req, res, next) => {
    try {
        const { page = 1, limit = 10, status, search } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);
        const userId = req.user.id;

        let where = 'WHERE user_id = ?';
        const params = [userId];

        if (status) {
            where += ' AND status = ?';
            params.push(status);
        }

        if (search) {
            where += ' AND quotation_no LIKE ?';
            params.push(`%${search}%`);
        }

        const [countRows] = await pool.query(
            `SELECT COUNT(*) as total FROM quotations ${where}`,
            params
        );
        const total = countRows[0].total;

        const [quotations] = await pool.query(
            `SELECT id, quotation_no, prompt_text, status, response_data, notes, created_at, updated_at
       FROM quotations ${where}
       ORDER BY created_at DESC LIMIT ? OFFSET ?`,
            [...params, parseInt(limit), offset]
        );

        res.json({
            success: true,
            data: quotations,
            total,
            page: parseInt(page),
            limit: parseInt(limit),
            totalPages: Math.ceil(total / parseInt(limit))
        });
    } catch (error) {
        next(error);
    }
};

// GET /api/quotations/:id
exports.get = async (req, res, next) => {
    try {
        const [rows] = await pool.query(
            'SELECT * FROM quotations WHERE id = ? AND user_id = ?',
            [req.params.id, req.user.id]
        );
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Quotation not found.' });
        }
        res.json({ success: true, quotation: rows[0] });
    } catch (error) {
        next(error);
    }
};

// PATCH /api/quotations/:id/accept
exports.accept = async (req, res, next) => {
    try {
        const [rows] = await pool.query(
            "SELECT id, status FROM quotations WHERE id = ? AND user_id = ?",
            [req.params.id, req.user.id]
        );
        if (rows.length === 0) return res.status(404).json({ error: 'Quotation not found.' });
        if (rows[0].status !== 'pending') {
            return res.status(400).json({ error: `Cannot accept a quotation with status: ${rows[0].status}` });
        }
        await pool.query(
            "UPDATE quotations SET status = 'accepted', updated_at = NOW() WHERE id = ?",
            [req.params.id]
        );
        const [updated] = await pool.query('SELECT * FROM quotations WHERE id = ?', [req.params.id]);
        res.json({ success: true, quotation: updated[0] });
    } catch (error) {
        next(error);
    }
};

// PATCH /api/quotations/:id/reject
exports.reject = async (req, res, next) => {
    try {
        const [rows] = await pool.query(
            "SELECT id, status FROM quotations WHERE id = ? AND user_id = ?",
            [req.params.id, req.user.id]
        );
        if (rows.length === 0) return res.status(404).json({ error: 'Quotation not found.' });
        if (rows[0].status !== 'pending') {
            return res.status(400).json({ error: `Cannot reject a quotation with status: ${rows[0].status}` });
        }
        await pool.query(
            "UPDATE quotations SET status = 'rejected', updated_at = NOW() WHERE id = ?",
            [req.params.id]
        );
        const [updated] = await pool.query('SELECT * FROM quotations WHERE id = ?', [req.params.id]);
        res.json({ success: true, quotation: updated[0] });
    } catch (error) {
        next(error);
    }
};

// POST /api/quotations/save — Save quotation from chat message on user accept
exports.saveFromChat = async (req, res, next) => {
    try {
        const { chatMessageId } = req.body;
        const userId = req.user.id;

        if (!chatMessageId) {
            return res.status(400).json({ error: 'chatMessageId is required.' });
        }

        // Find the chat message and verify ownership
        const [msgs] = await pool.query(
            `SELECT cm.*, cs.user_id as session_user_id 
             FROM chat_messages cm 
             JOIN chat_sessions cs ON cm.chat_session_id = cs.id 
             WHERE cm.id = ? AND cs.user_id = ?`,
            [chatMessageId, userId]
        );

        if (msgs.length === 0) {
            return res.status(404).json({ error: 'Chat message not found.' });
        }

        const msg = msgs[0];

        if (!msg.quotation_no || !msg.is_success) {
            return res.status(400).json({ error: 'This message does not contain a valid quotation.' });
        }

        // Check if quotation already saved
        const [existing] = await pool.query(
            'SELECT id FROM quotations WHERE quotation_no = ? AND user_id = ?',
            [msg.quotation_no, userId]
        );

        if (existing.length > 0) {
            // Already saved — just return it
            const [q] = await pool.query('SELECT * FROM quotations WHERE id = ?', [existing[0].id]);
            return res.json({ success: true, quotation: q[0], alreadySaved: true });
        }

        // Get the prompt text from the preceding user message in same session
        const [userMsgs] = await pool.query(
            `SELECT content FROM chat_messages 
             WHERE chat_session_id = ? AND role = 'user' AND created_at < ? 
             ORDER BY created_at DESC LIMIT 1`,
            [msg.chat_session_id, msg.created_at]
        );
        const promptText = userMsgs.length > 0 ? userMsgs[0].content : 'Travel quotation request';

        // Save to quotations table with status accepted
        const [result] = await pool.query(
            'INSERT INTO quotations (user_id, quotation_no, prompt_text, status, response_data) VALUES (?, ?, ?, ?, ?)',
            [userId, msg.quotation_no, promptText, 'accepted', msg.response_data ? JSON.stringify(msg.response_data) : null]
        );

        const [saved] = await pool.query('SELECT * FROM quotations WHERE id = ?', [result.insertId]);

        // Send quotation email via n8n webhook (fire-and-forget)
        try {
            await fetch('https://aahaas-ai.app.n8n.cloud/webhook/send-quotation-email', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    quotationID: `${msg.quotation_no}/R1`,
                    email: req.user.email
                })
            });
            console.log(`Webhook sent for quotation: ${msg.quotation_no}/R1`);
        } catch (webhookError) {
            console.error('Failed to send quotation email webhook:', webhookError.message);
        }

        res.status(201).json({ success: true, quotation: saved[0] });
    } catch (error) {
        next(error);
    }
};

