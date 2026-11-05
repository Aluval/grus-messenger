import hashlib
import hmac
import secrets
from datetime import datetime, timezone

from flask import Blueprint, current_app, jsonify, request
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from routes.auth import token_required
import base64
from bson import ObjectId

import math
from datetime import timedelta
from routes.connections import are_connected, is_blocked
import base64
from datetime import datetime, timezone
VALID_PREKEY_TYPES = {
    "ecPreKey",
    "ecSignedPreKey",
    "kemOneTimePreKey",
    "kemLastResortPreKey",
}


signal_bp = Blueprint(
    "signal",
    __name__,
    url_prefix="/api/signal"
)


MAX_DEVICES_PER_USER = 5

VALID_DEVICE_TYPES = {
    "mobile",
    "desktop",
    "tablet",
    "web"
}


def get_db():
    return current_app.extensions["mongo_db"]


def get_devices():
    return get_db()["signal_devices"]

@signal_bp.get("/devices/<user_id>")
@token_required
def list_signal_devices(current_user, user_id):
    if not ObjectId.is_valid(user_id):
        return jsonify({"error": "Invalid user ID"}), 400

    target_user_id = ObjectId(user_id)
    requester_id = current_user["_id"]

    # Users can discover their own devices.
    # Other users must be connected and not blocked.
    if target_user_id != requester_id:
        if (
            not are_connected(requester_id, target_user_id)
            or is_blocked(requester_id, target_user_id)
        ):
            return jsonify({"error": "Recipient is unavailable"}), 403

    records = list(
        get_devices().find(
            {
                "user_id": target_user_id,
                "enabled": True,
                "registered": True,
            },
            {
                "_id": 0,
                "device_id": 1,
                "device_type": 1,
                "registered": 1,
                "linked": 1,
                "enabled": 1,
                "created_at": 1,
                "last_seen_at": 1,
                "linked_at": 1,
            },
        ).sort("device_id", 1)
    )

    def timestamp_ms(value):
        if value is None:
            return None
        return int(value.timestamp() * 1000)

    devices = [
        {
            "deviceId": item["device_id"],
            "deviceType": item.get("device_type", "web"),
            "registered": item.get("registered", False),
            "linked": item.get("linked", False),
            "enabled": item.get("enabled", False),
            "createdAt": timestamp_ms(item.get("created_at")),
            "lastSeenAt": timestamp_ms(item.get("last_seen_at")),
            "linkedAt": timestamp_ms(item.get("linked_at")),
        }
        for item in records
    ]

    return jsonify({
        "devices": devices,
        "count": len(devices),
    }), 200

@signal_bp.post("/devices")
@token_required
def register_device(current_user):
    data = request.get_json(silent=True)

    if not isinstance(data, dict):
        return jsonify({"error": "Invalid JSON request"}), 400

    device_type = data.get("device_type", "web")
    if device_type not in VALID_DEVICE_TYPES:
        return jsonify({"error": "Invalid device type"}), 400

    user_id = current_user["_id"]
    devices = get_devices()

    # The per-user counter document is updated atomically by MongoDB.
    # Seed it from existing device IDs so this also works for existing users.
    highest_existing_id = devices.find_one(
        {"user_id": user_id},
        sort=[("device_id", -1)],
        projection={"device_id": 1, "_id": 0},
    )
    highest_existing_id = highest_existing_id["device_id"] if highest_existing_id else 0

    counter = get_db()["signal_device_counters"].find_one_and_update(
        {"_id": user_id},
        [{"$set": {
            "next_device_id": {
                "$add": [
                    {"$max": [
                        {"$ifNull": ["$next_device_id", 0]},
                        highest_existing_id,
                    ]},
                    1,
                ]
            }
        }}],
        upsert=True,
        return_document=ReturnDocument.AFTER,
    )
    device_id = counter["next_device_id"]

    if device_id > MAX_DEVICES_PER_USER:
        return jsonify({"error": "Maximum device limit reached"}), 409

    now = datetime.now(timezone.utc)
    device_document = {
        "user_id": user_id,
        "device_id": device_id,
        "device_type": device_type,
        "registered": False,
        "linked": False,
        "enabled": True,
        "created_at": now,
        "last_seen_at": None,
    }

    try:
        devices.insert_one(device_document)
    except DuplicateKeyError:
        # A duplicate means an inconsistent legacy index/counter state.
        # Do not silently assign a different ID to this registration request.
        current_app.logger.exception("Signal device ID allocation conflict")
        return jsonify({"error": "Device registration conflict. Please retry."}), 409

    return jsonify({
        "message": "Device registration initiated",
        "device": {
            "device_id": device_id,
            "device_type": device_type,
            "registered": False,
            "linked": device_document["linked"],
            "enabled": True,
        },
    }), 201


def decode_public_key(value):
    """Validate a Base64-encoded 32-byte public key."""
    if not isinstance(value, str) or not value:
        return None

    try:
        decoded = base64.b64decode(value, validate=True)

        if len(decoded) != 32:
            return None

        # Require canonical Base64 representation.
        if base64.b64encode(decoded).decode("ascii") != value:
            return None

        return value

    except (ValueError, TypeError):
        return None


IDENTITY_COMMITMENT_DOMAIN = (
    b"signal-protocol-js composite identity v1"
)


def calculate_identity_commitment(identity):
    if not isinstance(identity, dict) or identity.get("version") != 1:
        raise ValueError("Invalid composite identity")

    x25519_encoded = decode_public_key(
        identity.get("x25519PublicKey")
    )
    ed25519_encoded = decode_public_key(
        identity.get("ed25519PublicKey")
    )

    if not x25519_encoded or not ed25519_encoded:
        raise ValueError("Invalid composite public keys")

    x25519 = base64.b64decode(x25519_encoded, validate=True)
    ed25519 = base64.b64decode(ed25519_encoded, validate=True)

    canonical_identity = (
        b"\x01"
        + b"\x01"
        + x25519
        + b"\x02"
        + ed25519
    )

    return hashlib.sha256(
        IDENTITY_COMMITMENT_DOMAIN + canonical_identity
    ).digest()

@signal_bp.post("/identity")
@token_required

