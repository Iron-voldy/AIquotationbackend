const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/database');

const generateToken = (user) => {
    return jwt.sign(
        { id: user.id, email: user.email, role: user.role, isAgent: !!user.isAgent },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
    );
};

// POST /api/auth/register
exports.register = async (req, res, next) => {
    try {
        const { name, email, password, confirmPassword } = req.body;

        // Validation
        if (!name || !email || !password || !confirmPassword) {
            return res.status(400).json({ error: 'All fields are required.' });
        }

        if (password !== confirmPassword) {
            return res.status(400).json({ error: 'Passwords do not match.' });
        }

        if (name.trim().length > 100) {
            return res.status(400).json({ error: 'Full name must be 100 characters or fewer.' });
        }

        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters.' });
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ error: 'Invalid email format.' });
        }

        // Check uniqueness
        const [existing] = await pool.query('SELECT id FROM users WHERE email = ?', [email.toLowerCase()]);
        if (existing.length > 0) {
            return res.status(409).json({ error: 'An account with this email already exists.' });
        }

        // Hash password
        const passwordHash = await bcrypt.hash(password, 12);

        // Insert user
        const [result] = await pool.query(
            'INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)',
            [name.trim(), email.toLowerCase().trim(), passwordHash, 'user']
        );

        const userId = result.insertId;
        const user = { id: userId, name: name.trim(), email: email.toLowerCase().trim(), role: 'user', theme_preference: 'dark' };

        const token = generateToken(user);

        res.status(201).json({
            success: true,
            user,
            token,
            expiresIn: process.env.JWT_EXPIRES_IN || '24h'
        });
    } catch (error) {
        next(error);
    }
};

// POST /api/auth/login
exports.login = async (req, res, next) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required.' });
        }

        // Find user
        const [rows] = await pool.query(
            'SELECT id, name, email, password_hash, role, is_active, theme_preference FROM users WHERE email = ?',
            [email.toLowerCase().trim()]
        );

        if (rows.length === 0) {
            return res.status(401).json({ error: 'Invalid email or password.' });
        }

        const user = rows[0];

        if (!user.is_active) {
            return res.status(403).json({ error: 'Your account has been deactivated. Please contact admin.' });
        }

        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) {
            return res.status(401).json({ error: 'Invalid email or password.' });
        }

        const userData = { id: user.id, name: user.name, email: user.email, role: user.role, theme_preference: user.theme_preference || 'dark' };
        const token = generateToken(userData);

        res.json({
            success: true,
            user: userData,
            token,
            expiresIn: process.env.JWT_EXPIRES_IN || '24h'
        });
    } catch (error) {
        next(error);
    }
};

// GET /api/auth/me
exports.me = async (req, res, next) => {
    try {
        const [rows] = await pool.query(
            'SELECT id, name, email, role, phone, is_active, theme_preference, created_at FROM users WHERE id = ?',
            [req.user.id]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: 'User not found.' });
        }

        res.json({ success: true, user: rows[0] });
    } catch (error) {
        next(error);
    }
};

