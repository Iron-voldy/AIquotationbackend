const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/database');

const generateToken = (user) => {
    return jwt.sign(
        { id: user.id, email: user.email, role: user.role },
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
        const user = { id: userId, name: name.trim(), email: email.toLowerCase().trim(), role: 'user' };

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
            'SELECT id, name, email, password_hash, role, is_active FROM users WHERE email = ?',
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

        const userData = { id: user.id, name: user.name, email: user.email, role: user.role };
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
            'SELECT id, name, email, role, phone, is_active, created_at FROM users WHERE id = ?',
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
        const token = generateToken(user);

        res.json({
            success: true,
            token,
            expiresIn: process.env.JWT_EXPIRES_IN || '24h'
        });
    } catch (error) {
        next(error);
    }
};

// POST /api/auth/logout
exports.logout = async (req, res) => {
    res.json({ success: true, message: 'Logged out successfully.' });
};
