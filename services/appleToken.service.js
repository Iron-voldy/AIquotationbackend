const fetch = require('node-fetch');
const pool = require('../config/database');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const APPLE_API_URL = process.env.APPLE_API_URL || 'https://stagev2.appletechlabs.com/api';
const APPLE_EMAIL = process.env.APPLE_EMAIL || 'john@example.com';
const APPLE_PASSWORD = process.env.APPLE_PASSWORD || 'secret1';

let refreshTimer = null;

// ─── Mutex ───────────────────────────────────────────────────────────────────
// Prevents the "thundering herd" / token-stampede problem:
// When the token expires and multiple concurrent requests all call getValidToken()
// simultaneously, without this guard they each independently call login(), Apple
// issues multiple different tokens, and concurrent requests end up carrying
// different bearerTokens to n8n — causing cross-user quotation contamination.
//
// With this promise, the FIRST caller to detect an expired/missing token kicks
// off a single login(). Every subsequent caller that arrives while that login
// is in-flight receives the same promise and waits for the one shared result.
let _refreshPromise = null;

/**
 * Login to Apple API using form-data and return the access token.
 * Runs inside a DB transaction so there is never a window where the cache
 * table is empty — eliminating the DELETE→(gap)→INSERT race condition.
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

    // Atomic swap — TRUNCATE + INSERT inside a transaction so there is never
    // a gap where the table is empty and another concurrent caller triggers
    // yet another login().
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        await conn.query('DELETE FROM apple_token_cache');
        await conn.query(
            'INSERT INTO apple_token_cache (access_token, expires_at) VALUES (?, ?)',
            [data.access_token, expiresAt]
        );
        await conn.commit();
    } catch (dbErr) {
        await conn.rollback();
        throw dbErr;
    } finally {
        conn.release();
    }

    console.log(`[APPLE TOKEN] Token cached until ${expiresAt.toISOString()}`);

    scheduleRefresh(expiresIn);

    return data.access_token;
};

/**
 * Schedule a token refresh 5 minutes before expiry.
 */
const scheduleRefresh = (expiresIn) => {
    if (refreshTimer) clearTimeout(refreshTimer);

    const refreshIn = Math.max((expiresIn - 300) * 1000, 0);
    console.log(`[APPLE TOKEN] Next refresh scheduled in ${Math.round(refreshIn / 1000)}s`);

    refreshTimer = setTimeout(async () => {
        console.log('[APPLE TOKEN] Auto-refreshing Apple token...');
        try {
            await getValidToken();
        } catch (err) {
            console.error('[APPLE TOKEN] Auto-refresh failed:', err.message);
            // Retry after 60 seconds
            setTimeout(() => getValidToken().catch(console.error), 60000);
        }
    }, refreshIn);
};

/**
 * Get a valid Apple token — from cache or a fresh login.
 *
 * Uses a module-level promise (_refreshPromise) to coalesce concurrent
 * calls: if a refresh/login is already in-flight, every new caller waits
 * for that single shared promise instead of spawning its own login().
 */
const getValidToken = async () => {
    // If a login/refresh is already running, piggyback on it.
    if (_refreshPromise) {
        console.log('[APPLE TOKEN] Coalescing — waiting for in-flight refresh...');
        return _refreshPromise;
    }

    try {
        // Check cache first
        const [rows] = await pool.query(
            'SELECT access_token, expires_at FROM apple_token_cache ORDER BY id DESC LIMIT 1'
        );

        if (rows.length > 0) {
            const { access_token, expires_at } = rows[0];
            const expiresAt = new Date(expires_at);
            const now = new Date();
            const bufferMs = 5 * 60 * 1000; // 5-minute buffer

            if (expiresAt.getTime() - now.getTime() > bufferMs) {
                console.log('[APPLE TOKEN] Using cached token (valid for', Math.round((expiresAt - now) / 1000), 's)');
                return access_token;
            }

            console.log('[APPLE TOKEN] Cached token expired or expiring soon. Refreshing...');
        } else {
            console.log('[APPLE TOKEN] No cached token found. Logging in...');
        }

        // Start a single login; store the promise so concurrent callers wait for it.
        _refreshPromise = login().finally(() => {
            _refreshPromise = null;
        });
        return _refreshPromise;

    } catch (error) {
        console.error('[APPLE TOKEN] getValidToken error:', error.message);
        throw error;
    }
};

/**
 * Initialize on server startup.
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
