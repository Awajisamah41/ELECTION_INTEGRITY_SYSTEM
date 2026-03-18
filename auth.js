// routes/auth.js
const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../config/database');
const { authenticate } = require('../middleware/auth');

// LOGIN
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const result = await db.query(
      'SELECT * FROM officials WHERE username = $1 AND is_active = TRUE', [username]
    );
    if (!result.rows.length) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const official = result.rows[0];
    const valid = await bcrypt.compare(password, official.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign(
      { id: official.id, username: official.username, role: official.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    );

    await db.query('UPDATE officials SET last_login = NOW() WHERE id = $1', [official.id]);

    res.json({
      token,
      user: {
        id: official.id,
        username: official.username,
        role: official.role,
        first_name: official.first_name,
        last_name: official.last_name
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET CURRENT USER
router.get('/me', authenticate, (req, res) => {
  res.json({ user: req.user });
});

// DASHBOARD STATS
router.get('/stats', authenticate, async (req, res) => {
  try {
    const [voters, accredited, contestants, eligible, parties, elections] = await Promise.all([
      db.query('SELECT COUNT(*) FROM voters WHERE is_active = TRUE'),
      db.query('SELECT COUNT(*) FROM voters WHERE is_accredited = TRUE'),
      db.query('SELECT COUNT(*) FROM contestants WHERE is_active = TRUE'),
      db.query('SELECT COUNT(*) FROM contestants WHERE is_eligible = TRUE'),
      db.query('SELECT COUNT(*) FROM parties WHERE is_active = TRUE'),
      db.query(`SELECT status, COUNT(*) FROM elections GROUP BY status`)
    ]);

    const electionsByStatus = {};
    elections.rows.forEach(r => { electionsByStatus[r.status] = parseInt(r.count); });

    res.json({
      voters: {
        total: parseInt(voters.rows[0].count),
        accredited: parseInt(accredited.rows[0].count),
        accreditation_rate: voters.rows[0].count > 0
          ? ((accredited.rows[0].count / voters.rows[0].count) * 100).toFixed(1) + '%'
          : '0%'
      },
      contestants: {
        total: parseInt(contestants.rows[0].count),
        eligible: parseInt(eligible.rows[0].count),
        ineligible: parseInt(contestants.rows[0].count) - parseInt(eligible.rows[0].count)
      },
      parties: parseInt(parties.rows[0].count),
      elections: electionsByStatus
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
