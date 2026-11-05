from datetime import datetime, timedelta, timezone
from functools import wraps
import re
import hashlib
import json
import os
import smtplib
import ssl
from email.message import EmailMessage
import secrets
import urllib.error
import urllib.request
import jwt
from bson import ObjectId
from flask import Blueprint, current_app, jsonify, request
from pymongo.errors import DuplicateKeyError

from extensions import bcrypt

auth_bp = Blueprint("auth", __name__, url_prefix="/api/auth")

def validate_password(password):
    """
    GRUS password policy:
    - 8 to 72 characters
    - At least one uppercase letter
    - At least one lowercase letter
    - At least one number
    - At least one special character
    """

    if not isinstance(password, str):
        return False, "Password is required."

    if len(password) < 8 or len(password) > 72:
        return False, "Password must be between 8 and 72 characters."

    # bcrypt has a 72-byte password limit.
    if len(password.encode("utf-8")) > 72:
        return False, "Password must not exceed 72 UTF-8 bytes."

    if not re.search(r"[A-Z]", password):
        return False, "Password must contain at least one uppercase letter."

    if not re.search(r"[a-z]", password):
        return False, "Password must contain at least one lowercase letter."

    if not re.search(r"[0-9]", password):
        return False, "Password must contain at least one number."

    if not re.search(r"[^A-Za-z0-9]", password):
        return False, "Password must contain at least one special character."

    return True, None

def get_users():
    return current_app.extensions["mongo_db"]["users"]

def get_recovery_keys():
    return current_app.extensions["mongo_db"]["identity_recovery"]


def get_password_reset_tokens():
    return current_app.extensions["mongo_db"]["password_reset_tokens"]


def get_password_reset_requests():
    return current_app.extensions["mongo_db"]["password_reset_requests"]

def create_token(user_id):
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user_id),
        "iat": now,
        "exp": now + timedelta(hours=24),
    }
    return jwt.encode(
        payload,
        current_app.config["SECRET_KEY"],
        algorithm="HS256",
    )


def token_required(function):
    @wraps(function)
    def wrapper(*args, **kwargs):
        authorization = request.headers.get("Authorization", "")
        parts = authorization.split()

        if len(parts) != 2 or parts[0].lower() != "bearer":
            return jsonify({"error": "Authentication token required"}), 401

        try:
            payload = jwt.decode(
                parts[1],
                current_app.config["SECRET_KEY"],
                algorithms=["HS256"],
            )
            user_id = ObjectId(payload["sub"])
        except (jwt.InvalidTokenError, KeyError, TypeError, ValueError):
            return jsonify({"error": "Invalid or expired token"}), 401

        user = get_users().find_one({"_id": user_id})

        if not user:
            return jsonify({"error": "User account not found"}), 401

        return function(user, *args, **kwargs)

    return wrapper


@auth_bp.post("/register")
def register():
    data = request.get_json(silent=True) or {}
    username = data.get("username")
    email = data.get("email")
    password = data.get("password")

    if not all(isinstance(v, str) for v in (username, email, password)):
        return jsonify({"error": "Username, email and password are required"}), 400

    username = username.strip().lower()
    email = email.strip().lower()

    if not re.fullmatch(r"[a-z0-9_]{3,20}", username):
        return jsonify({"error": "Invalid username"}), 400

    if len(email) > 254 or not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        return jsonify({"error": "Enter a valid email address"}), 400

    valid, error = validate_password(password)

    if not valid:
        return jsonify({"error": error}), 400

    password_hash = bcrypt.generate_password_hash(password).decode("utf-8")

    user = {
        "username": username,
        "email": email,
        "password_hash": password_hash,
        "created_at": datetime.now(timezone.utc),
    }

    try:
        result = get_users().insert_one(user)
    except DuplicateKeyError:
        return jsonify({"error": "Username or email is already registered"}), 409

    return jsonify({
        "message": "GRUS account created successfully",
        "user": {
            "id": str(result.inserted_id),
            "username": username,
            "email": email,
        },
    }), 201


@auth_bp.post("/login")
def login():
    data = request.get_json(silent=True) or {}
    email = data.get("email")
    password = data.get("password")

    if not isinstance(email, str) or not isinstance(password, str):
        return jsonify({"error": "Email and password are required"}), 400

    user = get_users().find_one({"email": email.strip().lower()})

    if not user or not bcrypt.check_password_hash(user["password_hash"], password):
        return jsonify({"error": "Invalid email or password"}), 401

    return jsonify({
        "message": "Login successful",
        "token": create_token(user["_id"]),
        "user": {
            "id": str(user["_id"]),
            "username": user["username"],
            "email": user["email"],
        },
    }), 200


