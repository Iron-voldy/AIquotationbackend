const pool = require('../config/database');
const fetch = require('node-fetch');

// GET /api/quotations
exports.list = async (req, res, next) => {
    try {
        const { page = 1, limit = 10, status, search, dateFrom, dateTo } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);
        const userId = req.user.id;

        let where = 'WHERE q.user_id = ?';
        const params = [userId];

        if (status) {
            where += ' AND q.status = ?';
            params.push(status);
        }

        if (search) {
            where += ' AND (q.quotation_no LIKE ? OR q.prompt_text LIKE ?)';
            params.push(`%${search}%`, `%${search}%`);
        }

        if (dateFrom) {
            where += ' AND DATE(q.created_at) >= ?';
            params.push(dateFrom);
        }

        if (dateTo) {
            where += ' AND DATE(q.created_at) <= ?';
            params.push(dateTo);
        }

        const [countRows] = await pool.query(
            `SELECT COUNT(*) as total FROM quotations q ${where}`,
            params
        );
        const total = countRows[0].total;

        const [quotations] = await pool.query(
            `SELECT q.id, q.quotation_no, q.prompt_text, q.status, q.response_data, q.notes, q.created_at, q.updated_at,
                    (SELECT cm.chat_session_id FROM chat_messages cm
                     WHERE cm.quotation_no = q.quotation_no AND cm.user_id = q.user_id
                     ORDER BY cm.created_at ASC LIMIT 1) AS chat_session_id
             FROM quotations q ${where}
             ORDER BY q.created_at DESC LIMIT ? OFFSET ?`,
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

        console.log('='.repeat(60));
        console.log('[QUOTATION SAVE] === SAVE FROM CHAT REQUEST ===');
        console.log('[QUOTATION SAVE] User ID:', userId);
        console.log('[QUOTATION SAVE] User Email:', req.user.email);
        console.log('[QUOTATION SAVE] JWT isAgent:', req.user.isAgent);
        console.log('[QUOTATION SAVE] chatMessageId:', chatMessageId);
        console.log('='.repeat(60));

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

        // Check if quotation already fully accepted/saved
        const [existing] = await pool.query(
            'SELECT id, status, revision FROM quotations WHERE quotation_no = ? AND user_id = ?',
            [msg.quotation_no, userId]
        );

        let savedQuotationId;
        if (existing.length > 0) {
            if (existing[0].status === 'accepted') {
                // Already fully accepted — return as-is
                const [q] = await pool.query('SELECT * FROM quotations WHERE id = ?', [existing[0].id]);
                return res.json({ success: true, quotation: q[0], alreadySaved: true });
            }
            // Exists as pending (or rejected) — update to accepted
            await pool.query(
                "UPDATE quotations SET status = 'accepted', updated_at = NOW() WHERE id = ?",
                [existing[0].id]
            );
            savedQuotationId = existing[0].id;
            console.log('[QUOTATION SAVE] Updated existing quotation to accepted. ID:', savedQuotationId, '| No:', msg.quotation_no);
        } else {
            // Fallback: no pre-existing record (older sessions) — insert fresh
            const [userMsgs] = await pool.query(
                `SELECT content FROM chat_messages
                 WHERE chat_session_id = ? AND role = 'user' AND created_at < ?
                 ORDER BY created_at DESC LIMIT 1`,
                [msg.chat_session_id, msg.created_at]
            );
            const promptText = userMsgs.length > 0 ? userMsgs[0].content : 'Travel quotation request';
            const [result] = await pool.query(
                'INSERT INTO quotations (user_id, quotation_no, prompt_text, status, response_data) VALUES (?, ?, ?, ?, ?)',
                [userId, msg.quotation_no, promptText, 'accepted', msg.response_data ? JSON.stringify(msg.response_data) : null]
            );
            savedQuotationId = result.insertId;
            console.log('[QUOTATION SAVE] Inserted new quotation as accepted. ID:', savedQuotationId, '| No:', msg.quotation_no);
        }

        const [saved] = await pool.query('SELECT * FROM quotations WHERE id = ?', [savedQuotationId]);

        // Stamp the originating chat message so status persists on page reload
        await pool.query(
            "UPDATE chat_messages SET quotation_status = 'accepted' WHERE id = ?",
            [chatMessageId]
        );

        // ═══════════════════════════════════════════════════════
        // EMAIL WEBHOOK DECISION — ONLY for regular users
        // ═══════════════════════════════════════════════════════
        let isAgent = !!req.user.isAgent;
        console.log('[QUOTATION SAVE] Agent check Step 1 — JWT isAgent:', isAgent);
        
        try {
            const [agentCheck] = await pool.query(
                'SELECT id FROM agent_tokens WHERE user_id = ? LIMIT 1',
                [userId]
            );
            console.log('[QUOTATION SAVE] Agent check Step 2 — agent_tokens rows:', agentCheck.length);
            if (agentCheck.length > 0) {
                isAgent = true;
            }
        } catch (dbErr) {
            console.error('[QUOTATION SAVE] Agent check DB error:', dbErr.message);
        }

        console.log('='.repeat(60));
        console.log(`[QUOTATION SAVE] *** FINAL isAgent: ${isAgent} ***`);
        console.log(`[QUOTATION SAVE] Action: ${isAgent ? '*** SKIPPING EMAIL (agent) ***' : 'SENDING EMAIL (regular user)'}`);
        console.log('='.repeat(60));

        if (!isAgent) {
            try {
                const savedRevision = saved[0].revision || 1;
                console.log(`[QUOTATION EMAIL] Sending email webhook for ${msg.quotation_no}/R${savedRevision} to ${req.user.email}`);
                await fetch('https://aahaas-ai.app.n8n.cloud/webhook/send-quotation-email', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        quotationID: `${msg.quotation_no}/R${savedRevision}`,
                        email: req.user.email
                    })
                });
                console.log(`[QUOTATION EMAIL] Email webhook sent successfully`);
            } catch (webhookError) {
                console.error('[QUOTATION EMAIL] Failed:', webhookError.message);
            }
        } else {
            console.log(`[QUOTATION EMAIL] *** NOT SENDING — user ${userId} is an AGENT ***`);
        }

        res.status(201).json({ success: true, quotation: saved[0] });
    } catch (error) {
        console.error('[QUOTATION SAVE] FATAL ERROR:', error.message);
        next(error);
    }
};

