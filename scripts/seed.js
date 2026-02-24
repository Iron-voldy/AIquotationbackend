require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('../config/database');

const seedAdmin = async () => {
    try {
        console.log('🌱 Seeding admin user...');

        const email = 'admin@travel.com';
        const password = 'Admin@123';
        const name = 'System Admin';

        // Check if admin already exists
        const [existing] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
        if (existing.length > 0) {
            console.log('✅ Admin user already exists:', email);
            process.exit(0);
        }

        const passwordHash = await bcrypt.hash(password, 12);
        const [result] = await pool.query(
            "INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')",
            [name, email, passwordHash]
        );

        console.log('✅ Admin user created successfully!');
        console.log('   ID:', result.insertId);
        console.log('   Email:', email);
        console.log('   Password:', password);
        console.log('   Role: admin');
        process.exit(0);
    } catch (error) {
        console.error('❌ Seeding failed:', error.message);
        process.exit(1);
    }
};

seedAdmin();
