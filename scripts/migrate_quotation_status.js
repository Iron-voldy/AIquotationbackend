require('dotenv').config();
const pool = require('../config/database');

(async () => {
    try {
        await pool.query(
            "ALTER TABLE chat_messages ADD COLUMN quotation_status ENUM('pending','accepted','rejected') DEFAULT 'pending'"
        );
        console.log('✅ Migration success: quotation_status column added to chat_messages');
    } catch (err) {
        if (err.code === 'ER_DUP_FIELDNAME') {
            console.log('ℹ️  Column quotation_status already exists — skipping.');
        } else {
            console.error('❌ Migration failed:', err.message);
            process.exit(1);
        }
    } finally {
        process.exit(0);
    }
})();