def provision_identity(current_user):
    data = request.get_json(silent=True)

    if not isinstance(data, dict):
        return jsonify({"error": "Invalid JSON request"}), 400

    device_id = data.get("device_id")
    identity = data.get("identity")
    registration_id = data.get("registration_id")
    identity_type = data.get("identity_type", "aci")

    if (
        isinstance(device_id, bool)
        or not isinstance(device_id, int)
        or not 1 <= device_id <= MAX_DEVICES_PER_USER
    ):
        return jsonify({"error": "Invalid device ID"}), 400

    if (
        isinstance(registration_id, bool)
        or not isinstance(registration_id, int)
        or not 1 <= registration_id <= 16380
    ):
        return jsonify({"error": "Invalid registration ID"}), 400

    if identity_type not in {"aci", "pni"}:
        return jsonify({"error": "Invalid identity type"}), 400

    if not isinstance(identity, dict) or identity.get("version") != 1:
        return jsonify({"error": "Invalid or unsupported identity"}), 400

    x25519_key = decode_public_key(identity.get("x25519PublicKey"))
    ed25519_key = decode_public_key(identity.get("ed25519PublicKey"))

    if not x25519_key or not ed25519_key:
        return jsonify({"error": "Invalid public key encoding"}), 400

    db = get_db()
    user_id = current_user["_id"]
    devices = get_devices()
    identities = db["signal_identities"]

    canonical_id = f"signal_identity:{user_id}:{identity_type}"

    canonical_identity = {
        "version": 1,
        "x25519PublicKey": x25519_key,
        "ed25519PublicKey": ed25519_key,
    }

    now = datetime.now(timezone.utc)

    def provision(session):
        device = devices.find_one(
            {
                "user_id": user_id,
                "device_id": device_id,
                "enabled": True,
            },
            session=session,
        )

        if not device:
            raise LookupError("Device not found or disabled")

        # Check legacy per-device identities before migration.
        legacy_records = list(
            identities.find(
                {
                    "user_id": user_id,
                    "identity_type": identity_type,
                    "device_id": {"$exists": True},
                },
                session=session,
            )
        )

        for legacy in legacy_records:
            legacy_identity = legacy.get("identity", {})

            if (
                legacy_identity.get("x25519PublicKey") != x25519_key
                or legacy_identity.get("ed25519PublicKey") != ed25519_key
            ):
                raise ValueError(
                    "Account has a different existing identity. "
                    "Identity migration or rotation is required."
                )

        identity_document = {
            "_id": canonical_id,
            "user_id": user_id,
            "identity_type": identity_type,
            "identity": canonical_identity,
            "created_at": now,
            "updated_at": now,
        }

        result = identities.update_one(
            {"_id": canonical_id},
            {"$setOnInsert": identity_document},
            upsert=True,
            session=session,
        )

        existing = identities.find_one(
            {"_id": canonical_id},
            session=session,
        )

        stored = existing.get("identity", {}) if existing else {}

        if (
            not existing
            or existing.get("user_id") != user_id
            or existing.get("identity_type") != identity_type
            or stored.get("x25519PublicKey") != x25519_key
            or stored.get("ed25519PublicKey") != ed25519_key
        ):
            raise ValueError(
                "Account identity already exists with different key material. "
                "Use the identity rotation process."
            )

        device_result = devices.update_one(
            {
                "user_id": user_id,
                "device_id": device_id,
                "enabled": True,
            },
            {
                "$set": {
                    "registration_id": registration_id,
                    "identity_type_provisioned": identity_type,
                    "last_seen_at": now,
                }
            },
            session=session,
        )

        if device_result.matched_count != 1:
            raise LookupError("Device registration update failed")

        return result.upserted_id is not None

    try:
        with db.client.start_session() as session:
            created = session.with_transaction(provision)

    except ValueError as error:
        return jsonify({"error": str(error)}), 409

    except LookupError as error:
        return jsonify({"error": str(error)}), 404

    except Exception:
        current_app.logger.exception(
            "Signal account identity provisioning transaction failed"
        )
        return jsonify({
            "error": "Unable to provision account identity"
        }), 503

    return jsonify({
        "message": (
            "Account identity provisioned"
            if created
            else "Account identity verified"
        ),
        "identity_type": identity_type,
        "device_id": device_id,
        "account_identity_shared": True,
    }), 201 if created else 200

