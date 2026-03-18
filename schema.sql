-- ============================================================
-- ELECTION INTEGRITY MANAGEMENT SYSTEM - DATABASE SCHEMA
-- PostgreSQL Schema
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- PARTIES TABLE
-- ============================================================
CREATE TABLE parties (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(150) NOT NULL UNIQUE,
    abbreviation VARCHAR(20) NOT NULL UNIQUE,
    logo_url TEXT,
    registration_number VARCHAR(50) UNIQUE NOT NULL,
    registration_date DATE NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    headquarters_address TEXT,
    contact_email VARCHAR(100),
    contact_phone VARCHAR(20),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- VOTERS TABLE
-- ============================================================
CREATE TABLE voters (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    voter_id VARCHAR(20) UNIQUE NOT NULL,          -- National Voter ID
    national_id VARCHAR(30) UNIQUE NOT NULL,        -- National Identification Number
    first_name VARCHAR(80) NOT NULL,
    last_name VARCHAR(80) NOT NULL,
    date_of_birth DATE NOT NULL,
    age INTEGER GENERATED ALWAYS AS (
        EXTRACT(YEAR FROM AGE(date_of_birth))::INTEGER
    ) STORED,
    gender VARCHAR(10) CHECK (gender IN ('Male', 'Female', 'Other')),
    phone VARCHAR(20),
    email VARCHAR(100),
    address TEXT NOT NULL,
    state VARCHAR(60) NOT NULL,
    lga VARCHAR(60) NOT NULL,                       -- Local Government Area
    ward VARCHAR(60) NOT NULL,
    polling_unit VARCHAR(80),
    is_accredited BOOLEAN DEFAULT FALSE,
    accreditation_date TIMESTAMP,
    accreditation_officer_id UUID,
    is_eligible BOOLEAN GENERATED ALWAYS AS (
        age >= 18 AND is_accredited = TRUE
    ) STORED,
    registration_date TIMESTAMP DEFAULT NOW(),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    CONSTRAINT voter_min_age CHECK (
        EXTRACT(YEAR FROM AGE(date_of_birth)) >= 18
    )
);

-- ============================================================
-- CONTESTANTS TABLE
-- ============================================================
CREATE TABLE contestants (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    national_id VARCHAR(30) UNIQUE NOT NULL,
    first_name VARCHAR(80) NOT NULL,
    last_name VARCHAR(80) NOT NULL,
    date_of_birth DATE NOT NULL,
    age INTEGER GENERATED ALWAYS AS (
        EXTRACT(YEAR FROM AGE(date_of_birth))::INTEGER
    ) STORED,
    gender VARCHAR(10) CHECK (gender IN ('Male', 'Female', 'Other')),
    phone VARCHAR(20),
    email VARCHAR(100),
    address TEXT NOT NULL,
    state VARCHAR(60) NOT NULL,
    party_id UUID REFERENCES parties(id),
    position_sought VARCHAR(100) NOT NULL,          -- President, Governor, Senator, etc.
    constituency VARCHAR(100),
    -- Eligibility Flags
    has_criminal_record BOOLEAN DEFAULT FALSE,
    criminal_record_details TEXT,
    assets_declared BOOLEAN DEFAULT FALSE,
    asset_declaration_date TIMESTAMP,
    asset_declaration_url TEXT,                     -- Public URL to declaration doc
    passed_primary BOOLEAN DEFAULT FALSE,
    primary_election_date DATE,
    primary_votes INTEGER,
    -- Computed eligibility: must pass primary, no criminal record, assets declared
    is_eligible BOOLEAN DEFAULT FALSE,
    ineligibility_reason TEXT,
    registration_date TIMESTAMP DEFAULT NOW(),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- ELECTIONS TABLE
-- ============================================================
CREATE TABLE elections (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title VARCHAR(200) NOT NULL,
    election_type VARCHAR(50) CHECK (election_type IN (
        'Presidential', 'Gubernatorial', 'Senatorial',
        'House of Representatives', 'State Assembly', 'Local Government', 'Primary'
    )),
    election_date DATE NOT NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    state VARCHAR(60),                              -- NULL = national
    constituency VARCHAR(100),
    status VARCHAR(20) DEFAULT 'Scheduled' CHECK (status IN (
        'Scheduled', 'Ongoing', 'Completed', 'Cancelled', 'Disputed'
    )),
    total_registered_voters INTEGER DEFAULT 0,
    total_accredited_voters INTEGER DEFAULT 0,
    total_votes_cast INTEGER DEFAULT 0,
    results_uploaded BOOLEAN DEFAULT FALSE,
    results_upload_timestamp TIMESTAMP,
    results_server_hash VARCHAR(128),               -- SHA-512 hash for integrity
    created_by UUID,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- ELECTION CONTESTANTS (Ballot) TABLE
-- ============================================================
CREATE TABLE election_contestants (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    election_id UUID REFERENCES elections(id) ON DELETE CASCADE,
    contestant_id UUID REFERENCES contestants(id),
    ballot_number INTEGER,
    is_approved BOOLEAN DEFAULT FALSE,
    approved_by UUID,
    approval_date TIMESTAMP,
    disqualification_reason TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(election_id, contestant_id)
);

-- ============================================================
-- POLLING UNITS TABLE
-- ============================================================
CREATE TABLE polling_units (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    pu_code VARCHAR(30) UNIQUE NOT NULL,
    name VARCHAR(150) NOT NULL,
    address TEXT NOT NULL,
    state VARCHAR(60) NOT NULL,
    lga VARCHAR(60) NOT NULL,
    ward VARCHAR(60) NOT NULL,
    registered_voters_count INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- ELECTION RESULTS TABLE
-- ============================================================
CREATE TABLE election_results (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    election_id UUID REFERENCES elections(id),
    election_contestant_id UUID REFERENCES election_contestants(id),
    polling_unit_id UUID REFERENCES polling_units(id),
    votes_received INTEGER NOT NULL DEFAULT 0,
    is_verified BOOLEAN DEFAULT FALSE,
    verified_by UUID,
    verification_timestamp TIMESTAMP,
    upload_timestamp TIMESTAMP DEFAULT NOW(),
    upload_officer_id UUID,
    server_acknowledgement_code VARCHAR(100),       -- From central server
    result_document_url TEXT,                       -- Uploaded result sheet scan
    is_disputed BOOLEAN DEFAULT FALSE,
    dispute_reason TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(election_id, election_contestant_id, polling_unit_id)
);

-- ============================================================
-- ACCREDITATION LOG TABLE
-- ============================================================
CREATE TABLE accreditation_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    voter_id UUID REFERENCES voters(id),
    election_id UUID REFERENCES elections(id),
    polling_unit_id UUID REFERENCES polling_units(id),
    accredited_at TIMESTAMP DEFAULT NOW(),
    officer_id UUID,
    accreditation_method VARCHAR(30) CHECK (accreditation_method IN (
        'Biometric', 'Card Reader', 'Manual', 'Online'
    )),
    device_id VARCHAR(80),
    is_successful BOOLEAN DEFAULT TRUE,
    failure_reason TEXT
);

-- ============================================================
-- AUDIT LOG TABLE
-- ============================================================
CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    table_name VARCHAR(80),
    record_id UUID,
    action VARCHAR(20) CHECK (action IN ('INSERT', 'UPDATE', 'DELETE', 'VIEW')),
    old_data JSONB,
    new_data JSONB,
    performed_by UUID,
    performed_at TIMESTAMP DEFAULT NOW(),
    ip_address INET,
    notes TEXT
);

-- ============================================================
-- USERS / OFFICIALS TABLE
-- ============================================================
CREATE TABLE officials (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username VARCHAR(60) UNIQUE NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    first_name VARCHAR(80),
    last_name VARCHAR(80),
    role VARCHAR(40) CHECK (role IN (
        'SuperAdmin', 'Commissioner', 'ReturningOfficer',
        'PollingOfficer', 'Observer', 'Auditor'
    )),
    state VARCHAR(60),
    lga VARCHAR(60),
    is_active BOOLEAN DEFAULT TRUE,
    last_login TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX idx_voters_voter_id ON voters(voter_id);
CREATE INDEX idx_voters_national_id ON voters(national_id);
CREATE INDEX idx_voters_state_lga ON voters(state, lga);
CREATE INDEX idx_voters_accredited ON voters(is_accredited);
CREATE INDEX idx_contestants_party ON contestants(party_id);
CREATE INDEX idx_contestants_eligible ON contestants(is_eligible);
CREATE INDEX idx_election_results_election ON election_results(election_id);
CREATE INDEX idx_accreditation_logs_voter ON accreditation_logs(voter_id);
CREATE INDEX idx_audit_logs_table_record ON audit_logs(table_name, record_id);

-- ============================================================
-- TRIGGER: Auto-update contestant eligibility
-- ============================================================
CREATE OR REPLACE FUNCTION update_contestant_eligibility()
RETURNS TRIGGER AS $$
BEGIN
    -- Contestant is eligible if:
    -- 1. No criminal record
    -- 2. Assets publicly declared
    -- 3. Passed party primary
    IF NEW.has_criminal_record = TRUE THEN
        NEW.is_eligible := FALSE;
        NEW.ineligibility_reason := 'Criminal conviction record found';
    ELSIF NEW.assets_declared = FALSE THEN
        NEW.is_eligible := FALSE;
        NEW.ineligibility_reason := 'Assets not publicly declared';
    ELSIF NEW.passed_primary = FALSE THEN
        NEW.is_eligible := FALSE;
        NEW.ineligibility_reason := 'Did not pass party primary election';
    ELSE
        NEW.is_eligible := TRUE;
        NEW.ineligibility_reason := NULL;
    END IF;
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_contestant_eligibility
BEFORE INSERT OR UPDATE ON contestants
FOR EACH ROW EXECUTE FUNCTION update_contestant_eligibility();

-- ============================================================
-- TRIGGER: Auto-update timestamps
-- ============================================================
CREATE OR REPLACE FUNCTION update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_voters_updated BEFORE UPDATE ON voters
FOR EACH ROW EXECUTE FUNCTION update_timestamp();

CREATE TRIGGER trigger_elections_updated BEFORE UPDATE ON elections
FOR EACH ROW EXECUTE FUNCTION update_timestamp();

-- ============================================================
-- SAMPLE SEED DATA
-- ============================================================
INSERT INTO parties (name, abbreviation, registration_number, registration_date, headquarters_address, contact_email) VALUES
('All Progressives Congress', 'APC', 'INEC/PARTY/001', '2013-07-31', 'Abuja, FCT', 'info@apc.com'),
('Peoples Democratic Party', 'PDP', 'INEC/PARTY/002', '1998-08-19', 'Wadata Plaza, Abuja', 'info@pdp.org'),
('Labour Party', 'LP', 'INEC/PARTY/003', '2002-08-01', 'Abuja, FCT', 'info@labourparty.ng'),
('New Nigeria Peoples Party', 'NNPP', 'INEC/PARTY/004', '2001-01-15', 'Kano, Kano State', 'info@nnpp.ng');

INSERT INTO officials (username, email, password_hash, first_name, last_name, role) VALUES
('superadmin', 'admin@iecms.gov.ng', '$2b$12$placeholder_hash', 'System', 'Administrator', 'SuperAdmin'),
('commissioner1', 'commissioner@iecms.gov.ng', '$2b$12$placeholder_hash', 'Mahmood', 'Yakubu', 'Commissioner');
