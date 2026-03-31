const pool = require('../config/database');

// GET /api/admin/stats
exports.getStats = async (req, res, next) => {
    try {
        const [[totalUsers]] = await pool.query('SELECT COUNT(*) as count FROM users');
        const [[totalQuotations]] = await pool.query('SELECT COUNT(*) as count FROM quotations');
        const [statusCounts] = await pool.query(
            'SELECT status, COUNT(*) as count FROM quotations GROUP BY status'
        );
        const [dailyTrend] = await pool.query(
            `SELECT DATE(created_at) as date, COUNT(*) as count
       FROM quotations
       WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
       GROUP BY DATE(created_at)
       ORDER BY date ASC`
        );
        const [[activeUsers]] = await pool.query('SELECT COUNT(*) as count FROM users WHERE is_active = 1');

        const statusMap = {};
        statusCounts.forEach(r => { statusMap[r.status] = r.count; });

        res.json({
            success: true,
            stats: {
                totalUsers: totalUsers.count,
                totalQuotations: totalQuotations.count,
                activeUsers: activeUsers.count,
                pending: statusMap.pending || 0,
                accepted: statusMap.accepted || 0,
                rejected: statusMap.rejected || 0,
                acceptanceRate: totalQuotations.count > 0
                    ? Math.round(((statusMap.accepted || 0) / totalQuotations.count) * 100)
                    : 0,
                dailyTrend
            }
        });
    } catch (error) {
        next(error);
    }
};

// GET /api/admin/users
exports.getUsers = async (req, res, next) => {
    try {
        const { page = 1, limit = 10, search } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        let where = '';
        const params = [];

        if (search) {
            where = 'WHERE u.name LIKE ? OR u.email LIKE ?';
            params.push(`%${search}%`, `%${search}%`);
        }

        const [[{ total }]] = await pool.query(
            `SELECT COUNT(*) as total FROM users u ${where}`,
            params
        );

        const [users] = await pool.query(
            `SELECT u.id, u.name, u.email, u.role, u.phone, u.is_active, u.created_at,
         COUNT(q.id) as quotation_count
       FROM users u
       LEFT JOIN quotations q ON q.user_id = u.id
       ${where}
       GROUP BY u.id
       ORDER BY u.created_at DESC
       LIMIT ? OFFSET ?`,
            [...params, parseInt(limit), offset]
        );

        res.json({
            success: true,
            data: users,
            total,
            page: parseInt(page),
            totalPages: Math.ceil(total / parseInt(limit))
        });
    } catch (error) {
        next(error);
    }
};

// GET /api/admin/users/:id
exports.getUser = async (req, res, next) => {
    try {
        const [users] = await pool.query(
            'SELECT id, name, email, role, phone, is_active, created_at FROM users WHERE id = ?',
            [req.params.id]
        );
        if (users.length === 0) return res.status(404).json({ error: 'User not found.' });

        const [quotations] = await pool.query(
            'SELECT * FROM quotations WHERE user_id = ? ORDER BY created_at DESC LIMIT 20',
            [req.params.id]
        );

        res.json({ success: true, user: users[0], quotations });
    } catch (error) {
        next(error);
    }
};

// PATCH /api/admin/users/:id/toggle
exports.toggleUser = async (req, res, next) => {
    try {
        const [rows] = await pool.query('SELECT id, is_active, role FROM users WHERE id = ?', [req.params.id]);
        if (rows.length === 0) return res.status(404).json({ error: 'User not found.' });

        // Prevent admin from deactivating themselves
        if (rows[0].id === req.user.id) {
            return res.status(400).json({ error: 'You cannot deactivate your own account.' });
        }

        const newStatus = !rows[0].is_active;
        await pool.query('UPDATE users SET is_active = ?, updated_at = NOW() WHERE id = ?', [newStatus, req.params.id]);

        const [updated] = await pool.query(
            'SELECT id, name, email, role, is_active FROM users WHERE id = ?',
            [req.params.id]
        );
        res.json({ success: true, user: updated[0] });
    } catch (error) {
        next(error);
    }
};

// GET /api/admin/quotations
exports.getQuotations = async (req, res, next) => {
    try {
        const { page = 1, limit = 20, userId, status, search } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        const where = ['1=1'];
        const params = [];

        if (userId) { where.push('q.user_id = ?'); params.push(userId); }
        if (status) { where.push('q.status = ?'); params.push(status); }
        if (search) { where.push('q.quotation_no LIKE ?'); params.push(`%${search}%`); }

        const whereStr = 'WHERE ' + where.join(' AND ');

        const [[{ total }]] = await pool.query(
            `SELECT COUNT(*) as total FROM quotations q ${whereStr}`,
            params
        );

        const [quotations] = await pool.query(
            `SELECT q.*,
                    COALESCE(u.name, 'Unknown User') as user_name,
                    COALESCE(u.email, '') as user_email
       FROM quotations q
       LEFT JOIN users u ON u.id = q.user_id
       ${whereStr}
       ORDER BY q.created_at DESC
       LIMIT ? OFFSET ?`,
            [...params, parseInt(limit), offset]
        );

        res.json({
            success: true,
            data: quotations,
            total,
            page: parseInt(page),
            totalPages: Math.ceil(total / parseInt(limit))
        });
    } catch (error) {
        next(error);
    }
};
