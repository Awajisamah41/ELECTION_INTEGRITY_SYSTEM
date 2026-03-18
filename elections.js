// routes/elections.js
const express = require('express');
const router = express.Router();
const db = require('../config/database');
const crypto = require('crypto');
const { authenticate, authorize } = require('../middleware/auth');
const { body, validationResult } = require('express-validator');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

// ─── LIST ELECTIONS ────────────────────────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const { status, type } = req.query;
    const params = [];
    const conditions = [];

    if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
    if (type) { params.push(type); conditions.push(`election_type = $${params.length}`); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await db.query(
      `SELECT * FROM elections ${where} ORDER BY election_date DESC`, params
    );
    res.json({ elections: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── CREATE ELECTION ───────────────────────────────────────────────────────────
router.post('/',
  authenticate,
  authorize('SuperAdmin', 'Commissioner'),
  [
    body('title').notEmpty(),
    body('election_type').isIn([
      'Presidential', 'Gubernatorial', 'Senatorial',
      'House of Representatives', 'State Assembly', 'Local Government', 'Primary'
    ]),
    body('election_date').isDate(),
    body('start_time').notEmpty(),
    body('end_time').notEmpty(),
  ],
  validate,
  async (req, res) => {
    try {
      const { title, election_type, election_date, start_time, end_time, state, constituency } = req.body;

      const result = await db.query(
        `INSERT INTO elections (title, election_type, election_date, start_time, end_time, state, constituency, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [title, election_type, election_date, start_time, end_time, state, constituency, req.user.id]
      );
      res.status(201).json({ message: 'Election created', election: result.rows[0] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ─── ADD CONTESTANT TO ELECTION BALLOT ────────────────────────────────────────
router.post('/:election_id/contestants',
  authenticate,
  authorize('SuperAdmin', 'Commissioner', 'ReturningOfficer'),
  async (req, res) => {
    try {
      const { election_id } = req.params;
      const { contestant_id } = req.body;

      // Verify contestant eligibility
      const contestant = await db.query(
        'SELECT * FROM contestants WHERE id = $1', [contestant_id]
      );
      if (!contestant.rows.length) {
        return res.status(404).json({ error: 'Contestant not found' });
      }

      const c = contestant.rows[0];
      if (!c.is_eligible) {
        return res.status(400).json({
          error: 'Contestant is not eligible for the ballot',
          reason: c.ineligibility_reason,
          checks: {
            passed_primary: c.passed_primary,
            assets_declared: c.assets_declared,
            no_criminal_record: !c.has_criminal_record,
          }
        });
      }

      // Get next ballot number
      const ballotCount = await db.query(
        'SELECT COUNT(*) FROM election_contestants WHERE election_id = $1', [election_id]
      );
      const ballot_number = parseInt(ballotCount.rows[0].count) + 1;

      const result = await db.query(
        `INSERT INTO election_contestants (election_id, contestant_id, ballot_number, is_approved, approved_by, approval_date)
         VALUES ($1, $2, $3, TRUE, $4, NOW())
         ON CONFLICT (election_id, contestant_id) DO NOTHING
         RETURNING *`,
        [election_id, contestant_id, ballot_number, req.user.id]
      );

      if (!result.rows.length) {
        return res.status(409).json({ error: 'Contestant already on ballot for this election' });
      }

      res.status(201).json({ message: 'Contestant added to ballot', entry: result.rows[0] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ─── SUBMIT RESULTS (Polling Unit Level) ─────────────────────────────────────
router.post('/:election_id/results',
  authenticate,
  authorize('SuperAdmin', 'Commissioner', 'ReturningOfficer', 'PollingOfficer'),
  [
    body('polling_unit_id').isUUID(),
    body('results').isArray().withMessage('Results must be an array'),
    body('results.*.election_contestant_id').isUUID(),
    body('results.*.votes_received').isInt({ min: 0 }),
  ],
  validate,
  async (req, res) => {
    try {
      const { election_id } = req.params;
      const { polling_unit_id, results, result_document_url } = req.body;

      // Verify election exists and is ongoing/completed
      const election = await db.query(
        'SELECT * FROM elections WHERE id = $1', [election_id]
      );
      if (!election.rows.length) return res.status(404).json({ error: 'Election not found' });
      if (!['Ongoing', 'Completed'].includes(election.rows[0].status)) {
        return res.status(400).json({ error: 'Results can only be submitted for Ongoing or Completed elections' });
      }

      const insertedResults = [];

      for (const r of results) {
        const inserted = await db.query(
          `INSERT INTO election_results
            (election_id, election_contestant_id, polling_unit_id,
             votes_received, upload_officer_id, result_document_url)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (election_id, election_contestant_id, polling_unit_id)
           DO UPDATE SET votes_received = $4, updated_at = NOW()
           RETURNING *`,
          [election_id, r.election_contestant_id, polling_unit_id,
           r.votes_received, req.user.id, result_document_url]
        );
        insertedResults.push(inserted.rows[0]);
      }

      // Update total votes on election
      await db.query(
        `UPDATE elections SET
          total_votes_cast = (
            SELECT COALESCE(SUM(votes_received), 0) FROM election_results WHERE election_id = $1
          ),
          updated_at = NOW()
         WHERE id = $1`,
        [election_id]
      );

      res.status(201).json({
        message: 'Results submitted successfully',
        results: insertedResults
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ─── UPLOAD TO CENTRAL SERVER ─────────────────────────────────────────────────
router.post('/:election_id/upload-to-central',
  authenticate,
  authorize('SuperAdmin', 'Commissioner'),
  async (req, res) => {
    try {
      const { election_id } = req.params;

      // Aggregate results
      const results = await db.query(
        `SELECT er.*, ec.ballot_number,
                c.first_name || ' ' || c.last_name AS contestant_name,
                p.abbreviation AS party,
                pu.pu_code, pu.name AS polling_unit_name, pu.state, pu.lga
         FROM election_results er
         JOIN election_contestants ec ON er.election_contestant_id = ec.id
         JOIN contestants c ON ec.contestant_id = c.id
         LEFT JOIN parties p ON c.party_id = p.id
         LEFT JOIN polling_units pu ON er.polling_unit_id = pu.id
         WHERE er.election_id = $1
         ORDER BY er.polling_unit_id, ec.ballot_number`,
        [election_id]
      );

      const election = await db.query('SELECT * FROM elections WHERE id = $1', [election_id]);

      // Create payload
      const payload = {
        election: election.rows[0],
        results: results.rows,
        uploaded_by: req.user.username,
        upload_timestamp: new Date().toISOString()
      };

      // Generate integrity hash (SHA-512)
      const hash = crypto.createHash('sha512')
        .update(JSON.stringify(payload))
        .digest('hex');

      // ── In production: POST to process.env.CENTRAL_SERVER_URL ──
      // const centralResponse = await fetch(process.env.CENTRAL_SERVER_URL + '/results', {
      //   method: 'POST',
      //   headers: {
      //     'Content-Type': 'application/json',
      //     'X-API-Key': process.env.CENTRAL_SERVER_API_KEY,
      //     'X-Integrity-Hash': hash
      //   },
      //   body: JSON.stringify(payload)
      // });

      // Simulate central server acknowledgement
      const ack_code = `CENTR-${election_id.slice(0, 8).toUpperCase()}-${Date.now()}`;

      // Mark election results as uploaded
      await db.query(
        `UPDATE elections SET
          results_uploaded = TRUE,
          results_upload_timestamp = NOW(),
          results_server_hash = $2,
          updated_at = NOW()
         WHERE id = $1`,
        [election_id, hash]
      );

      // Mark all results as verified
      await db.query(
        `UPDATE election_results SET
          is_verified = TRUE, verified_by = $2,
          verification_timestamp = NOW(),
          server_acknowledgement_code = $3
         WHERE election_id = $1`,
        [election_id, req.user.id, ack_code]
      );

      res.json({
        message: 'Results successfully uploaded to central server',
        acknowledgement_code: ack_code,
        integrity_hash: hash,
        total_records_uploaded: results.rows.length,
        upload_timestamp: new Date().toISOString()
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ─── GET ELECTION RESULTS SUMMARY ─────────────────────────────────────────────
router.get('/:election_id/results', authenticate, async (req, res) => {
  try {
    const { election_id } = req.params;

    const summary = await db.query(
      `SELECT
         c.first_name || ' ' || c.last_name AS contestant_name,
         p.name AS party, p.abbreviation,
         ec.ballot_number,
         COALESCE(SUM(er.votes_received), 0) AS total_votes,
         ROUND(
           COALESCE(SUM(er.votes_received), 0) * 100.0 /
           NULLIF((SELECT SUM(votes_received) FROM election_results WHERE election_id = $1), 0),
           2
         ) AS vote_percentage
       FROM election_contestants ec
       JOIN contestants c ON ec.contestant_id = c.id
       LEFT JOIN parties p ON c.party_id = p.id
       LEFT JOIN election_results er ON ec.id = er.election_contestant_id AND er.election_id = $1
       WHERE ec.election_id = $1
       GROUP BY c.id, p.id, ec.ballot_number
       ORDER BY total_votes DESC`,
      [election_id]
    );

    const election = await db.query('SELECT * FROM elections WHERE id = $1', [election_id]);

    res.json({
      election: election.rows[0],
      results: summary.rows,
      winner: summary.rows[0] || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