@signal_bp.post("/identity/rotate")
@token_required
def rotate_signal_identity(current_user):
    data = request.get_json(silent=True)

    if not isinstance(data, dict):
        return jsonify({"error": "Invalid JSON request"}), 400

    device_id = data.get("device_id")
    registration_id = data.get("registration_id")
    identity_type = data.get("identity_type", "aci")
    identity = data.get("identity")
    expected_encoded = data.get("expected_current_commitment")

    if (
        isinstance(device_id, bool)
        or not isinstance(device_id, int)
        or not 1 <= device_id <= MAX_DEVICES_PER_USER
    ):
        return jsonify({"error": "Invalid device ID"}), 400

    if (
        isinstance(registration_id, bool)
        or not isinstance(registration_id, int)
        or not 1 <= registration_id <= 16380
    ):
        return jsonify({"error": "Invalid registration ID"}), 400

    if identity_type not in {"aci", "pni"}:
        return jsonify({"error": "Invalid identity type"}), 400

    try:
        replacement_commitment = calculate_identity_commitment(identity)

        if (
            not isinstance(expected_encoded, str)
            or not expected_encoded
        ):
            raise ValueError("Missing expected commitment")

        expected_commitment = base64.b64decode(
            expected_encoded,
            validate=True,
        )

        if (
            len(expected_commitment) != 32
            or base64.b64encode(expected_commitment).decode("ascii")
            != expected_encoded
        ):
            raise ValueError("Invalid expected commitment")

    except (ValueError, TypeError):
        return jsonify({"error": "Invalid identity or commitment"}), 400

    if hmac.compare_digest(
        replacement_commitment,
        expected_commitment,
    ):
        return jsonify({
            "error": "Replacement identity must differ from current identity"
        }), 400

    db = get_db()
    user_id = current_user["_id"]
    devices = get_devices()
    identities = db["signal_identities"]
    prekeys = db["signal_prekeys"]

    canonical_id = f"signal_identity:{user_id}:{identity_type}"
    now = datetime.now(timezone.utc)

    def rotate(session):
        device = devices.find_one(
            {
                "user_id": user_id,
                "device_id": device_id,
                "enabled": True,
                "registered": True,
            },
            session=session,
        )

        if not device:
            raise LookupError("Registered device not found")

        current = identities.find_one(
            {
                "_id": canonical_id,
                "user_id": user_id,
                "identity_type": identity_type,
            },
            session=session,
        )

        if not current:
            raise LookupError("Existing account identity not found")

        current_identity = current.get("identity")

        current_commitment = calculate_identity_commitment(
            current_identity
        )

        if not hmac.compare_digest(
            current_commitment,
            expected_commitment,
        ):
            raise ValueError(
                "Identity changed since the rotation was requested"
            )

        result = identities.update_one(
            {
                "_id": canonical_id,
                "user_id": user_id,
                "identity_type": identity_type,
                "identity.x25519PublicKey":
                    current_identity["x25519PublicKey"],
                "identity.ed25519PublicKey":
                    current_identity["ed25519PublicKey"],
            },
            {
                "$set": {
                    "identity": {
                        "version": 1,
                        "x25519PublicKey":
                            identity["x25519PublicKey"],
                        "ed25519PublicKey":
                            identity["ed25519PublicKey"],
                    },
                    "updated_at": now,
                }
            },
            session=session,
        )

        if result.modified_count != 1:
            raise ValueError("Identity changed during rotation")

        devices.update_many(
            {
                "user_id": user_id,
                "enabled": True,
            },
            {
                "$set": {
                    "registered": False,
                    "identity_type_provisioned": None,
                    "last_seen_at": now,
                }
            },
            session=session,
        )

        deleted = prekeys.delete_many(
            {
                "user_id": user_id,
                "identity_type": identity_type,
            },
            session=session,
        )

        devices.update_one(
            {
                "user_id": user_id,
                "device_id": device_id,
                "enabled": True,
            },
            {
                "$set": {
                    "registration_id": registration_id,
                    "identity_type_provisioned": identity_type,
                }
            },
            session=session,
        )

        return deleted.deleted_count

    try:
        with db.client.start_session() as session:
            deleted_prekeys = session.with_transaction(rotate)

    except ValueError as error:
        return jsonify({"error": str(error)}), 409

    except LookupError as error:
        return jsonify({"error": str(error)}), 404

    except Exception:
        current_app.logger.exception(
            "Signal identity rotation transaction failed"
        )
        return jsonify({
            "error": "Unable to rotate account identity"
        }), 503

    return jsonify({
        "message": "Account identity rotated",
        "identity_type": identity_type,
        "device_id": device_id,
        "invalidated_prekeys": deleted_prekeys,
    }), 200

@signal_bp.delete("/devices/<int:device_id>")
@token_required
def remove_signal_device(current_user, device_id):
    if not 1 <= device_id <= MAX_DEVICES_PER_USER:
        return jsonify({"error": "Invalid device ID"}), 400

    db = get_db()
    user_id = current_user["_id"]
    devices = get_devices()
    prekeys = db["signal_prekeys"]
    envelopes = db["signal_envelopes"]

    now = datetime.now(timezone.utc)

    def remove(session):
        device = devices.find_one(
            {
                "user_id": user_id,
                "device_id": device_id,
                "enabled": True,
            },
            session=session,
        )

        if not device:
            raise LookupError("Device not found or already removed")

        active_count = devices.count_documents(
            {
                "user_id": user_id,
                "enabled": True,
                "registered": True,
            },
            session=session,
        )

        if device.get("registered") and active_count <= 1:
            raise ValueError(
                "Cannot remove the last registered account device"
            )

        result = devices.update_one(
            {
                "user_id": user_id,
                "device_id": device_id,
                "enabled": True,
            },
            {
                "$set": {
                    "enabled": False,
                    "registered": False,
                    "revoked_at": now,
                    "last_seen_at": now,
                }
            },
            session=session,
        )

        if result.modified_count != 1:
            raise ValueError("Device removal could not be completed")

        deleted_prekeys = prekeys.delete_many(
            {
                "user_id": user_id,
                "device_id": device_id,
            },
            session=session,
        )

        deleted_envelopes = envelopes.delete_many(
            {
                "target_user_id": user_id,
                "target_device_id": device_id,
            },
            session=session,
        )

        return {
            "prekeys": deleted_prekeys.deleted_count,
            "envelopes": deleted_envelopes.deleted_count,
        }

    try:
        with db.client.start_session() as session:
            deleted = session.with_transaction(remove)

    except ValueError as error:
        return jsonify({"error": str(error)}), 409

    except LookupError as error:
        return jsonify({"error": str(error)}), 404

    except Exception:
        current_app.logger.exception(
            "Signal device removal transaction failed"
        )
        return jsonify({
            "error": "Unable to remove device"
        }), 503

    return jsonify({
        "message": "Device removed successfully",
        "device_id": device_id,
        "deleted_prekeys": deleted["prekeys"],
        "deleted_pending_envelopes": deleted["envelopes"],
    }), 200

@signal_bp.get("/identity/<user_id>")
@token_required
def get_identity(current_user, user_id):
    if not ObjectId.is_valid(user_id):
        return jsonify({"error": "Invalid user ID"}), 400

    target_user_id = ObjectId(user_id)
    requester_id = current_user["_id"]

    identity_type = request.args.get("identity_type", "aci")

    if identity_type not in {"aci", "pni"}:
        return jsonify({"error": "Invalid identity type"}), 400

    # Allow access to the account's own identity.
    # Other accounts require an accepted, unblocked connection.
    if target_user_id != requester_id:
        if (
            not are_connected(requester_id, target_user_id)
            or is_blocked(requester_id, target_user_id)
        ):
            return jsonify({"error": "Identity unavailable"}), 403

    canonical_id = (
        f"signal_identity:{target_user_id}:{identity_type}"
    )

    record = get_db()["signal_identities"].find_one(
        {
            "_id": canonical_id,
            "user_id": target_user_id,
            "identity_type": identity_type,
        },
        {
            "_id": 0,
            "identity": 1,
        },
    )

    if not record or not isinstance(record.get("identity"), dict):
        return jsonify({
            "identity": None,
            "identity_type": identity_type,
        }), 200

    identity = record["identity"]

    # Return only the public CompositeIdentityV1.
    return jsonify({
        "identity": {
            "version": identity.get("version"),
            "x25519PublicKey": identity.get("x25519PublicKey"),
            "ed25519PublicKey": identity.get("ed25519PublicKey"),
        },
        "identity_type": identity_type,
    }), 200

