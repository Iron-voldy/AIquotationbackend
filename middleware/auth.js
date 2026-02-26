const jwt = require('jsonwebtoken');

const auth = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            console.log('[AUTH MIDDLEWARE] No token provided for:', req.method, req.path);
            return res.status(401).json({ error: 'Access denied. No token provided.' });
        }

        const token = authHeader.split(' ')[1];

        if (!token) {
            return res.status(401).json({ error: 'Access denied. Invalid token format.' });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;
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

module.exports = auth;