// POST /api/auth/refresh
exports.refresh = async (req, res, next) => {
    try {
        const [rows] = await pool.query(
            'SELECT id, name, email, role FROM users WHERE id = ? AND is_active = 1',
            [req.user.id]
        );

        if (rows.length === 0) {
            return res.status(401).json({ error: 'User not found or inactive.' });
        }

        const user = rows[0];
        const token = generateToken({ ...user, isAgent: !!req.user.isAgent });

        // For agents: also refresh their Apple API token so they stay logged in
        let newAppleToken = null;
        if (req.user.isAgent) {
            try {
                const [agentRows] = await pool.query(
                    'SELECT apple_access_token FROM agent_tokens WHERE user_id = ?',
                    [user.id]
                );
                if (agentRows.length > 0) {
                    const currentAppleToken = agentRows[0].apple_access_token;
                    const APPLE_API_URL = process.env.APPLE_API_URL || 'https://stagev2.appletechlabs.com/api';
                    const appleRefreshRes = await fetch(`${APPLE_API_URL}/auth/refresh`, {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${currentAppleToken}`,
                            'Accept': 'application/json',
                            'Content-Type': 'application/x-www-form-urlencoded'
                        }
                    });
                    if (appleRefreshRes.ok) {
                        const appleData = await appleRefreshRes.json();
                        newAppleToken = appleData.access_token || appleData.token;
                        if (newAppleToken) {
                            const expiresIn = appleData.expires_in || 3600;
                            const expiresAt = new Date(Date.now() + expiresIn * 1000);
                            await pool.query(
                                'UPDATE agent_tokens SET apple_access_token = ?, expires_at = ? WHERE user_id = ?',
                                [newAppleToken, expiresAt, user.id]
                            );
                            console.log('[REFRESH] Apple token refreshed for agent user:', user.id);
                        }
                    } else {
                        console.warn('[REFRESH] Apple token refresh failed, status:', appleRefreshRes.status);
                    }
                }
            } catch (appleErr) {
                console.error('[REFRESH] Apple token refresh error:', appleErr.message);
                // Don't fail the whole refresh if Apple refresh fails — just return the new JWT
            }
        }

        res.json({
            success: true,
            token,
            expiresIn: process.env.JWT_EXPIRES_IN || '24h',
            ...(newAppleToken && { appleAccessToken: newAppleToken })
        });
    } catch (error) {
        next(error);
    }
};

// PUT /api/auth/theme
exports.updateTheme = async (req, res, next) => {
    try {
        const { themePreference } = req.body;
        if (!themePreference || !['light', 'dark'].includes(themePreference)) {
            return res.status(400).json({ error: 'themePreference must be "light" or "dark".' });
        }
        await pool.query('UPDATE users SET theme_preference = ? WHERE id = ?', [themePreference, req.user.id]);
        res.json({ success: true, themePreference });
    } catch (error) {
        next(error);
    }
};

// POST /api/auth/logout
exports.logout = async (req, res) => {
    res.json({ success: true, message: 'Logged out successfully.' });
};

// POST /api/auth/agent-login  — authenticate against external Apple API
exports.agentLogin = async (req, res, next) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required.' });
        }

        const APPLE_API_URL = process.env.APPLE_API_URL || 'https://stagev2.appletechlabs.com/api';

        // Authenticate against external Apple API
        const fetch = require('node-fetch');
        const formData = new URLSearchParams();
        formData.append('email', email.toLowerCase().trim());
        formData.append('password', password);

        const appleRes = await fetch(`${APPLE_API_URL}/auth/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'application/json'
            },
            body: formData.toString()
        });

        if (!appleRes.ok) {
            const text = await appleRes.text();
            console.error('[AGENT LOGIN] Apple API login failed:', appleRes.status, text);
            return res.status(401).json({ error: 'Invalid agent credentials. Please check your email and password.' });
        }

        const appleData = await appleRes.json();
        console.log('[AGENT LOGIN] Apple API login successful for:', email);

        // Extract agent info from Apple API response
        const agentEmail = email.toLowerCase().trim();
        const agentName = appleData.user?.name || appleData.name || agentEmail.split('@')[0];
        const appleAccessToken = appleData.access_token || appleData.token;

        // Create or find agent user in local DB so they can use the system
        let [existing] = await pool.query('SELECT id, name, email, role, is_active, theme_preference FROM users WHERE email = ?', [agentEmail]);

        let localUser;
        if (existing.length > 0) {
            localUser = existing[0];
            if (!localUser.is_active) {
                return res.status(403).json({ error: 'Your agent account has been deactivated. Please contact admin.' });
            }
        } else {
            // Auto-create a local agent user (no local password needed — they auth via Apple API)
            const placeholderHash = await bcrypt.hash(`__agent__${Date.now()}__`, 10);
            const [result] = await pool.query(
                'INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)',
                [agentName, agentEmail, placeholderHash, 'user']
            );
            localUser = { id: result.insertId, name: agentName, email: agentEmail, role: 'user', theme_preference: 'dark' };
            console.log('[AGENT LOGIN] Created local agent user:', agentEmail, 'id:', localUser.id);
        }

        // Store the agent's Apple access token in DB for use in chat
        if (appleAccessToken) {
            const expiresIn = appleData.expires_in || 3600;
            const expiresAt = new Date(Date.now() + expiresIn * 1000);
            // Create agent_tokens table if it doesn't exist
            await pool.query(`
                CREATE TABLE IF NOT EXISTS agent_tokens (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    user_id INT NOT NULL,
                    apple_access_token TEXT NOT NULL,
                    expires_at TIMESTAMP NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE KEY idx_user_id (user_id)
                )
            `);
            // Upsert the agent's token
            await pool.query(
                `INSERT INTO agent_tokens (user_id, apple_access_token, expires_at)
                 VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE apple_access_token = VALUES(apple_access_token), expires_at = VALUES(expires_at)`,
                [localUser.id, appleAccessToken, expiresAt]
            );
            console.log('[AGENT LOGIN] Stored Apple token for user:', localUser.id);
        }

        // Issue a local JWT so the agent can use dashboard, chat, quotations
        const userData = {
            id: localUser.id,
            name: localUser.name || agentName,
            email: localUser.email,
            role: localUser.role || 'user',
            theme_preference: localUser.theme_preference || 'dark',
            isAgent: true
        };
        const token = generateToken(userData);

        res.json({
            success: true,
            user: userData,
            token,
            appleAccessToken: appleAccessToken || null,
            expiresIn: process.env.JWT_EXPIRES_IN || '24h'
        });
    } catch (error) {
        console.error('[AGENT LOGIN] Error:', error.message);
        next(error);
    }
};
