# GRUS – Private Messaging Platform

<p align="center">
  <strong>Private by Design. Connected in Real Time.</strong>
</p>

<p align="center">
  Your Conversations. Your Privacy. Your Control.
</p>

<p align="center">
  <a href="https://grus-429e.onrender.com/">Live Application</a> •
  <a href="https://grus-messenger.onrender.com/api/health">Backend Health</a> •
  <a href="https://github.com/Aluval/grus-messenger">GitHub Repository</a>
</p>

---

## About GRUS

**GRUS** is a real-time private messaging application designed to provide users with a secure and convenient communication experience.

The platform brings together user authentication, personal connections, real-time messaging, message history, and conversation management in one application.

GRUS is built using React, Flask, Python, MongoDB, and Socket.IO.

## Features

### Authentication and Account Management
- User registration and login.
- Password recovery.
- Account and user management.
- Authentication using access tokens.

### Messaging
- Private one-to-one conversations.
- Real-time message delivery.
- Message history with timestamps.
- Conversation management.
- Individual and bulk message deletion.
- Delete for Me and Delete for Everyone functionality.

### User Connections
- Discover other users.
- Send and manage connection requests.
- Manage connected users.
- Block and unblock users.

### Security and Privacy
- Authentication and access controls.
- Web Crypto API integration.
- Encryption architecture using modern cryptographic techniques.
- ECDH P-256 key agreement and HKDF-SHA-256 key derivation in the planned security design.
- AES-256-GCM message encryption in the planned security design.

> Note: Cryptographic features should be considered production-ready only after their implementation, key lifecycle, and security properties have been independently verified.

## Technology Stack

| Component | Technology |
|---|---|
| Frontend | React.js |
| Build Tool | Vite |
| Backend | Python, Flask |
| Database | MongoDB |
| Real-time Communication | Socket.IO |
| Authentication | JWT |
| Encryption APIs | Web Crypto API |
| Backend Deployment | Render Web Service |
| Frontend Deployment | Render Static Site |
| Version Control | Git and GitHub |

## System Architecture

```text
              GRUS CLIENT
          React + Vite Frontend
                  |
          HTTPS / REST API
                  |
          Flask Backend
                  |
        +---------+---------+
        |                   |
     MongoDB            Socket.IO
        |                   |
   Message Storage    Real-time Events
```

## Live Deployment

| Service | URL |
|---|---|
| GRUS Frontend | https://grus-429e.onrender.com/ |
| GRUS Backend | https://grus-messenger.onrender.com/ |
| Backend Health | https://grus-messenger.onrender.com/api/health |

## Project Structure

```text
grus-messenger/
│
├── backend/
│   ├── app.py
│   ├── requirements.txt
│   ├── routes/
│   ├── services/
│   └── ...
│
├── frontend/
│   ├── public/
│   ├── src/
│   │   ├── components/
│   │   ├── services/
│   │   └── ...
│   ├── package.json
│   └── vite.config.js
│
├── .gitignore
└── README.md
```

*The directory structure above is illustrative; actual module names may differ.*

## Local Installation

### Prerequisites

- Python 3.10+
- Node.js and npm
- MongoDB database
- Git

### 1. Clone the Repository

```bash
git clone https://github.com/Aluval/grus-messenger.git
cd grus-messenger
```

### 2. Configure the Backend

```bash
cd backend
python -m venv venv
```

Activate the environment.

**Windows:**

```powershell
venv\Scripts\activate
```

**Linux/macOS:**

```bash
source venv/bin/activate
```

Install dependencies:

```bash
pip install -r requirements.txt
```

Configure your backend environment variables using a `.env` file:

```env
SECRET_KEY=your_secret_key
MONGODB_URI=your_mongodb_connection_string

FRONTEND_URL=http://localhost:5173

RESEND_API_KEY=your_resend_api_key
RESEND_FROM_EMAIL=your_verified_sender_email

RESET_EXPIRY_MINUTES=15
GRUS_ALLOW_DEV_PLAINTEXT=false
```

Start the backend:

```bash
python app.py
```

### 3. Configure the Frontend

Open another terminal:

```bash
cd frontend
npm install
```

Create a frontend `.env` file:

```env
VITE_API_URL=http://127.0.0.1:5000
VITE_OPEN_E2EE_RELAY_URL=your_relay_url
```

Start the frontend:

```bash
npm run dev
```

Open:

```text
http://localhost:5173
```

## Render Deployment

GRUS uses two separate Render services.

### Backend – Web Service

| Setting | Value |
|---|---|
| Root Directory | `backend` |
| Build Command | `pip install -r requirements.txt` |
| Start Command | `gunicorn --worker-class gthread --threads 100 --bind 0.0.0.0:$PORT app:app` |

Configure the backend environment variables in Render.

Set:

```env
FRONTEND_URL=https://grus-429e.onrender.com
```

### Frontend – Static Site

| Setting | Value |
|---|---|
| Root Directory | `frontend` |
| Build Command | `npm install && npm run build` |
| Publish Directory | `dist` |

Frontend environment variable:

```env
VITE_API_URL=https://grus-messenger.onrender.com
```

Add your configured relay URL as `VITE_OPEN_E2EE_RELAY_URL`.

**Important:** Frontend `VITE_` variables are embedded in the browser build. Never store passwords, API secrets, or database credentials in them.

## Uptime Monitoring

GRUS backend and frontend availability can be monitored independently using UptimeRobot.

| Monitor | URL |
|---|---|
| GRUS Backend | `https://grus-messenger.onrender.com/api/health` |
| GRUS Frontend | `https://grus-429e.onrender.com/` |

Recommended monitoring interval: 5 minutes.

## Security Notes

- Keep `.env` files out of version control.
- Never commit database credentials or API keys.
- Use HTTPS for production communication.
- Configure CORS to allow only trusted frontend origins.
- Use production-grade secret keys.
- Review cryptographic implementation before making security guarantees.

## Development Status

GRUS is under active development. Features and modules are being developed, integrated, and tested progressively.

## Author

**Harsha Vardhan Goud**

- GitHub: https://github.com/Aluval
- Project: https://github.com/Aluval/grus-messenger
- Website: https://harsha24.online

---
## License and Copyright

**Copyright © 2026 Harsha Vardhan Goud. All Rights Reserved.**

GRUS is proprietary software. The source code, application design, architecture, and original project materials are protected by applicable copyright laws.

No permission is granted to any individual or organization to:

- Copy or reproduce this project or its source code.
- Reuse, modify, or create derivative works.
- Redistribute, publish, or sublicense the source code.
- Sell, resell, commercially exploit, or use this project as their own.
- Remove or alter copyright and ownership notices.

Any use, reproduction, modification, distribution, or commercial exploitation requires prior written permission from the copyright owner.

Viewing this repository does not grant permission to reuse, redistribute, modify, or commercially exploit the project.

**All rights reserved.**
---

<p align="center">
  <strong>GRUS</strong><br>
  Private by Design. Connected in Real Time.
</p>
