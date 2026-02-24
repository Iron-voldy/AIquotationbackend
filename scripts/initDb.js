require('dotenv').config();
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

async function runInit() {
    // First connect without a database
    const conn = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT) || 3306,
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        multipleStatements: true
    });

    console.log('✅ Connected to MySQL');

    const sql = fs.readFileSync(path.join(__dirname, '../sql/init.sql'), 'utf8');

    // Split on semicolons and run each statement
    const statements = sql.split(';').map(s => s.trim()).filter(s => s.length > 0);

    for (const stmt of statements) {
        try {
            await conn.query(stmt);
            console.log('✅ Executed:', stmt.split('\n')[0].substring(0, 60));
        } catch (err) {
            if (err.code === 'ER_TABLE_EXISTS_ERROR' || err.code === 'ER_DB_CREATE_EXISTS') {
                console.log('⏭️  Already exists, skipping:', stmt.split('\n')[0].substring(0, 40));
            } else {
                console.error('❌ Error on statement:', stmt.split('\n')[0].substring(0, 60));
                console.error('   Error:', err.message);
            }
        }
    }

    await conn.end();
    console.log('\n✅ Database initialization complete!');
    process.exit(0);
}

runInit().catch(err => {
    console.error('❌ Fatal error:', err.message);
    process.exit(1);
});