def decode_prekey_base64(value, max_length=10000):
    """Validate canonical Base64 without interpreting cryptographic keys."""
    if not isinstance(value, str) or not value or len(value) > max_length:
        return None

    try:
        decoded = base64.b64decode(value, validate=True)
        if not decoded:
            return None

        if base64.b64encode(decoded).decode("ascii") != value:
            return None

        return value
    except (ValueError, TypeError):
        return None



@signal_bp.post("/prekeys")
@token_required
def upload_prekeys(current_user):
    data = request.get_json(silent=True)

    if not isinstance(data, dict):
        return jsonify({"error": "Invalid JSON request"}), 400

    device_id = data.get("device_id")
    identity_type = data.get("identity_type", "aci")
    keys = data.get("keys")

    if (
        isinstance(device_id, bool)
        or not isinstance(device_id, int)
        or not 1 <= device_id <= MAX_DEVICES_PER_USER
    ):
        return jsonify({"error": "Invalid device ID"}), 400

    if identity_type not in {"aci", "pni"}:
        return jsonify({"error": "Invalid identity type"}), 400

    if not isinstance(keys, list) or not 1 <= len(keys) <= 250:
        return jsonify({"error": "Invalid prekey list"}), 400

    db = get_db()
    user_id = current_user["_id"]

    device = get_devices().find_one({
        "user_id": user_id,
        "device_id": device_id,
        "enabled": True,
    })

    if not device:
        return jsonify({"error": "Device not found"}), 404

    identity = db["signal_identities"].find_one({
        "_id": f"signal_identity:{user_id}:{identity_type}",
        "user_id": user_id,
        "identity_type": identity_type,
    })

    if not identity:
        return jsonify({
            "error": "Identity must be provisioned first"
        }), 409

    # Validate the complete batch before performing any writes.
    validated_keys = []
    seen = set()

    for item in keys:
        if not isinstance(item, dict):
            return jsonify({"error": "Invalid prekey entry"}), 400

        key_type = item.get("type")
        key_id = item.get("keyId")
        public_key = decode_prekey_base64(item.get("publicKey"))
        signature = item.get("signature")

        if key_type not in VALID_PREKEY_TYPES:
            return jsonify({
                "error": "Unsupported prekey type"
            }), 400

        if (
            isinstance(key_id, bool)
            or not isinstance(key_id, int)
            or not 0 <= key_id <= 2147483647
        ):
            return jsonify({"error": "Invalid prekey ID"}), 400

        if not public_key:
            return jsonify({"error": "Invalid public key"}), 400

        if key_type in {
            "ecSignedPreKey",
            "kemOneTimePreKey",
            "kemLastResortPreKey",
        }:
            signature = decode_prekey_base64(signature)

            if not signature:
                return jsonify({
                    "error": "A valid signature is required"
                }), 400

        elif signature is not None:
            return jsonify({
                "error": "Unexpected prekey signature"
            }), 400

        key_identity = (key_type, key_id)
        if key_identity in seen:
            return jsonify({"error": "Duplicate prekey"}), 400

        seen.add(key_identity)

        document = {
            "user_id": user_id,
            "device_id": device_id,
            "identity_type": identity_type,
            "type": key_type,
            "key_id": key_id,
            "public_key": public_key,
        }

        if signature is not None:
            document["signature"] = signature

        validated_keys.append(document)

    collection = db["signal_prekeys"]
    now = datetime.now(timezone.utc)
    inserted = 0

    def write_prekeys(session):
        inserted = 0

        for document in validated_keys:
            query = {
                "user_id": user_id,
                "device_id": device_id,
                "identity_type": identity_type,
                "type": document["type"],
                "key_id": document["key_id"],
            }

            existing = collection.find_one(
                query,
                session=session,
            )

            if existing:
                if (
                    existing.get("public_key") != document["public_key"]
                    or existing.get("signature") != document.get("signature")
                ):
                    raise ValueError(
                        "Prekey ID already exists with different key material"
                    )

                continue

            document_with_timestamp = {
                **document,
                "created_at": now,
            }

            collection.insert_one(
                document_with_timestamp,
                session=session,
            )

            inserted += 1

        available_types = set(
            collection.distinct(
                "type",
                {
                    "user_id": user_id,
                    "device_id": device_id,
                    "identity_type": identity_type,
                },
                session=session,
            )
        )

        device_registered = {
            "ecSignedPreKey",
            "kemLastResortPreKey",
        }.issubset(available_types)

        if device_registered:
            get_devices().update_one(
                {
                    "user_id": user_id,
                    "device_id": device_id,
                    "enabled": True,
                },
                {
                    "$set": {
                        "registered": True,
                        "last_seen_at": now,
                    }
                },
                session=session,
            )

        return {
            "registered": device_registered,
            "inserted": inserted,
        }

    try:
        with db.client.start_session() as session:
            transaction_result = session.with_transaction(
                write_prekeys
            )

        device_registered = transaction_result["registered"]
        inserted = transaction_result["inserted"]

    except ValueError as error:
        return jsonify({"error": str(error)}), 409

    except DuplicateKeyError:
        return jsonify({
            "error": "Prekey upload conflict"
        }), 409

    except Exception:
        current_app.logger.exception(
            "Signal prekey upload transaction failed"
        )
        return jsonify({
            "error": "Unable to upload prekeys"
        }), 503
        
    return jsonify({
        "message": "Prekeys uploaded successfully",
        "device_id": device_id,
        "identity_type": identity_type,
        "inserted": inserted,
        "registered": device_registered,
    }), 200




