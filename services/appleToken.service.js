const fetch = require('node-fetch');
const pool = require('../config/database');
require('dotenv').config();

const APPLE_API_URL = process.env.APPLE_API_URL || 'https://stagev2.appletechlabs.com/api';
const APPLE_EMAIL = process.env.APPLE_EMAIL || 'john@example.com';
const APPLE_PASSWORD = process.env.APPLE_PASSWORD || 'secret1';

let refreshTimer = null;

/**
 * Login to Apple API using form-data and return the access token
 */
const login = async () => {
    console.log('[APPLE TOKEN] Logging in to Apple API...');

    const formData = new URLSearchParams();
    formData.append('email', APPLE_EMAIL);
    formData.append('password', APPLE_PASSWORD);

    const response = await fetch(`${APPLE_API_URL}/auth/login`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json'
        },
        body: formData.toString()
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Apple API login failed: ${response.status} ${text}`);
    }

    const data = await response.json();
    console.log('[APPLE TOKEN] Login successful. Token received.');

    const expiresIn = data.expires_in || 3600;
    const expiresAt = new Date(Date.now() + expiresIn * 1000);

    // Store in DB
    await pool.query('DELETE FROM apple_token_cache');
    await pool.query(
        'INSERT INTO apple_token_cache (access_token, expires_at) VALUES (?, ?)',
        [data.access_token, expiresAt]
    );

    console.log(`[APPLE TOKEN] Token cached until ${expiresAt.toISOString()}`);

    // Schedule refresh 5 minutes before expiry
    scheduleRefresh(expiresIn, data.access_token);

    return data.access_token;
};

/**
 * Schedule a token refresh 5 minutes before expiry
 */
const scheduleRefresh = (expiresIn, currentToken) => {
    if (refreshTimer) clearTimeout(refreshTimer);

    const refreshIn = Math.max((expiresIn - 300) * 1000, 0);
    console.log(`[APPLE TOKEN] Next refresh scheduled in ${Math.round(refreshIn / 1000)}s`);

    refreshTimer = setTimeout(async () => {
        console.log('[APPLE TOKEN] Auto-refreshing Apple token...');
        try {
            await login();
        } catch (err) {
            console.error('[APPLE TOKEN] Auto-refresh failed:', err.message);
            // Retry after 60 seconds
            setTimeout(() => login().catch(console.error), 60000);
        }
    }, refreshIn);
};

/**
 * Get a valid Apple token — from cache or fresh login
 */
const getValidToken = async () => {
    try {
        // Check cache first
        const [rows] = await pool.query(
            'SELECT access_token, expires_at FROM apple_token_cache ORDER BY id DESC LIMIT 1'
        );

        if (rows.length > 0) {
            const { access_token, expires_at } = rows[0];
            const expiresAt = new Date(expires_at);
            const now = new Date();
            const bufferMs = 5 * 60 * 1000; // 5 minute buffer

            if (expiresAt.getTime() - now.getTime() > bufferMs) {
                console.log('[APPLE TOKEN] Using cached token (valid for', Math.round((expiresAt - now) / 1000), 's)');
                return access_token;
            }

            console.log('[APPLE TOKEN] Cached token expired or expiring soon. Refreshing...');
        } else {
            console.log('[APPLE TOKEN] No cached token found. Logging in...');
        }

        return await login();
    } catch (error) {
        console.error('[APPLE TOKEN] getValidToken error:', error.message);
        throw error;
    }
};

/**
 * Initialize on server startup
 */
const initialize = async () => {
    try {
        console.log('[APPLE TOKEN] Initializing shared Apple API token...');
        await getValidToken();
        console.log('[APPLE TOKEN] ✅ Apple token ready');
    } catch (error) {
        console.error('[APPLE TOKEN] ⚠️ Could not acquire Apple token on startup:', error.message);
        console.error('[APPLE TOKEN] Will retry on first request');
    }
};

module.exports = { getValidToken, login, initialize };