@auth_bp.get("/me")
@token_required
def me(user):
    return jsonify({
        "user": {
            "id": str(user["_id"]),
            "username": user["username"],
            "email": user["email"],
        }
    }), 200

@auth_bp.post("/recovery")
@token_required
def save_recovery_backup(user):
    data = request.get_json(silent=True) or {}
    backup = data.get("recovery_backup")
    public_key = data.get("public_key")

    if not isinstance(backup, dict) or not isinstance(public_key, str):
        return jsonify({"error": "Recovery backup and public key are required"}), 400

    if (
        backup.get("version") != 2
        or backup.get("kdf") != "PBKDF2-SHA-256"
        or backup.get("cipher") != "AES-256-GCM"
        or backup.get("iterations") != 600000
    ):
        return jsonify({"error": "Unsupported recovery backup format"}), 400

    if len(public_key) > 5000 or len(json.dumps(backup)) > 30000:
        return jsonify({"error": "Recovery backup is too large"}), 400

    record = {
        "user_id": user["_id"],
        "public_key": public_key,
        "recovery_backup": backup,
        "version": 2,
        "created_at": datetime.now(timezone.utc),
    }

    try:
        get_recovery_keys().insert_one(record)
    except DuplicateKeyError:
        return jsonify({
            "error": "A recovery backup already exists for this account"
        }), 409

    return jsonify({
        "message": "Encrypted recovery backup saved successfully"
    }), 201


@auth_bp.get("/recovery")
@token_required
def get_recovery_backup(user):
    record = get_recovery_keys().find_one({"user_id": user["_id"]})

    if not record:
        return jsonify({"error": "No recovery backup found"}), 404

    return jsonify({
        "version": record["version"],
        "public_key": record["public_key"],
        "recovery_backup": record["recovery_backup"],
    }), 200



@auth_bp.put("/recovery")
@token_required
def update_recovery_backup(user):
    data = request.get_json(silent=True) or {}

    backup = data.get("recovery_backup")
    public_key = data.get("public_key")
    expected_backup = data.get("expected_backup")

    if (
        not isinstance(backup, dict)
        or not isinstance(public_key, str)
        or not isinstance(expected_backup, dict)
    ):
        return jsonify({
            "error": "New backup, public key and expected backup are required"
        }), 400

    if (
        backup.get("version") != 2
        or backup.get("kdf") != "PBKDF2-SHA-256"
        or backup.get("cipher") != "AES-256-GCM"
        or backup.get("iterations") != 600000
    ):
        return jsonify({
            "error": "Unsupported recovery backup format"
        }), 400

    if (
        len(public_key) > 5000
        or len(json.dumps(backup)) > 30000
        or len(json.dumps(expected_backup)) > 30000
    ):
        return jsonify({
            "error": "Recovery backup is too large"
        }), 400

    if backup.get("publicKey") != public_key:
        return jsonify({
            "error": "Backup public key does not match"
        }), 400

    collection = get_recovery_keys()

    # Retrieve the current record without modifying it.
    current = collection.find_one({
        "user_id": user["_id"],
        "public_key": public_key,
    })

    if not current:
        return jsonify({
            "error": "Existing recovery identity was not found."
        }), 404

    # Compare JSON representations with sorted keys.
    current_json = json.dumps(
        current.get("recovery_backup"),
        sort_keys=True,
        separators=(",", ":"),
    )

    expected_json = json.dumps(
        expected_backup,
        sort_keys=True,
        separators=(",", ":"),
    )

    if current_json != expected_json:
        return jsonify({
            "error": "Existing recovery backup does not match. Nothing was updated."
        }), 409

    # Protect against another update occurring after our read.
    update_filter = {
        "_id": current["_id"],
        "user_id": user["_id"],
        "public_key": public_key,
    }

    if "updated_at" in current:
        update_filter["updated_at"] = current["updated_at"]
    else:
        update_filter["updated_at"] = {"$exists": False}

    result = collection.update_one(
        update_filter,
        {
            "$set": {
                "recovery_backup": backup,
                "version": 2,
                "updated_at": datetime.now(timezone.utc),
            }
        }
    )

    if result.matched_count != 1:
        return jsonify({
            "error": "Recovery backup changed during the update. Nothing was updated."
        }), 409

    return jsonify({
        "message": "Recovery backup updated successfully."
    }), 200



@auth_bp.get("/recovery/public-key/<user_id>")
@token_required
def get_user_public_key(user, user_id):
    if not ObjectId.is_valid(user_id):
        return jsonify({"error": "Invalid user ID"}), 400

    record = get_recovery_keys().find_one({
        "user_id": ObjectId(user_id)
    })

    if not record:
        return jsonify({"error": "User encryption identity not found"}), 404

    return jsonify({
        "user_id": user_id,
        "public_key": record["public_key"],
    }), 200