@signal_bp.get("/prekeys/<user_id>/<int:device_id>")
@token_required
def fetch_prekey_bundle(current_user, user_id, device_id):
    if not ObjectId.is_valid(user_id):
        return jsonify({"error": "Invalid recipient ID"}), 400

    if not 1 <= device_id <= MAX_DEVICES_PER_USER:
        return jsonify({"error": "Invalid device ID"}), 400

    identity_type = request.args.get("identity_type", "aci")

    if identity_type not in {"aci", "pni"}:
        return jsonify({"error": "Invalid identity type"}), 400

    recipient_id = ObjectId(user_id)

    if recipient_id != current_user["_id"]:
        if (
            not are_connected(current_user["_id"], recipient_id)
            or is_blocked(current_user["_id"], recipient_id)
        ):
            return jsonify({"error": "Recipient is unavailable"}), 403

    db = get_db()

    device = db["signal_devices"].find_one({
        "user_id": recipient_id,
        "device_id": device_id,
        "enabled": True,
        "registered": True,
    })

    if not device:
        return jsonify({"error": "Recipient device not found"}), 404

    identity = db["signal_identities"].find_one({
        "_id": f"signal_identity:{recipient_id}:{identity_type}",
        "user_id": recipient_id,
        "identity_type": identity_type,
    })

    if not identity:
        return jsonify({"error": "Recipient account identity not found"}), 404

    registration_id = device.get("registration_id")
    if not isinstance(registration_id, int) or isinstance(registration_id, bool):
        return jsonify({"error": "Recipient device registration is incomplete"}), 409

    collection = db["signal_prekeys"]

    class PrekeyUnavailable(Exception):
        pass

    def consume_prekeys(session):
        query = {
            "user_id": recipient_id,
            "device_id": device_id,
            "identity_type": identity_type,
        }

        signed = collection.find_one(
            {**query, "type": "ecSignedPreKey"},
            session=session,
        )

        if not signed:
            raise PrekeyUnavailable("Signed prekey unavailable")

        ec_one_time = collection.find_one_and_delete(
            {**query, "type": "ecPreKey"},
            sort=[("key_id", 1)],
            session=session,
        )

        kem_one_time = collection.find_one_and_delete(
            {**query, "type": "kemOneTimePreKey"},
            sort=[("key_id", 1)],
            session=session,
        )

        kem_fallback = None

        if not kem_one_time:
            kem_fallback = collection.find_one(
                {**query, "type": "kemLastResortPreKey"},
                session=session,
            )

        if not kem_one_time and not kem_fallback:
            raise PrekeyUnavailable("KEM prekey unavailable")

        bundle = {
            "registrationId": registration_id,
            "deviceId": device_id,
            "identity": identity["identity"],
            "ecSignedPreKey": {
                "keyId": signed["key_id"],
                "publicKey": signed["public_key"],
                "signature": signed["signature"],
            },
        }

        if ec_one_time:
            bundle["ecOneTimePreKey"] = {
                "keyId": ec_one_time["key_id"],
                "publicKey": ec_one_time["public_key"],
            }

        if kem_one_time:
           bundle["kemOneTimePreKey"] = {
                "keyId": kem_one_time["key_id"],
                "publicKey": kem_one_time["public_key"],
                "signature": kem_one_time["signature"],
            }
        
        else:
            bundle["kemLastResortPreKey"] = {
                "keyId": kem_fallback["key_id"],
                "publicKey": kem_fallback["public_key"],
                "signature": kem_fallback["signature"],
            }
        
        return bundle

    try:
        with db.client.start_session() as session:
            bundle = session.with_transaction(consume_prekeys)

        return jsonify(bundle), 200

    except PrekeyUnavailable as error:
        return jsonify({"error": str(error)}), 503

    except Exception:
        current_app.logger.exception(
            "Signal prekey bundle transaction failed"
        )
        return jsonify({"error": "Unable to retrieve prekey bundle"}), 503


# --------------------------------------------------
# SIGNAL ENCRYPTED ENVELOPE MAILBOX
# --------------------------------------------------

VALID_ENVELOPE_TYPES = {
    "ciphertext",
    "prekey_bundle",
    "sender_key",
    "unidentified_sender",
    "retry_request",
}

MAX_ENVELOPE_SIZE = 1024 * 1024
ENVELOPE_TTL_DAYS = 7


@signal_bp.get("/prekeys/<user_id>/<int:device_id>/inventory")
@token_required
def get_prekey_inventory(current_user, user_id, device_id):
    if not ObjectId.is_valid(user_id):
        return jsonify({"error": "Invalid user ID"}), 400

    if not 1 <= device_id <= MAX_DEVICES_PER_USER:
        return jsonify({"error": "Invalid device ID"}), 400

    identity_type = request.args.get("identity_type", "aci")

    if identity_type not in {"aci", "pni"}:
        return jsonify({"error": "Invalid identity type"}), 400

    target_user_id = ObjectId(user_id)

    # Inventory is private to the authenticated account.
    if target_user_id != current_user["_id"]:
        return jsonify({"error": "Inventory unavailable"}), 403

    db = get_db()

    # Allow an enabled device that has not completed initial
    # prekey registration. The SDK needs an empty inventory
    # during its first synchronization.
    device = db["signal_devices"].find_one({
        "user_id": target_user_id,
        "device_id": device_id,
        "enabled": True,
    })

    if not device:
        return jsonify({"error": "Device not found"}), 404

    collection = db["signal_prekeys"]

    query = {
        "user_id": target_user_id,
        "device_id": device_id,
        "identity_type": identity_type,
    }

    signed = collection.find_one({
        **query,
        "type": "ecSignedPreKey",
    })

    kem_last_resort = collection.find_one({
        **query,
        "type": "kemLastResortPreKey",
    })

    def to_timestamp_ms(value):
        if value is None:
            return None

        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)

        return int(value.timestamp() * 1000)

    def encode_public_key(value):
        if isinstance(value, str):
            return value

        if isinstance(value, (bytes, bytearray)):
            return base64.b64encode(value).decode("ascii")

        raise ValueError("Invalid stored public key")

    def metadata(record):
        if not record:
            return None

        created_at = to_timestamp_ms(record.get("created_at"))

        if created_at is None:
            raise ValueError("Prekey creation timestamp is missing")

        # SDK default key refresh interval: 48 hours.
        expires_at = created_at + (48 * 60 * 60 * 1000)

        return {
            "keyId": record["key_id"],
            "createdAt": created_at,
            "expiresAt": expires_at,
            "publicKey": encode_public_key(record["public_key"]),
        }

    try:
        inventory = {
            "ecSignedPreKey": metadata(signed),
            "kemLastResortPreKey": metadata(kem_last_resort),

            "ecOneTimePreKeyCount": collection.count_documents({
                **query,
                "type": "ecPreKey",
            }),

            "kemOneTimePreKeyCount": collection.count_documents({
                **query,
                "type": "kemOneTimePreKey",
            }),
        }

        return jsonify(inventory), 200

    except (KeyError, TypeError, ValueError):
        current_app.logger.exception(
            "Invalid Signal prekey inventory data"
        )
        return jsonify({
            "error": "Unable to read prekey inventory"
        }), 500