// POST /api/quotations/reject-from-chat — Persist rejection from chat UI (no email)
exports.rejectFromChat = async (req, res, next) => {
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

        // Stamp chat_messages row so rejection persists on page reload
        await pool.query(
            "UPDATE chat_messages SET quotation_status = 'rejected' WHERE id = ?",
            [chatMessageId]
        );

        // Upsert to quotations table as rejected
        const [existing] = await pool.query(
            'SELECT id, status FROM quotations WHERE quotation_no = ? AND user_id = ?',
            [msg.quotation_no, userId]
        );

        if (existing.length > 0) {
            // Only update if still pending — don't overwrite an accepted quotation
            if (existing[0].status === 'pending') {
                await pool.query(
                    "UPDATE quotations SET status = 'rejected', updated_at = NOW() WHERE id = ?",
                    [existing[0].id]
                );
                console.log(`[QUOTATION REJECT] Updated existing quotation ${msg.quotation_no} → rejected`);
            } else {
                console.log(`[QUOTATION REJECT] Quotation ${msg.quotation_no} is already ${existing[0].status} — skipping status update`);
            }
        } else {
            // Quotation not yet saved — insert it as rejected
            const [userMsgs] = await pool.query(
                `SELECT content FROM chat_messages
                 WHERE chat_session_id = ? AND role = 'user' AND created_at < ?
                 ORDER BY created_at DESC LIMIT 1`,
                [msg.chat_session_id, msg.created_at]
            );
            const promptText = userMsgs.length > 0 ? userMsgs[0].content : 'Travel quotation request';

            await pool.query(
                'INSERT INTO quotations (user_id, quotation_no, prompt_text, status, response_data) VALUES (?, ?, ?, ?, ?)',
                [userId, msg.quotation_no, promptText, 'rejected', msg.response_data ? JSON.stringify(msg.response_data) : null]
            );
            console.log(`[QUOTATION REJECT] Inserted new quotation ${msg.quotation_no} as rejected`);
        }

        console.log(`[QUOTATION REJECT] *** No email sent — user rejected quotation ${msg.quotation_no} ***`);

        res.json({ success: true, quotationNo: msg.quotation_no, status: 'rejected' });
    } catch (error) {
        console.error('[QUOTATION REJECT] FATAL ERROR:', error.message);
        next(error);
    }
};