def send_password_reset_email(email, reset_url):
    try:
        mail_host = os.getenv("MAIL_HOST", "smtp.gmail.com")
        mail_port = int(os.getenv("MAIL_PORT", "587"))
        mail_username = os.getenv("MAIL_USERNAME")
        mail_password = os.getenv("MAIL_PASSWORD")
        mail_from_name = os.getenv("MAIL_FROM_NAME", "GRUS")

        if not mail_username or not mail_password:
            current_app.logger.error(
                "Gmail SMTP configuration is missing."
            )
            return False

        message = EmailMessage()
        message["Subject"] = "Reset your GRUS password"
        message["From"] = f"{mail_from_name} <{mail_username}>"
        message["To"] = email

        message.set_content(
            f"""Hello,

We received a request to reset your GRUS account password.

Use the link below to reset your password:

{reset_url}

This link expires in 15 minutes and can only be used once.

If you did not request this, please ignore this email.

Regards,
GRUS Team
"""
        )

        context = ssl.create_default_context()

        with smtplib.SMTP(mail_host, mail_port, timeout=20) as server:
            server.ehlo()
            server.starttls(context=context)
            server.ehlo()
            server.login(mail_username, mail_password)
            server.send_message(message)

        current_app.logger.info(
            "Password reset email sent successfully."
        )
        return True

    except Exception:
        current_app.logger.exception(
            "Password reset email delivery failed."
        )
        return False

@auth_bp.post("/forgot-password")
def forgot_password():
    data = request.get_json(silent=True) or {}
    email = data.get("email")

    if not isinstance(email, str):
        return jsonify({"error": "Enter your registered email address"}), 400

    email = email.strip().lower()

    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        return jsonify({"error": "Enter a valid email address"}), 400

    # Use a generic response to prevent account enumeration.
    generic_response = {
        "message": (
            "If an account exists for this email, "
            "password reset instructions will be sent."
        )
    }

    email_hash = hashlib.sha256(email.encode("utf-8")).hexdigest()
    now = datetime.now(timezone.utc)

    requests_collection = get_password_reset_requests()

    recent_request = requests_collection.find_one({
        "email_hash": email_hash,
        "created_at": {"$gte": now - timedelta(minutes=1)}
    })

    if recent_request:
        return jsonify(generic_response), 200

    requests_collection.insert_one({
        "email_hash": email_hash,
        "created_at": now,
    })

    user = get_users().find_one({"email": email})

    if not user:
        return jsonify(generic_response), 200

    raw_token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()

    get_password_reset_tokens().delete_many({
        "user_id": user["_id"]
    })

    get_password_reset_tokens().insert_one({
        "user_id": user["_id"],
        "token_hash": token_hash,
        "created_at": now,
        "expires_at": now + timedelta(minutes=15),
    })

    frontend_url = os.getenv("FRONTEND_URL", "http://localhost:5173")
    reset_url = (
        f"{frontend_url.rstrip('/')}/reset-password"
        f"?token={raw_token}"
    )

    if not send_password_reset_email(email, reset_url):
        current_app.logger.error(
            "Could not deliver password reset email for user %s",
            user["_id"],
        )

    return jsonify(generic_response), 200

@auth_bp.post("/reset-password")
def reset_password():
    data = request.get_json(silent=True) or {}
    token = data.get("token")
    new_password = data.get("password")

    if not isinstance(token, str) or not isinstance(new_password, str):
        return jsonify({"error": "Reset token and new password are required"}), 400

    valid, error = validate_password(new_password)

    if not valid:
        return jsonify({"error": error}), 400

    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    now = datetime.now(timezone.utc)

    tokens = get_password_reset_tokens()

    reset_record = tokens.find_one({
        "token_hash": token_hash,
        "expires_at": {"$gt": now},
    })

    if not reset_record:
        return jsonify({
            "error": "Invalid or expired password reset link"
        }), 400

    password_hash = bcrypt.generate_password_hash(
        new_password
    ).decode("utf-8")

    result = get_users().update_one(
        {"_id": reset_record["user_id"]},
        {"$set": {"password_hash": password_hash}}
    )

    if result.matched_count != 1:
        return jsonify({"error": "Account not found"}), 404

    # Make the reset link single-use.
    tokens.delete_many({"user_id": reset_record["user_id"]})

    return jsonify({
        "message": "GRUS password reset successfully. Please log in again."
    }), 200