const pool = require('../config/database');
const fetch = require('node-fetch');
const appleTokenService = require('../services/appleToken.service');
const webhookService = require('../services/webhook.service');

const validateTravelPrompt = (rawText) => {
    const msg = (rawText || '').trim();
    if (!msg) return { isValid: false, reason: 'empty' };

    const compact = msg.replace(/\s+/g, ' ');
    const words = compact.split(' ').filter(Boolean);
    const letters = (compact.match(/[a-z]/gi) || []).length;
    const nonSpaceChars = compact.replace(/\s/g, '').length;
    const letterRatio = nonSpaceChars ? letters / nonSpaceChars : 0;

    if (compact.length < 8) return { isValid: false, reason: 'too_short' };
    if (/^(.)\1+$/i.test(compact.replace(/\s/g, ''))) return { isValid: false, reason: 'repeated_chars' };
    if (/\b[bcdfghjklmnpqrstvwxyz]{7,}\b/i.test(compact)) return { isValid: false, reason: 'consonant_smash' };
    if (/\d{4,}[a-z]{4,}|[a-z]{4,}\d{4,}/i.test(compact) && words.length <= 2) {
        return { isValid: false, reason: 'alnum_smash' };
    }
    if (letterRatio < 0.35) return { isValid: false, reason: 'low_letters' };

    const hasTravelKeyword = /\b(trip|travel|package|tour|holiday|vacation|itinerary|quotation|quote|hotel|flight|visa|sightseeing|destination)\b/i.test(compact);
    const hasDuration = /\b\d+\s*(day|days|night|nights|week|weeks)\b/i.test(compact);
    const hasTravellers = /\b\d+\s*(pax|people|persons?|travellers?|adults?|children|kids|child)\b/i.test(compact)
        || /\b(adults?|children|kids|child)\b/i.test(compact);
    const hasDate = /\b(\d{1,2}[/-]\d{1,2}([/-]\d{2,4})?|\d{1,2}(st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)|from\s+\d{4}|travel\s+starts)\b/i.test(compact);
    const hasDestinationCue = /\b(to|for|in)\s+[a-z]{3,}\b/i.test(compact);

    const travelSignals = [hasTravelKeyword, hasDuration, hasTravellers, hasDate, hasDestinationCue].filter(Boolean).length;
    if (travelSignals >= 2) return { isValid: true, reason: null };
    if (hasTravelKeyword && words.length >= 4) return { isValid: true, reason: null };

    return { isValid: false, reason: 'missing_travel_details' };
};

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
            'SELECT id, role, content, quotation_no, is_success, quotation_status, response_data, created_at FROM chat_messages WHERE chat_session_id = ? ORDER BY created_at ASC',
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

        console.log('='.repeat(60));
        console.log('[CHAT SEND] === NEW MESSAGE REQUEST ===');
        console.log('[CHAT SEND] User ID:', req.user.id);
        console.log('[CHAT SEND] User Email:', req.user.email);
        console.log('[CHAT SEND] JWT isAgent flag:', req.user.isAgent);
        console.log('[CHAT SEND] JWT full payload:', JSON.stringify(req.user));
        console.log('='.repeat(60));

        if (!message || !message.trim()) {
            return res.status(400).json({ error: 'Message is required.' });
        }

        // ─────────────────────────────────────────────────────────
        // DETECT UPDATE REQUEST
        // Must match the SAME pattern used by n8n:
        //   (change|update|modify).*quotation
        //   quotation.*(change|update|modify)
        //   quotation[_\s-]*no
        //
        // REQUIRED MESSAGE FORMAT from user:
        //   "update quotation {number}"            ← first line
        //   "{description of what to change}"      ← second line
        //
        // Examples:
        //   "update quotation 291179\nchange 3 adults to 4 adults"
        //   "change quotation 291179 dates to 2026-05-01"
        //   "quotation_no 291179 update hotel"
        // ─────────────────────────────────────────────────────────
        const isUpdateRequest = /(change|update|modify)[\s\S]*quotation|quotation[\s\S]*(change|update|modify)|quotation[_\s-]*no/i
            .test(message.trim());

        // Extract quotation number — digits that follow "quotation" (with optional "no")
        const quotNoMatch = /quotation[_\s-]*(?:no)?[:\s]*(\d+)/i.exec(message.trim());
        const updateTargetNo = isUpdateRequest && quotNoMatch ? quotNoMatch[1] : null;

        if (isUpdateRequest) {
            console.log(`[CHAT SEND] UPDATE REQUEST detected — target quotation_no: ${updateTargetNo}`);
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
            console.log('[CHAT SEND] Created new session:', sessionId);
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

        // Strong server-side validation gate.
        // This prevents malformed/random text from reaching n8n and downstream APIs.
        if (!isUpdateRequest) {
            const validation = validateTravelPrompt(message.trim());
            if (!validation.isValid) {
                const validationText = 'Please enter a valid travel request with destination, duration, and travellers. Example: "Create Singapore trip/package for 3 nights for 3 pax".';
                const [invalidMsgResult] = await pool.query(
                    'INSERT INTO chat_messages (chat_session_id, user_id, role, content, is_success) VALUES (?, ?, ?, ?, ?)',
                    [sessionId, userId, 'assistant', validationText, 0]
                );
                const [invalidSaved] = await pool.query('SELECT * FROM chat_messages WHERE id = ?', [invalidMsgResult.insertId]);

                console.warn('[CHAT SEND] Blocked invalid/non-travel prompt before n8n call. Reason:', validation.reason);
                return res.status(200).json({
                    success: true,
                    message: invalidSaved[0],
                    quotationNo: null,
                    revisionNumber: null,
                    isUpdateRequest,
                    isSuccess: false,
                    chatSessionId: sessionId
                });
            }
        }

        // ═══════════════════════════════════════════════════════
        // AGENT CHECK — determine if this user is an agent
        // Check BOTH the JWT isAgent flag AND the agent_tokens table
        // ═══════════════════════════════════════════════════════
        let isAgent = !!req.user.isAgent;
        console.log('[AGENT CHECK] Step 1 — JWT isAgent:', isAgent);
        
        // Double-check: if user has an agent token in DB, they are an agent
        let agentCheck = [];
        try {
            const [rows] = await pool.query(
                'SELECT apple_access_token, expires_at FROM agent_tokens WHERE user_id = ? LIMIT 1',
                [userId]
            );
            agentCheck = rows;
            console.log('[AGENT CHECK] Step 2 — agent_tokens table rows:', agentCheck.length);
            if (agentCheck.length > 0) {
                console.log('[AGENT CHECK] Step 2 — Token expires at:', agentCheck[0].expires_at);
                isAgent = true;
            }
        } catch (dbErr) {
            console.error('[AGENT CHECK] Step 2 — DB query failed (table may not exist):', dbErr.message);
            // Table might not exist yet — that's OK, means no agents
        }
        
        console.log('[AGENT CHECK] *** FINAL isAgent:', isAgent, '***');
        
        let appleToken;
        try {
            if (isAgent && agentCheck.length > 0) {
                const agentRow = agentCheck[0];
                const tokenExpired = new Date(agentRow.expires_at) <= new Date();

                if (!tokenExpired) {
                    // Token still valid — use it directly
                    appleToken = agentRow.apple_access_token;
                    console.log('[CHAT SEND] Using AGENT\'s own Apple token for user:', userId);
                } else {
                    // Token expired — try to refresh via Apple API before giving up
                    console.warn('[CHAT SEND] Agent token expired for user:', userId, '— attempting refresh...');
                    const APPLE_API_URL = process.env.APPLE_API_URL || 'https://stagev2.appletechlabs.com/api';
                    try {
                        const refreshRes = await fetch(`${APPLE_API_URL}/auth/refresh`, {
                            method: 'POST',
                            headers: {
                                'Authorization': `Bearer ${agentRow.apple_access_token}`,
                                'Accept': 'application/json',
                                'Content-Type': 'application/x-www-form-urlencoded'
                            }
                        });
                        if (refreshRes.ok) {
                            const refreshData = await refreshRes.json();
                            const newAppleToken = refreshData.access_token || refreshData.token;
                            if (newAppleToken) {
                                const expiresIn = refreshData.expires_in || 3600;
                                const expiresAt = new Date(Date.now() + expiresIn * 1000);
                                await pool.query(
                                    'UPDATE agent_tokens SET apple_access_token = ?, expires_at = ? WHERE user_id = ?',
                                    [newAppleToken, expiresAt, userId]
                                );
                                appleToken = newAppleToken;
                                console.log('[CHAT SEND] Agent token refreshed successfully for user:', userId);
                            } else {
                                throw new Error('Refresh response missing token');
                            }
                        } else {
                            throw new Error(`Apple refresh returned ${refreshRes.status}`);
                        }
                    } catch (refreshErr) {
                        console.error('[CHAT SEND] Agent token refresh failed:', refreshErr.message);
                        throw new Error('Agent token expired. Please log out and log in again.');
                    }
                }
            } else {
                // Regular user: use shared Apple token
                isAgent = false; // ensure this is false for the email webhook check below
                appleToken = await appleTokenService.getValidToken();
                console.log('[CHAT SEND] Using SHARED Apple token for regular user:', userId);
            }
        } catch (tokenErr) {
            console.error('[CHAT SEND] Failed to get Apple token:', tokenErr.message);
            const errMsg = isAgent
                ? 'Your agent session has expired. Please log out and log in again.'
                : 'AI service is temporarily unavailable. Please try again later.';
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
        // Build a unique session ID that scopes n8n's AI memory to this user + this chat
        // session only.  Without this every regular user shares the same Apple token as the
        // sessionId, so n8n conflates ALL users' conversations into a single memory thread.
        const n8nSessionId = `u${userId}_s${sessionId}`;
        console.log('[CHAT SEND] Calling n8n webhook with n8nSessionId:', n8nSessionId);
        const webhookResponse = await webhookService.sendToN8N(message.trim(), appleToken, n8nSessionId);
        console.log('[CHAT SEND] Webhook response received:', JSON.stringify(webhookResponse).substring(0, 200));

        // Parse response: check for quotation_no
        // For update requests, fall back to the number extracted from the user message
        // if n8n confirms the update but doesn't echo back the quotation_no.
        let quotationNo = webhookResponse?.quotation_no;
        if (!quotationNo && isUpdateRequest && updateTargetNo) {
            quotationNo = updateTargetNo;
            console.log('[CHAT SEND] Update request — using quotation_no from message:', quotationNo);
        }
        const isSuccess = quotationNo && String(quotationNo).length > 2;

        let assistantContent;
        let savedQuotationNo = null;
        let revisionNumber   = 1; // tracks the R-value for the email

        if (isSuccess) {
            savedQuotationNo = String(quotationNo);

            // ─────────────────────────────────────────────────────────
            // REVISION HANDLING
            // New quotation  → always R1 (first time)
            // Update request → increment revision: R1→R2→R3 …
            // ─────────────────────────────────────────────────────────
            if (isUpdateRequest) {
                // 1. Check if this quotation is already saved in the quotations table
                const [existingQuot] = await pool.query(
                    'SELECT id, revision FROM quotations WHERE quotation_no = ? AND user_id = ?',
                    [savedQuotationNo, userId]
                );

                if (existingQuot.length > 0) {
                    // Quotation exists in DB — increment stored revision
                    revisionNumber = (existingQuot[0].revision || 1) + 1;
                    await pool.query(
                        `UPDATE quotations
                         SET revision = ?, response_data = ?, prompt_text = ?, updated_at = NOW()
                         WHERE id = ?`,
                        [revisionNumber, JSON.stringify(webhookResponse), message.trim(), existingQuot[0].id]
                    );
                    console.log(`[REVISION] DB record updated → R${revisionNumber} for quotation_no: ${savedQuotationNo}`);
                } else {
                    // Quotation not yet in quotations table — derive current revision from
                    // the number of successful assistant messages already in this session.
                    const [msgCount] = await pool.query(
                        `SELECT COUNT(*) AS count FROM chat_messages
                         WHERE quotation_no = ? AND user_id = ? AND is_success = 1 AND role = 'assistant'`,
                        [savedQuotationNo, userId]
                    );
                    const currentRevision = msgCount[0].count || 1;
                    revisionNumber = currentRevision + 1;
                    console.log(`[REVISION] Derived R${revisionNumber} from chat history (current R${currentRevision}) for quotation_no: ${savedQuotationNo}`);
                }

                assistantContent = webhookResponse.message ||
                    `Quotation ${savedQuotationNo} has been updated successfully! New revision: R${revisionNumber}`;
            } else {
                // New quotation — revision stays at 1
                revisionNumber   = 1;
                assistantContent = webhookResponse.message ||
                    `Your travel quotation has been created successfully! Quotation number: ${savedQuotationNo}`;
            }

            // Update session title with quotation number if it's still default
            await pool.query(
                'UPDATE chat_sessions SET title = ?, updated_at = NOW() WHERE id = ? AND title = ?',
                [`Quotation #${savedQuotationNo}`, sessionId, 'New Chat']
            );

            // NOTE: Email is sent ONLY when the user explicitly accepts and saves the quotation
            // via quotationAPI.saveFromChat (quotation.controller.js → saveFromChat).
            // We do NOT send email at creation time.
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

        // ───────────────────────────────────────────────────────
        // AUTO-UPSERT into quotations table so dashboard shows
        // the correct Pending / Accepted / Rejected counts.
        // New quotation  → INSERT as 'pending'
        // Update request → UPDATE revision + prompt_text only
        // ───────────────────────────────────────────────────────
        if (isSuccess && savedQuotationNo) {
            try {
                const [existQ] = await pool.query(
                    'SELECT id, status FROM quotations WHERE quotation_no = ? AND user_id = ?',
                    [savedQuotationNo, userId]
                );
                if (existQ.length === 0) {
                    // First time — insert as pending
                    await pool.query(
                        'INSERT INTO quotations (user_id, quotation_no, prompt_text, status, revision, response_data) VALUES (?, ?, ?, ?, ?, ?)',
                        [userId, savedQuotationNo, message.trim(), 'pending', 1, JSON.stringify(webhookResponse)]
                    );
                    console.log(`[CHAT SEND] Auto-inserted quotation ${savedQuotationNo} as pending`);
                } else if (isUpdateRequest) {
                    // Update request — bump revision, keep existing status
                    await pool.query(
                        'UPDATE quotations SET revision = ?, prompt_text = ?, response_data = ?, updated_at = NOW() WHERE id = ?',
                        [revisionNumber, message.trim(), JSON.stringify(webhookResponse), existQ[0].id]
                    );
                    console.log(`[CHAT SEND] Bumped revision for quotation ${savedQuotationNo} to R${revisionNumber}`);
                }
            } catch (upsertErr) {
                // Non-fatal — don't block the chat response
                console.error('[CHAT SEND] Auto-upsert to quotations failed:', upsertErr.message);
            }
        }

        console.log('[CHAT SEND] Message saved. ID:', msgResult.insertId, '| Quotation:', savedQuotationNo || 'none');

        res.json({
            success: true,
            message: savedMsg[0],
            quotationNo: savedQuotationNo,
            revisionNumber: isSuccess ? revisionNumber : null,
            isUpdateRequest,
            isSuccess,
            chatSessionId: sessionId
        });
    } catch (error) {
        console.error('[CHAT SEND] FATAL ERROR:', error.message);
        next(error);
    }
};

// POST /api/chat/optimize-prompt
// Proxies the user's failed prompt to OpenAI (server-side, avoiding browser CORS restrictions)
// and returns 2-3 simplified booking prompt suggestions.
const OPTIMIZE_SYSTEM_PROMPT = `You are a travel booking prompt optimizer for a Southeast/South Asian travel company.

The user sent a complex or unclear travel request that the booking system could NOT process.
Your job: extract the travel details and return 2–3 SIMPLIFIED prompts the system CAN handle.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SUPPORTED DESTINATIONS ONLY
(map any city, landmark, or attraction to these countries)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Sri Lanka  → Colombo, Kandy, Galle, Nuwara Eliya, Ella, Bentota, Sigiriya,
               Dambulla, Anuradhapura, Mirissa, Trincomalee, Yala
• Malaysia   → Kuala Lumpur, Langkawi, Penang
               Landmarks: Twin Towers, Petronas, KLCC, Genting, Putrajaya,
               Batu Caves, KL Tower, Aquaria KLCC, Sunway Lagoon
• Vietnam    → Hanoi, Da Nang, Ho Chi Minh City (Saigon), Phu Quoc, Sa Pa
• Singapore  → Singapore City
               Landmarks: Marina Bay Sands, Gardens by the Bay, Universal Studios,
               Sentosa, Orchard Road, Clarke Quay

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTPUT FORMAT — JSON array ONLY, no extra text
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
["prompt 1", "prompt 2", "prompt 3"]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PROMPT FORMAT RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Each prompt MUST follow this pattern:
  "Create [Country] for [X] nights for [N] pax"
  "Create [Country] for [X] nights for [N] adults and [Y] children traveling on [Date] with [star]-star hotel"

Rules:
1. Country is ALWAYS the country name (Sri Lanka / Malaysia / Vietnam / Singapore), NOT the city.
2. Remove all activity/tour/landmark details — booking system does not support them.
3. Simplify pax: ignore "no bed", "extra bed", bed type, child ages — just count adults and children.
4. If multiple cities mentioned for the same country, use only the country name.
5. If no duration found, generate variants: 3-night and 5-night options.
6. If travel date found, include it as "Xth Month YYYY" (e.g., "5th April 2026").
7. If hotel star rating found (e.g., 4 star, luxury), include "with X-star hotel".
8. Generate exactly 2 prompts: one minimal, one with full details.
9. If destination is NOT in the supported list, return: ["Sorry, we only support Sri Lanka, Malaysia, Vietnam, and Singapore at this time."]

Example input: "create a quote for 2 adults + 1 child 8 yrs no bed for 5th April 2026 with 4 star hotel, city tour, twin tower, day trip of genting, out door theme park, putrajaya, on private transfer"
Example output: ["Create Malaysia for 3 nights for 2 adults and 1 child", "Create Malaysia for 3 nights for 2 adults and 1 child traveling on 5th April 2026 with 4-star hotel"]`;

exports.optimizePrompt = async (req, res, next) => {
    try {
        const { prompt } = req.body;
        if (!prompt || !prompt.trim()) {
            return res.status(400).json({ error: 'prompt is required.' });
        }

        if (!process.env.OPENAI_API_KEY) {
            return res.status(503).json({ error: 'OpenAI is not configured on this server.' });
        }

        const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                messages: [
                    { role: 'system', content: OPTIMIZE_SYSTEM_PROMPT },
                    { role: 'user', content: prompt.trim() }
                ],
                temperature: 0.2,
                max_tokens: 300
            })
        });

        if (!openaiRes.ok) {
            const err = await openaiRes.json().catch(() => ({}));
            console.error('[OPTIMIZE PROMPT] OpenAI error:', openaiRes.status, JSON.stringify(err));
            return res.status(502).json({ error: 'OpenAI request failed.', detail: err });
        }

        const data = await openaiRes.json();
        res.json({ success: true, data });
    } catch (error) {
        next(error);
    }
};
