const fetch = require('node-fetch');
const pool = require('../config/database');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const APPLE_API_URL = process.env.APPLE_API_URL || 'https://stagev2.appletechlabs.com/api';
const APPLE_EMAIL = process.env.APPLE_EMAIL || 'john@example.com';
const APPLE_PASSWORD = process.env.APPLE_PASSWORD || 'secret1';

let refreshTimer = null;

// Prevent multiple concurrent shared-token refreshes from racing each other.
let refreshPromise = null;

const getAccessTokenFromResponse = (data = {}) => data.access_token || data.token || null;

const cacheSharedToken = async (accessToken, expiresIn = 3600) => {
    const expiresAt = new Date(Date.now() + expiresIn * 1000);

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        await conn.query('DELETE FROM apple_token_cache');
        await conn.query(
            'INSERT INTO apple_token_cache (access_token, expires_at) VALUES (?, ?)',
            [accessToken, expiresAt]
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
    return accessToken;
};

const refreshAppleBearer = async (currentToken) => {
    const response = await fetch(`${APPLE_API_URL}/auth/refresh`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${currentToken}`,
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Apple API refresh failed: ${response.status} ${text}`);
    }

    const data = await response.json();
    const accessToken = getAccessTokenFromResponse(data);
    if (!accessToken) {
        throw new Error('Apple API refresh response did not include an access token.');
    }

    return {
        accessToken,
        expiresIn: data.expires_in || 3600
    };
};

const login = async () => {
    console.log(`[APPLE TOKEN] Logging in to Apple API as ${APPLE_EMAIL}...`);

    const formData = new URLSearchParams();
    formData.append('email', APPLE_EMAIL);
    formData.append('password', APPLE_PASSWORD);

    const response = await fetch(`${APPLE_API_URL}/auth/login`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json'
        },
        body: formData.toString()
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Apple API login failed: ${response.status} ${text}`);
    }

    const data = await response.json();
    const accessToken = getAccessTokenFromResponse(data);
    if (!accessToken) {
        throw new Error('Apple API login response did not include an access token.');
    }

    console.log('[APPLE TOKEN] Login successful. Token received.');
    return cacheSharedToken(accessToken, data.expires_in || 3600);
};

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
            setTimeout(() => getValidToken().catch(console.error), 60000);
        }
    }, refreshIn);
};

const refreshSharedToken = async (currentToken) => {
    try {
        let tokenToRefresh = currentToken;

        if (!tokenToRefresh) {
            const [rows] = await pool.query(
                'SELECT access_token FROM apple_token_cache ORDER BY id DESC LIMIT 1'
            );
            tokenToRefresh = rows[0]?.access_token || null;
        }

        if (tokenToRefresh) {
            console.log(`[APPLE TOKEN] Refreshing shared Apple token for ${APPLE_EMAIL}...`);
            const refreshed = await refreshAppleBearer(tokenToRefresh);
            return cacheSharedToken(refreshed.accessToken, refreshed.expiresIn);
        }
    } catch (error) {
        console.warn('[APPLE TOKEN] Shared token refresh failed, falling back to login:', error.message);
    }

    console.log(`[APPLE TOKEN] Re-authenticating shared Apple user ${APPLE_EMAIL}...`);
    return login();
};

const forceRefreshSharedToken = async (currentToken) => {
    if (refreshPromise) {
        console.log('[APPLE TOKEN] Reusing in-flight shared-token refresh...');
        return refreshPromise;
    }

    refreshPromise = refreshSharedToken(currentToken).finally(() => {
        refreshPromise = null;
    });

    return refreshPromise;
};

const getValidToken = async () => {
    if (refreshPromise) {
        console.log('[APPLE TOKEN] Coalescing and waiting for in-flight shared-token refresh...');
        return refreshPromise;
    }

    try {
        const [rows] = await pool.query(
            'SELECT access_token, expires_at FROM apple_token_cache ORDER BY id DESC LIMIT 1'
        );

        if (rows.length > 0) {
            const { access_token, expires_at } = rows[0];
            const expiresAt = new Date(expires_at);
            const now = new Date();
            const bufferMs = 5 * 60 * 1000;

            if (expiresAt.getTime() - now.getTime() > bufferMs) {
                console.log('[APPLE TOKEN] Using cached token (valid for', Math.round((expiresAt - now) / 1000), 's)');
                return access_token;
            }

            console.log('[APPLE TOKEN] Cached token expired or expiring soon. Refreshing...');
            return forceRefreshSharedToken(access_token);
        }

        console.log('[APPLE TOKEN] No cached token found. Logging in...');
        return forceRefreshSharedToken(null);
    } catch (error) {
        console.error('[APPLE TOKEN] getValidToken error:', error.message);
        throw error;
    }
};

const refreshAgentToken = async (userId, currentToken) => {
    if (!currentToken) {
        throw new Error('No agent token available for refresh.');
    }

    console.log(`[APPLE TOKEN] Refreshing agent token for user ${userId}...`);
    const refreshed = await refreshAppleBearer(currentToken);
    const expiresAt = new Date(Date.now() + refreshed.expiresIn * 1000);

    await pool.query(
        `INSERT INTO agent_tokens (user_id, apple_access_token, expires_at)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE apple_access_token = VALUES(apple_access_token), expires_at = VALUES(expires_at)`,
        [userId, refreshed.accessToken, expiresAt]
    );

    console.log(`[APPLE TOKEN] Agent token refreshed for user ${userId}`);
    return refreshed.accessToken;
};

const initialize = async () => {
    try {
        console.log('[APPLE TOKEN] Initializing shared Apple API token...');
        await getValidToken();
        console.log('[APPLE TOKEN] Shared Apple token ready');
    } catch (error) {
        console.error('[APPLE TOKEN] Could not acquire Apple token on startup:', error.message);
        console.error('[APPLE TOKEN] Will retry on first request');
    }
};

module.exports = {
    getValidToken,
    login,
    refreshSharedToken,
    forceRefreshSharedToken,
    refreshAgentToken,
    initialize
};