@signal_bp.delete("/prekeys/clear-stale-kem")
@token_required
def clear_stale_kem_prekeys(current_user):
    data = request.get_json(silent=True) or {}

    device_id = data.get("device_id")
    identity_type = data.get("identity_type", "aci")

    if (
        isinstance(device_id, bool)
        or not isinstance(device_id, int)
        or not 1 <= device_id <= MAX_DEVICES_PER_USER
    ):
        return jsonify({"error": "Invalid device ID"}), 400

    if identity_type not in {"aci", "pni"}:
        return jsonify({"error": "Invalid identity type"}), 400

    device = get_devices().find_one({
        "user_id": current_user["_id"],
        "device_id": device_id,
        "enabled": True,
    })

    if not device:
        return jsonify({"error": "Device not found"}), 404

    collection = get_db()["signal_prekeys"]

    result = collection.delete_many({
        "user_id": current_user["_id"],
        "device_id": device_id,
        "identity_type": identity_type,
        "type": "kemOneTimePreKey",
    })

    return jsonify({
        "cleared": result.deleted_count,
    }), 200


def validate_signal_device(user_id, device_id):
    if (
        isinstance(device_id, bool)
        or not isinstance(device_id, int)
        or not 1 <= device_id <= MAX_DEVICES_PER_USER
    ):
        return None

    return get_devices().find_one({
        "user_id": user_id,
        "device_id": device_id,
        "enabled": True,
        "registered": True,
    })



# ---------------------------------------------------------
# GRUS TEMPORARY LINKED-DEVICE TRANSFER
# Stores encrypted backup payloads only.
# ---------------------------------------------------------

TRANSFER_TTL_MINUTES = 10
MAX_TRANSFER_CIPHERTEXT_CHARS = 8 * 1024 * 1024


def get_device_transfers():
    collection = get_db()["signal_device_transfers"]

    collection.create_index(
        [("expires_at", 1)],
        expireAfterSeconds=0,
        name="signal_transfer_expiry_ttl",
    )

    return collection

def cleanup_expired_transfers():
    get_device_transfers().delete_many({
        "expires_at": {"$lte": datetime.now(timezone.utc)}
    })


@signal_bp.post("/device-transfers")
@token_required
def create_device_transfer(current_user):
    data = request.get_json(silent=True)

    if not isinstance(data, dict):
        return jsonify({"error": "Invalid JSON request"}), 400

    source_id = data.get("source_device_id")
    target_id = data.get("target_device_id")

    if (
        isinstance(source_id, bool)
        or not isinstance(source_id, int)
        or isinstance(target_id, bool)
        or not isinstance(target_id, int)
        or not 1 <= source_id <= MAX_DEVICES_PER_USER
        or not 2 <= target_id <= MAX_DEVICES_PER_USER
        or source_id == target_id
    ):
        return jsonify({"error": "Invalid source or target device"}), 400

    user_id = current_user["_id"]
    devices = get_devices()

    source = devices.find_one({
        "user_id": user_id,
        "device_id": source_id,
        "enabled": True,
        "registered": True,
    })

    if not source:
        return jsonify({"error": "Source device is not registered"}), 403

    target = devices.find_one({
        "user_id": user_id,
        "device_id": target_id,
        "enabled": True,
        "registered": False,
    })

    if not target:
        return jsonify({
            "error": "Target must be an enabled, pending device"
        }), 409

    cleanup_expired_transfers()

    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(minutes=TRANSFER_TTL_MINUTES)
    transfer_id = secrets.token_urlsafe(32)
    transfer_secret = secrets.token_urlsafe(32)
    transfer_secret_hash = hashlib.sha256(
        transfer_secret.encode("utf-8")
    ).hexdigest()

    get_device_transfers().insert_one({
        "transfer_id": transfer_id,
        "user_id": user_id,
        "source_device_id": source_id,
        "target_device_id": target_id,
        "status": "created",
        "encrypted_backup": None,
        "created_at": now,
        "expires_at": expires_at,
        "transfer_secret_hash": transfer_secret_hash,
    })

    return jsonify({
        "transfer_id": transfer_id,
        "transfer_secret": transfer_secret,
        "source_device_id": source_id,
        "target_device_id": target_id,
        "expires_at": expires_at.isoformat(),
        "message": "Device transfer session created",
    }), 201



