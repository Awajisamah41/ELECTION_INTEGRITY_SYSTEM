// routes/parties.js
const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

router.get('/', authenticate, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT p.*, COUNT(c.id) AS registered_contestants
       FROM parties p
       LEFT JOIN contestants c ON c.party_id = p.id
       WHERE p.is_active = TRUE
       GROUP BY p.id
       ORDER BY p.name`
    );
    res.json({ parties: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/',
  authenticate,
  authorize('SuperAdmin', 'Commissioner'),
  async (req, res) => {
    try {
      const { name, abbreviation, registration_number, registration_date,
              headquarters_address, contact_email, contact_phone } = req.body;

      if (!name || !abbreviation || !registration_number || !registration_date) {
        return res.status(400).json({ error: 'name, abbreviation, registration_number, registration_date are required' });
      }

      const result = await db.query(
        `INSERT INTO parties (name, abbreviation, registration_number, registration_date, headquarters_address, contact_email, contact_phone)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [name, abbreviation, registration_number, registration_date,
         headquarters_address, contact_email, contact_phone]
      );
      res.status(201).json({ message: 'Party registered', party: result.rows[0] });
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'Party name or abbreviation already exists' });
      res.status(500).json({ error: err.message });
    }
  }
);

router.delete('/:id',
  authenticate,
  authorize('SuperAdmin', 'Commissioner'),
  async (req, res) => {
    try {
      await db.query('UPDATE parties SET is_active = FALSE WHERE id = $1', [req.params.id]);
      res.json({ message: 'Party deregistered' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

module.exports = router;
