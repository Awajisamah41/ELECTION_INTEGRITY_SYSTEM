# 🗳️ Election Integrity & Monitoring System (IECMS)

A full-stack election integrity management system with PostgreSQL backend,
Node.js/Express REST API, and a standalone HTML/CSS/JS frontend dashboard.

---

## 📁 Project Structure

```
election-system/
├── database/
│   └── schema.sql           # PostgreSQL schema (tables, triggers, indexes, seed data)
│
├── backend/
│   ├── server.js            # Express app entry point
│   ├── package.json         # Node.js dependencies
│   ├── .env.example         # Environment variables template
│   ├── config/
│   │   └── database.js      # PostgreSQL connection pool
│   ├── middleware/
│   │   └── auth.js          # JWT authentication & role-based authorization
│   └── routes/
│       ├── auth.js          # Login, current user, dashboard stats
│       ├── voters.js        # Voter registration, accreditation
│       ├── contestants.js   # Contestant registration, eligibility management
│       ├── elections.js     # Election management, results, central upload
│       └── parties.js       # Party registration
│
└── frontend/
    └── index.html           # Full frontend dashboard (single file)
```

---

## ⚙️ Setup Instructions

### 1. PostgreSQL Database

```bash
# Create the database
createdb election_db

# Apply schema (creates all tables, triggers, seed data)
psql -d election_db -f database/schema.sql
```

### 2. Backend (Node.js/Express)

```bash
cd backend

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your PostgreSQL credentials and JWT secret

# Start server
npm run dev       # Development (with nodemon)
npm start         # Production
```

Server runs at: `http://localhost:5000`

### 3. Frontend

Open `frontend/index.html` directly in a browser — no build step needed.
It connects to the backend at `http://localhost:5000`.

---

## 🔐 System Rules Enforced

| Rule | Where Enforced |
|------|---------------|
| Voter must be 18+ | Backend validation + DB CHECK constraint + DB trigger |
| Voter must be accredited to vote | `is_eligible` computed from `age >= 18 AND is_accredited` |
| Contestant must pass party primary | DB trigger on contestants table |
| No criminal convictions | DB trigger — sets `is_eligible = FALSE` automatically |
| Assets must be publicly declared | DB trigger — required for eligibility |
| Results uploaded to central server | `/api/elections/:id/upload-to-central` with SHA-512 hash |

---

## 🔑 User Roles & Permissions

| Role | Permissions |
|------|------------|
| SuperAdmin | Full access |
| Commissioner | Create elections, manage parties, upload results, manage eligibility |
| ReturningOfficer | Register voters/contestants, submit results |
| PollingOfficer | Accredit voters, submit polling unit results |
| Observer | Read-only |
| Auditor | View audit logs |

---

## 📡 Key API Endpoints

```
POST   /api/auth/login                          Authenticate
GET    /api/auth/stats                          Dashboard stats

GET    /api/voters                              List voters (paginated)
POST   /api/voters                              Register voter (age ≥18 enforced)
PATCH  /api/voters/:id/accredit                Accredit voter

GET    /api/parties                             List parties
POST   /api/parties                             Register party

GET    /api/contestants                         List contestants
POST   /api/contestants                         Register contestant
PATCH  /api/contestants/:id/eligibility        Update eligibility flags

GET    /api/elections                           List elections
POST   /api/elections                           Create election
POST   /api/elections/:id/contestants           Add to ballot (eligibility checked)
POST   /api/elections/:id/results               Submit polling unit results
POST   /api/elections/:id/upload-to-central     Upload to central server (SHA-512)
GET    /api/elections/:id/results               Get results summary
```

---

## 🛡️ Security Features

- JWT authentication with role-based access control
- Rate limiting (100 req/15min per IP)
- Helmet.js security headers
- All changes tracked in `audit_logs` table
- SHA-512 integrity hash on all uploaded results
- Central server acknowledgement codes
- PostgreSQL database triggers prevent invalid data

---

## 🗄️ Database Highlights

- **Voters**: Age constraint at DB level, `is_eligible` auto-computed
- **Contestants**: Trigger auto-updates eligibility on every INSERT/UPDATE
- **Elections**: Results tied to polling units for granular tracking
- **Audit Logs**: Every INSERT/UPDATE/DELETE is logged with actor + IP
- **Accreditation Logs**: Full trail of who accredited whom, when, and with what device
