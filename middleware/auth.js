const jwt = require('jsonwebtoken');

const getBearerToken = (req) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        console.log('[AUTH MIDDLEWARE] No token provided for:', req.method, req.path);
        return null;
    }

    return authHeader.split(' ')[1];
};

const verifyToken = (token, options = {}) => jwt.verify(token, process.env.JWT_SECRET, options);

const auth = async (req, res, next) => {
    try {
        const token = getBearerToken(req);

        if (!token) {
            return res.status(401).json({ error: 'Access denied. No token provided.' });
        }

        const decoded = verifyToken(token);
        req.user = decoded;
        req.authToken = token;
        console.log(`[AUTH MIDDLEWARE] User: ${decoded.id} | Email: ${decoded.email} | isAgent: ${decoded.isAgent} | Path: ${req.method} ${req.path}`);
        next();
    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Token expired. Please login again.' });
        }
        if (error.name === 'JsonWebTokenError') {
            return res.status(401).json({ error: 'Invalid token.' });
        }
        return res.status(401).json({ error: 'Authentication failed.' });
    }
};

const allowExpired = async (req, res, next) => {
    try {
        const token = getBearerToken(req);

        if (!token) {
            return res.status(401).json({ error: 'Access denied. No token provided.' });
        }

        const decoded = verifyToken(token, { ignoreExpiration: true });
        req.user = decoded;
        req.authToken = token;
        console.log(`[AUTH MIDDLEWARE] Allow-expired auth for user: ${decoded.id} | Email: ${decoded.email} | Path: ${req.method} ${req.path}`);
        next();
    } catch (error) {
        if (error.name === 'JsonWebTokenError') {
            return res.status(401).json({ error: 'Invalid token.' });
        }
        return res.status(401).json({ error: 'Authentication failed.' });
    }
};

module.exports = auth;
module.exports.allowExpired = allowExpired;
