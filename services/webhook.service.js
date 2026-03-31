const fetch = require('node-fetch');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
const TIMEOUT_MS = 180000; // 3 minutes

const payloadContainsTokenExpired = (value) => {
    if (!value) return false;
    if (typeof value === 'string') return /token expired/i.test(value);
    if (Array.isArray(value)) return value.some(payloadContainsTokenExpired);
    if (typeof value === 'object') return Object.values(value).some(payloadContainsTokenExpired);
    return false;
};

const parseWebhookBody = (text) => {
    if (!text || !text.trim()) return null;

    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
};

const buildExpiredTokenResult = (statusCode, rawResponse) => ({
    success: false,
    authExpired: true,
    statusCode,
    error: 'Token expired',
    rawResponse
});

const sendToN8N = async (chatInput, appleToken, n8nSessionId) => {
    console.log('[WEBHOOK] Sending to n8n...');
    console.log('[WEBHOOK] chatInput:', chatInput.substring(0, 100) + (chatInput.length > 100 ? '...' : ''));
    console.log('[WEBHOOK] Token present:', !!appleToken);
    console.log('[WEBHOOK] n8nSessionId:', n8nSessionId);

    if (!n8nSessionId || typeof n8nSessionId !== 'string' || !n8nSessionId.trim()) {
        console.error('[WEBHOOK] BLOCKED - n8nSessionId is missing. This would contaminate sessions across users.');
        return { success: false, error: 'Internal error: session ID not set. Please start a new chat.' };
    }

    const payload = {
        chatInput,
        sessionId: n8nSessionId,
        bearerToken: appleToken
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
        const response = await fetch(N8N_WEBHOOK_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json'
            },
            body: JSON.stringify(payload),
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        const contentType = response.headers.get('content-type');
        const text = await response.text();
        const parsedBody = parseWebhookBody(text);

        console.log('[WEBHOOK] Response status:', response.status);
        console.log('[WEBHOOK] Response text:', (text || '').substring(0, 300));

        if (!response.ok) {
            console.error('[WEBHOOK] HTTP error:', response.status);
            if (response.status === 401 || payloadContainsTokenExpired(parsedBody || text)) {
                return buildExpiredTokenResult(response.status, parsedBody || text);
            }
            return { success: false, error: `Webhook returned ${response.status}` };
        }

        if (!text || text.trim() === '') {
            console.error('[WEBHOOK] Empty response from n8n');
            return { success: false, error: 'Empty response from AI service' };
        }

        if (contentType && contentType.includes('application/json')) {
            if (parsedBody && typeof parsedBody !== 'string') {
                if (payloadContainsTokenExpired(parsedBody)) {
                    console.warn('[WEBHOOK] n8n payload indicates expired bearer token.');
                    return buildExpiredTokenResult(response.status, parsedBody);
                }
                console.log('[WEBHOOK] Parsed response:', parsedBody);
                return parsedBody;
            }

            console.error('[WEBHOOK] JSON parse error for response body.');
            return { success: false, error: 'Invalid JSON response from AI service' };
        }

        if (typeof parsedBody !== 'string' && parsedBody) {
            if (payloadContainsTokenExpired(parsedBody)) {
                console.warn('[WEBHOOK] n8n payload indicates expired bearer token.');
                return buildExpiredTokenResult(response.status, parsedBody);
            }
            return parsedBody;
        }

        if (payloadContainsTokenExpired(parsedBody || text)) {
            console.warn('[WEBHOOK] n8n text response indicates expired bearer token.');
            return buildExpiredTokenResult(response.status, parsedBody || text);
        }

        console.error('[WEBHOOK] Non-JSON response:', text);
        return { success: false, error: 'Unexpected response format from AI service' };
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
