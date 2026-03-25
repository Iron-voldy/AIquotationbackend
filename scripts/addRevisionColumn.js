/**
 * Migration: Add `revision` column to the quotations table.
 * Run once: node scripts/addRevisionColumn.js
 */
const pool = require('../config/database');

async function migrate() {
    try {
        // Check if column already exists
        const [cols] = await pool.query(
            `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME   = 'quotations'
               AND COLUMN_NAME  = 'revision'`
        );

        if (cols.length > 0) {
            console.log('[MIGRATE] Column `revision` already exists on quotations — nothing to do.');
        } else {
            await pool.query(
                `ALTER TABLE quotations
                 ADD COLUMN revision INT NOT NULL DEFAULT 1
                 AFTER status`
            );
            console.log('[MIGRATE] Column `revision` added to quotations successfully.');
        }

        process.exit(0);
    } catch (err) {
        console.error('[MIGRATE] Error:', err.message);
        process.exit(1);
    }
}

migrate();
