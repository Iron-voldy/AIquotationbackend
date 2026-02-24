const fetch = require('node-fetch');
require('dotenv').config();

const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
const TIMEOUT_MS = 180000; // 3 minutes

/**
 * Send a message to the n8n webhook using the shared Apple token
 */
const sendToN8N = async (chatInput, appleToken) => {
    console.log('[WEBHOOK] Sending to n8n...');
    console.log('[WEBHOOK] chatInput:', chatInput.substring(0, 100) + (chatInput.length > 100 ? '...' : ''));
    console.log('[WEBHOOK] Token present:', !!appleToken);

    const payload = {
        chatInput: chatInput,
        sessionId: appleToken,
        bearerToken: appleToken
    };

    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
        const response = await fetch(N8N_WEBHOOK_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify(payload),
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        const contentType = response.headers.get('content-type');
        const text = await response.text();

        console.log('[WEBHOOK] Response status:', response.status);
        console.log('[WEBHOOK] Response text:', text.substring(0, 200));

        if (!response.ok) {
            console.error('[WEBHOOK] HTTP error:', response.status);
            return { success: false, error: `Webhook returned ${response.status}` };
        }

        if (!text || text.trim() === '') {
            console.error('[WEBHOOK] Empty response from n8n');
            return { success: false, error: 'Empty response from AI service' };
        }

        if (contentType && contentType.includes('application/json')) {
            try {
                const json = JSON.parse(text);
                console.log('[WEBHOOK] Parsed response:', json);
                return json;
            } catch (e) {
                console.error('[WEBHOOK] JSON parse error:', e.message);
                return { success: false, error: 'Invalid JSON response from AI service' };
            }
        }

        // Try to parse even if content-type is wrong
        try {
            const json = JSON.parse(text);
            return json;
        } catch (e) {
            console.error('[WEBHOOK] Non-JSON response:', text);
            return { success: false, error: 'Unexpected response format from AI service' };
        }

    } catch (error) {
        clearTimeout(timeoutId);

        if (error.name === 'AbortError') {
            console.error('[WEBHOOK] Request timed out after', TIMEOUT_MS / 1000, 'seconds');
            return { success: false, error: 'AI service request timed out (3 minutes). Please try again.' };
        }

        console.error('[WEBHOOK] Request error:', error.message);
        return { success: false, error: `AI service error: ${error.message}` };
    }
};

module.exports = { sendToN8N };
