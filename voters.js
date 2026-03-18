// routes/voters.js
const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { body, param, query, validationResult } = require('express-validator');

// Helper: format validation errors
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty())
    return res.status(400).json({ errors: errors.array() });
  next();
};

// ─── GET ALL VOTERS (paginated + filtered) ───────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const { page = 1, limit = 20, state, lga, accredited, search } = req.query;
    const offset = (page - 1) * limit;
    const params = [];
    const conditions = [];

    if (state) { params.push(state); conditions.push(`state = $${params.length}`); }
    if (lga) { params.push(lga); conditions.push(`lga = $${params.length}`); }
    if (accredited !== undefined) {
      params.push(accredited === 'true');
      conditions.push(`is_accredited = $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(first_name ILIKE $${params.length} OR last_name ILIKE $${params.length} OR voter_id ILIKE $${params.length})`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(parseInt(limit), parseInt(offset));

    const [votersResult, countResult] = await Promise.all([
      db.query(
        `SELECT id, voter_id, first_name, last_name, age, gender, state, lga, ward,
                polling_unit, is_accredited, accreditation_date, is_eligible, registration_date
         FROM voters ${where}
         ORDER BY created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      ),
      db.query(`SELECT COUNT(*) FROM voters ${where}`, params.slice(0, -2))
    ]);

    res.json({
      voters: votersResult.rows,
      total: parseInt(countResult.rows[0].count),
      page: parseInt(page),
      pages: Math.ceil(countResult.rows[0].count / limit)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── REGISTER A VOTER ─────────────────────────────────────────────────────────
router.post('/',
  authenticate,
  authorize('SuperAdmin', 'Commissioner', 'ReturningOfficer', 'PollingOfficer'),
  [
    body('national_id').notEmpty().withMessage('National ID is required'),
    body('first_name').notEmpty().trim(),
    body('last_name').notEmpty().trim(),
    body('date_of_birth').isDate().withMessage('Valid date of birth required'),
    body('gender').isIn(['Male', 'Female', 'Other']),
    body('address').notEmpty(),
    body('state').notEmpty(),
    body('lga').notEmpty(),
    body('ward').notEmpty(),
  ],
  validate,
  async (req, res) => {
    try {
      const {
        national_id, first_name, last_name, date_of_birth,
        gender, phone, email, address, state, lga, ward, polling_unit
      } = req.body;

      // Age check: must be >= 18
      const dob = new Date(date_of_birth);
      const age = Math.floor((Date.now() - dob) / (1000 * 60 * 60 * 24 * 365.25));
      if (age < 18) {
        return res.status(400).json({
          error: 'Voter must be at least 18 years old',
          age_provided: age
        });
      }

      // Check duplicate
      const exists = await db.query(
        'SELECT id FROM voters WHERE national_id = $1', [national_id]
      );
      if (exists.rows.length) {
        return res.status(409).json({ error: 'Voter with this National ID already registered' });
      }

      // Generate voter ID
      const voter_id = `VTR-${state.toUpperCase().slice(0, 3)}-${Date.now().toString().slice(-8)}`;

      const result = await db.query(
        `INSERT INTO voters
          (voter_id, national_id, first_name, last_name, date_of_birth, gender,
           phone, email, address, state, lga, ward, polling_unit)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING *`,
        [voter_id, national_id, first_name, last_name, date_of_birth, gender,
         phone, email, address, state, lga, ward, polling_unit]
      );

      // Audit log
      await db.query(
        `INSERT INTO audit_logs (table_name, record_id, action, new_data, performed_by, ip_address)
         VALUES ('voters', $1, 'INSERT', $2, $3, $4)`,
        [result.rows[0].id, result.rows[0], req.user.id, req.ip]
      );

      res.status(201).json({ message: 'Voter registered successfully', voter: result.rows[0] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ─── ACCREDIT A VOTER ─────────────────────────────────────────────────────────
router.patch('/:id/accredit',
  authenticate,
  authorize('SuperAdmin', 'Commissioner', 'ReturningOfficer', 'PollingOfficer'),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { election_id, polling_unit_id, accreditation_method } = req.body;

      const voter = await db.query('SELECT * FROM voters WHERE id = $1', [id]);
      if (!voter.rows.length) return res.status(404).json({ error: 'Voter not found' });

      if (voter.rows[0].is_accredited) {
        return res.status(400).json({ error: 'Voter is already accredited' });
      }

      // Update voter accreditation
      const updated = await db.query(
        `UPDATE voters SET is_accredited = TRUE, accreditation_date = NOW(),
          accreditation_officer_id = $2, updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [id, req.user.id]
      );

      // Log accreditation
      if (election_id && polling_unit_id) {
        await db.query(
          `INSERT INTO accreditation_logs
            (voter_id, election_id, polling_unit_id, officer_id, accreditation_method)
           VALUES ($1, $2, $3, $4, $5)`,
          [id, election_id, polling_unit_id, req.user.id, accreditation_method || 'Biometric']
        );
      }

      res.json({ message: 'Voter accredited successfully', voter: updated.rows[0] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ─── GET VOTER BY ID ──────────────────────────────────────────────────────────
router.get('/:id', authenticate, async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM voters WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Voter not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