@signal_bp.post("/device-transfers/<transfer_id>/backup")
@token_required
def upload_device_transfer_backup(current_user, transfer_id):
    data = request.get_json(silent=True)

    if not isinstance(data, dict):
        return jsonify({"error": "Invalid JSON request"}), 400

    source_id = data.get("source_device_id")
    backup = data.get("encrypted_backup")

    if (
        isinstance(source_id, bool)
        or not isinstance(source_id, int)
        or not isinstance(backup, dict)
    ):
        return jsonify({"error": "Invalid transfer payload"}), 400

    ciphertext = backup.get("ciphertext")
    iv = backup.get("iv")
    auth_tag = backup.get("authTag")
    metadata = backup.get("metadata")

    if (
        not isinstance(ciphertext, str)
        or not ciphertext
        or len(ciphertext) > MAX_TRANSFER_CIPHERTEXT_CHARS
        or not isinstance(iv, str)
        or not isinstance(auth_tag, str)
        or not isinstance(metadata, dict)
        or isinstance(metadata.get("version"), bool)
        or not isinstance(metadata.get("version"), int)
        or isinstance(metadata.get("timestamp"), bool)
        or not isinstance(metadata.get("timestamp"), (int, float))
        or isinstance(metadata.get("sizeBytes"), bool)
        or not isinstance(metadata.get("sizeBytes"), int)
        or metadata["sizeBytes"] < 0
    ):
        return jsonify({"error": "Invalid encrypted backup"}), 400

    now = datetime.now(timezone.utc)

    # Validate transfer authorization secret.
    transfer_secret = request.headers.get(
        "X-GRUS-Transfer-Secret", ""
    )

    if not transfer_secret or len(transfer_secret) > 256:
        return jsonify({
            "error": "Invalid transfer authorization"
        }), 401

    transfer_secret_hash = hashlib.sha256(
        transfer_secret.encode("utf-8")
    ).hexdigest()

    # Upload only to the authorized transfer session.
    result = get_device_transfers().update_one(
        {
            "transfer_id": transfer_id,
            "user_id": current_user["_id"],
            "source_device_id": source_id,
            "transfer_secret_hash": transfer_secret_hash,
            "status": "created",
            "expires_at": {"$gt": now},
        },
        {
            "$set": {
                "encrypted_backup": {
                    "ciphertext": ciphertext,
                    "iv": iv,
                    "authTag": auth_tag,
                    "metadata": {
                        "version": metadata["version"],
                        "timestamp": metadata["timestamp"],
                        "sizeBytes": metadata["sizeBytes"],
                    },
                },
                "status": "uploaded",
                "uploaded_at": now,
            }
        },
    )

    if result.modified_count != 1:
        return jsonify({
            "error": "Transfer session not found, expired, or already used"
        }), 404

    return jsonify({
        "message": "Encrypted backup uploaded",
        "status": "uploaded",
    }), 200



@signal_bp.get("/device-transfers/<transfer_id>")
@token_required
def get_device_transfer_backup(current_user, transfer_id):
    target_id = request.args.get("device_id", type=int)

    if (
        target_id is None
        or not 2 <= target_id <= MAX_DEVICES_PER_USER
    ):
        return jsonify({"error": "Invalid target device"}), 400

    now = datetime.now(timezone.utc)

    # Validate transfer authorization secret.
    transfer_secret = request.headers.get(
    "X-GRUS-Transfer-Secret", ""
)

    if not transfer_secret or len(transfer_secret) > 256:
        return jsonify({
            "error": "Invalid transfer authorization"
        }), 401

    transfer_secret_hash = hashlib.sha256(
        transfer_secret.encode("utf-8")
    ).hexdigest()

    # Atomically claim the backup. Only one request can succeed.
    transfer = get_device_transfers().find_one_and_update(
        {
            "transfer_id": transfer_id,
            "user_id": current_user["_id"],
            "target_device_id": target_id,
            "transfer_secret_hash": transfer_secret_hash,
            "status": "uploaded",
            "expires_at": {"$gt": now},
        },
        {
            "$set": {
                "status": "retrieved",
                "retrieved_at": now,
            }
        },
        projection={
            "_id": 0,
            "encrypted_backup": 1,
        },
        return_document=ReturnDocument.BEFORE,
    )

    if not transfer:
        return jsonify({
            "error": "Transfer not found, expired, or already retrieved"
        }), 404

    return jsonify({
        "encrypted_backup": transfer["encrypted_backup"],
        "status": "retrieved",
    }), 200




@signal_bp.post("/device-transfers/<transfer_id>/complete")
@token_required
def complete_device_transfer(current_user, transfer_id):
    data = request.get_json(silent=True)

    if not isinstance(data, dict):
        return jsonify({"error": "Invalid JSON request"}), 400

    target_id = data.get("target_device_id")

    if (
        isinstance(target_id, bool)
        or not isinstance(target_id, int)
        or not 2 <= target_id <= MAX_DEVICES_PER_USER
    ):
        return jsonify({"error": "Invalid target device"}), 400

    now = datetime.now(timezone.utc)

    # Validate transfer authorization secret.
    transfer_secret = request.headers.get(
        "X-GRUS-Transfer-Secret", ""
    )

    if not transfer_secret or len(transfer_secret) > 256:
        return jsonify({
            "error": "Invalid transfer authorization"
        }), 401

    transfer_secret_hash = hashlib.sha256(
        transfer_secret.encode("utf-8")
    ).hexdigest()

    # Delete only the authorized, retrieved transfer.
    result = get_device_transfers().delete_one({
        "transfer_id": transfer_id,
        "user_id": current_user["_id"],
        "target_device_id": target_id,
        "transfer_secret_hash": transfer_secret_hash,
        "status": "retrieved",
        "expires_at": {"$gt": now},
    })

    if result.deleted_count != 1:
        return jsonify({
            "error": "Transfer not found, expired, or already completed"
        }), 404

    return jsonify({
        "message": "Device transfer completed",
        "deleted": True,
    }), 200


