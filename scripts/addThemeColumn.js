require('dotenv').config();
const pool = require('../config/database');

(async () => {
    try {
        await pool.query("ALTER TABLE users ADD COLUMN theme_preference VARCHAR(10) DEFAULT 'dark'");
        console.log('✅ theme_preference column added successfully');
    } catch (e) {
        if (e.code === 'ER_DUP_FIELDNAME') {
            console.log('✅ theme_preference column already exists');
        } else {
            console.error('❌ Error:', e.message);
        }
    }
    process.exit(0);
})();
