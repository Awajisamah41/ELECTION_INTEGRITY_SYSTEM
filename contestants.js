// routes/contestants.js
const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { body, validationResult } = require('express-validator');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

// ─── GET ALL CONTESTANTS ───────────────────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const { eligible, party_id, position, page = 1, limit = 20 } = req.query;
    const params = [];
    const conditions = [];
    const offset = (page - 1) * limit;

    if (eligible !== undefined) {
      params.push(eligible === 'true');
      conditions.push(`c.is_eligible = $${params.length}`);
    }
    if (party_id) {
      params.push(party_id);
      conditions.push(`c.party_id = $${params.length}`);
    }
    if (position) {
      params.push(`%${position}%`);
      conditions.push(`c.position_sought ILIKE $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(parseInt(limit), parseInt(offset));

    const result = await db.query(
      `SELECT c.*, p.name AS party_name, p.abbreviation AS party_abbr
       FROM contestants c
       LEFT JOIN parties p ON c.party_id = p.id
       ${where}
       ORDER BY c.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({ contestants: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── REGISTER CONTESTANT ───────────────────────────────────────────────────────
router.post('/',
  authenticate,
  authorize('SuperAdmin', 'Commissioner', 'ReturningOfficer'),
  [
    body('national_id').notEmpty(),
    body('first_name').notEmpty().trim(),
    body('last_name').notEmpty().trim(),
    body('date_of_birth').isDate(),
    body('party_id').isUUID(),
    body('position_sought').notEmpty(),
    body('state').notEmpty(),
  ],
  validate,
  async (req, res) => {
    try {
      const {
        national_id, first_name, last_name, date_of_birth,
        gender, phone, email, address, state, party_id,
        position_sought, constituency,
        has_criminal_record, criminal_record_details,
        assets_declared, asset_declaration_url,
        passed_primary, primary_election_date, primary_votes
      } = req.body;

      // Check party exists and is active
      const party = await db.query(
        'SELECT id FROM parties WHERE id = $1 AND is_active = TRUE', [party_id]
      );
      if (!party.rows.length) {
        return res.status(400).json({ error: 'Party not found or inactive' });
      }

      // Check duplicate
      const exists = await db.query(
        'SELECT id FROM contestants WHERE national_id = $1', [national_id]
      );
      if (exists.rows.length) {
        return res.status(409).json({ error: 'Contestant already registered' });
      }

      const result = await db.query(
        `INSERT INTO contestants
          (national_id, first_name, last_name, date_of_birth, gender, phone, email,
           address, state, party_id, position_sought, constituency,
           has_criminal_record, criminal_record_details,
           assets_declared, asset_declaration_url, asset_declaration_date,
           passed_primary, primary_election_date, primary_votes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
                 CASE WHEN $15 THEN NOW() ELSE NULL END,
                 $17,$18,$19)
         RETURNING *`,
        [
          national_id, first_name, last_name, date_of_birth, gender, phone, email,
          address, state, party_id, position_sought, constituency,
          has_criminal_record || false, criminal_record_details || null,
          assets_declared || false, asset_declaration_url || null,
          passed_primary || false, primary_election_date || null, primary_votes || null
        ]
      );

      // Audit
      await db.query(
        `INSERT INTO audit_logs (table_name, record_id, action, new_data, performed_by, ip_address)
         VALUES ('contestants', $1, 'INSERT', $2, $3, $4)`,
        [result.rows[0].id, result.rows[0], req.user.id, req.ip]
      );

      res.status(201).json({
        message: 'Contestant registered successfully',
        contestant: result.rows[0],
        eligibility_status: {
          is_eligible: result.rows[0].is_eligible,
          reason: result.rows[0].ineligibility_reason
        }
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ─── UPDATE CONTESTANT ELIGIBILITY FLAGS ──────────────────────────────────────
router.patch('/:id/eligibility',
  authenticate,
  authorize('SuperAdmin', 'Commissioner'),
  async (req, res) => {
    try {
      const { id } = req.params;
      const {
        has_criminal_record, criminal_record_details,
        assets_declared, asset_declaration_url,
        passed_primary, primary_election_date, primary_votes
      } = req.body;

      const old = await db.query('SELECT * FROM contestants WHERE id = $1', [id]);
      if (!old.rows.length) return res.status(404).json({ error: 'Contestant not found' });

      const result = await db.query(
        `UPDATE contestants SET
          has_criminal_record = COALESCE($2, has_criminal_record),
          criminal_record_details = COALESCE($3, criminal_record_details),
          assets_declared = COALESCE($4, assets_declared),
          asset_declaration_url = COALESCE($5, asset_declaration_url),
          asset_declaration_date = CASE WHEN $4 = TRUE THEN NOW() ELSE asset_declaration_date END,
          passed_primary = COALESCE($6, passed_primary),
          primary_election_date = COALESCE($7, primary_election_date),
          primary_votes = COALESCE($8, primary_votes),
          updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [id, has_criminal_record, criminal_record_details, assets_declared,
         asset_declaration_url, passed_primary, primary_election_date, primary_votes]
      );

      // Audit
      await db.query(
        `INSERT INTO audit_logs (table_name, record_id, action, old_data, new_data, performed_by, ip_address)
         VALUES ('contestants', $1, 'UPDATE', $2, $3, $4, $5)`,
        [id, old.rows[0], result.rows[0], req.user.id, req.ip]
      );

      res.json({
        message: 'Eligibility updated',
        contestant: result.rows[0],
        eligibility: {
          is_eligible: result.rows[0].is_eligible,
          reason: result.rows[0].ineligibility_reason
        }
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ─── GET CONTESTANT BY ID ─────────────────────────────────────────────────────
router.get('/:id', authenticate, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT c.*, p.name AS party_name, p.abbreviation AS party_abbr
       FROM contestants c LEFT JOIN parties p ON c.party_id = p.id
       WHERE c.id = $1`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Contestant not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