@signal_bp.post("/envelopes")
@token_required
def send_signal_envelope(current_user):
    data = request.get_json(silent=True)

    if not isinstance(data, dict):
        return jsonify({"error": "Invalid JSON request"}), 400

    sender_id = current_user["_id"]

    sender_device_id = data.get("senderDeviceId")
    target_user_id = data.get("targetUserId")
    target_device_id = data.get("targetDeviceId")

    # The sender identity always comes from JWT authentication.
    supplied_sender = data.get("senderUserId")

    if supplied_sender is not None and supplied_sender != str(sender_id):
        return jsonify({"error": "Sender identity mismatch"}), 403

    if not ObjectId.is_valid(target_user_id):
        return jsonify({"error": "Invalid target user ID"}), 400

    if not validate_signal_device(sender_id, sender_device_id):
        return jsonify({"error": "Sender device is not registered"}), 403

    recipient_id = ObjectId(target_user_id)

    recipient_device = validate_signal_device(
        recipient_id,
        target_device_id,
    )

    if not recipient_device:
        return jsonify({"error": "Recipient device is not registered"}), 404

    if recipient_id != sender_id:
        if (
            not are_connected(sender_id, recipient_id)
            or is_blocked(sender_id, recipient_id)
        ):
            return jsonify({"error": "Recipient is unavailable"}), 403

    ciphertext = data.get("ciphertext")

    if (
        not isinstance(ciphertext, str)
        or not ciphertext
        or len(ciphertext.encode("utf-8")) > MAX_ENVELOPE_SIZE
    ):
        return jsonify({"error": "Invalid or oversized ciphertext"}), 400

    message_type = data.get("messageType")

    if message_type not in VALID_ENVELOPE_TYPES:
        return jsonify({"error": "Invalid message type"}), 400

    delivery_class = data.get("deliveryClass")

    if (
        not isinstance(delivery_class, str)
        or not delivery_class
        or len(delivery_class) > 64
    ):
        return jsonify({"error": "Invalid delivery class"}), 400

    timestamp = data.get("timestamp")

    if (
        isinstance(timestamp, bool)
        or not isinstance(timestamp, (int, float))
        or not math.isfinite(timestamp)
        or timestamp < 0
    ):
        return jsonify({"error": "Invalid timestamp"}), 400

    client_message_id = data.get("clientMessageId")

    if client_message_id is not None:
        if (
            not isinstance(client_message_id, str)
            or not client_message_id.strip()
            or len(client_message_id) > 128
        ):
            return jsonify({"error": "Invalid client message ID"}), 400

    content_kind = data.get("contentKind")

    if content_kind is not None and content_kind not in {
        "message",
        "receipt",
    }:
        return jsonify({"error": "Invalid content kind"}), 400

    now = datetime.now(timezone.utc)

    envelope = {
        "target_user_id": recipient_id,
        "target_device_id": target_device_id,
        "sender_user_id": sender_id,
        "sender_device_id": sender_device_id,
        "ciphertext": ciphertext,
        "message_type": message_type,
        "delivery_class": delivery_class,
        "timestamp": timestamp,
        "created_at": now,
        "expires_at": now + timedelta(days=ENVELOPE_TTL_DAYS),
    }

    optional_fields = {
        "client_message_id": client_message_id,
        "content_kind": content_kind,
        "content_hint": data.get("contentHint"),
        "operation_epoch_milliseconds": data.get(
            "operationEpochMilliseconds"
        ),
        "declared_device_ids": data.get("declaredDeviceIds"),
        "recipient_registration_id": data.get(
            "recipientRegistrationId"
        ),
    }

    for field, value in optional_fields.items():
        if value is not None:
            envelope[field] = value

    collection = get_db()["signal_envelopes"]

    try:
        result = collection.insert_one(envelope)
        envelope_id = str(result.inserted_id)
        duplicate = False

    except DuplicateKeyError:
        if not client_message_id:
            return jsonify({"error": "Envelope insertion conflict"}), 409

        existing = collection.find_one({
            "sender_user_id": sender_id,
            "client_message_id": client_message_id,
        })

        if not existing:
            return jsonify({"error": "Envelope conflict"}), 409

        envelope_id = str(existing["_id"])
        duplicate = True

    # Notify the recipient without sending ciphertext in the event.
    socketio = current_app.extensions.get("socketio")

    if socketio and not duplicate:
        socketio.emit(
            "signal_envelope_available",
            {
                "envelope_id": envelope_id,
                "device_id": target_device_id,
            },
            to=f"user:{recipient_id}",
        )

    return jsonify({
        "messageId": envelope_id,
        "serverTimestamp": int(now.timestamp() * 1000),
        "duplicate": duplicate,
        "expiresAt": int(
            (now + timedelta(days=ENVELOPE_TTL_DAYS)).timestamp() * 1000
        ),
    }), 200


@signal_bp.get("/envelopes")
@token_required
def get_signal_envelopes(current_user):
    device_id = request.args.get("device_id", type=int)

    if not validate_signal_device(current_user["_id"], device_id):
        return jsonify({"error": "Invalid or unregistered device"}), 403

    now = datetime.now(timezone.utc)

    collection = get_db()["signal_envelopes"]

    documents = list(
        collection.find({
            "target_user_id": current_user["_id"],
            "target_device_id": device_id,
            "expires_at": {"$gt": now},
        })
        .sort("created_at", 1)
        .limit(100)
    )

    envelopes = []

    for document in documents:
        item = {
            "id": str(document["_id"]),
            "targetUserId": str(document["target_user_id"]),
            "targetDeviceId": document["target_device_id"],
            "senderUserId": str(document["sender_user_id"]),
            "senderDeviceId": document["sender_device_id"],
            "ciphertext": document["ciphertext"],
            "messageType": document["message_type"],
            "deliveryClass": document["delivery_class"],
            "timestamp": document["timestamp"],
        }

        optional_mapping = {
            "client_message_id": "clientMessageId",
            "content_kind": "contentKind",
            "content_hint": "contentHint",
            "operation_epoch_milliseconds": "operationEpochMilliseconds",
            "declared_device_ids": "declaredDeviceIds",
            "recipient_registration_id": "recipientRegistrationId",
        }

        for stored_name, response_name in optional_mapping.items():
            if stored_name in document:
                item[response_name] = document[stored_name]

        envelopes.append(item)

    return jsonify({
        "envelopes": envelopes,
        "count": len(envelopes),
    }), 200


@signal_bp.post("/envelopes/<envelope_id>/ack")
@token_required
def acknowledge_signal_envelope(current_user, envelope_id):
    if not ObjectId.is_valid(envelope_id):
        return jsonify({"error": "Invalid envelope ID"}), 400

    data = request.get_json(silent=True)

    if not isinstance(data, dict):
        return jsonify({"error": "Invalid JSON request"}), 400

    device_id = data.get("device_id")

    if not validate_signal_device(current_user["_id"], device_id):
        return jsonify({"error": "Invalid or unregistered device"}), 403

    result = get_db()["signal_envelopes"].delete_one({
        "_id": ObjectId(envelope_id),
        "target_user_id": current_user["_id"],
        "target_device_id": device_id,
    })

    if result.deleted_count != 1:
        return jsonify({
            "error": "Envelope not found or already acknowledged"
        }), 404

    return jsonify({
        "message": "Envelope acknowledged",
        "envelopeId": envelope_id,
    }), 200
