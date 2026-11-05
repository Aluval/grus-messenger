from datetime import datetime, timezone

from bson import ObjectId
from flask import Blueprint, current_app, jsonify
from pymongo.errors import DuplicateKeyError

from routes.auth import token_required, get_users

connections_bp = Blueprint(
    "connections",
    __name__,
    url_prefix="/api/connections"
)


def get_db():
    return current_app.extensions["mongo_db"]


def get_requests():
    return get_db()["connection_requests"]


def get_connections():
    return get_db()["connections"]


def get_blocks():
    return get_db()["blocked_users"]


def make_pair_key(user_a, user_b):
    return ":".join(sorted([str(user_a), str(user_b)]))


def is_blocked(user_a, user_b):
    return get_blocks().find_one({
        "$or": [
            {"blocker_id": user_a, "blocked_id": user_b},
            {"blocker_id": user_b, "blocked_id": user_a}
        ]
    }) is not None


def are_connected(user_a, user_b):
    return get_connections().find_one({
        "pair_key": make_pair_key(user_a, user_b)
    }) is not None


def valid_user_id(user_id):
    return isinstance(user_id, str) and ObjectId.is_valid(user_id)


def user_summary(user_id):
    user = get_users().find_one(
        {"_id": user_id},
        {"username": 1}
    )

    if not user:
        return None

    return {
        "id": str(user["_id"]),
        "username": user["username"]
    }


# Send a connection request
@connections_bp.post("/requests/<recipient_id>")
@token_required
def send_request(current_user, recipient_id):
    if not valid_user_id(recipient_id):
        return jsonify({"error": "Invalid user ID"}), 400

    recipient_object_id = ObjectId(recipient_id)
    sender_id = current_user["_id"]

    if recipient_object_id == sender_id:
        return jsonify({"error": "You cannot connect with yourself"}), 400

    recipient = get_users().find_one({"_id": recipient_object_id})

    if not recipient:
        return jsonify({"error": "User not found"}), 404

    if is_blocked(sender_id, recipient_object_id):
        return jsonify({
            "error": "Connection request is not available"
        }), 403

    if are_connected(sender_id, recipient_object_id):
        return jsonify({
            "error": "You are already connected"
        }), 409

    requests = get_requests()

    reverse_pending = requests.find_one({
        "sender_id": recipient_object_id,
        "recipient_id": sender_id,
        "status": "pending"
    })

    if reverse_pending:
        return jsonify({
            "error": "This user has already sent you a request. Accept their request instead."
        }), 409

    existing = requests.find_one({
        "sender_id": sender_id,
        "recipient_id": recipient_object_id,
        "status": "pending"
    })

    if existing:
        return jsonify({
            "message": "Connection request already pending",
            "request_id": str(existing["_id"])
        }), 200

    request_document = {
        "sender_id": sender_id,
        "recipient_id": recipient_object_id,
        "status": "pending",
        "created_at": datetime.now(timezone.utc),
        "responded_at": None
    }

    try:
        result = requests.insert_one(request_document)
    except DuplicateKeyError:
        return jsonify({
            "error": "A connection request already exists"
        }), 409

    return jsonify({
        "message": "Connection request sent",
        "request_id": str(result.inserted_id)
    }), 201


# View incoming and outgoing requests
@connections_bp.get("/requests")
@token_required
def list_requests(current_user):
    user_id = current_user["_id"]
    requests = get_requests()

    incoming_documents = list(requests.find({
        "recipient_id": user_id,
        "status": "pending"
    }).sort("created_at", -1))

    outgoing_documents = list(requests.find({
        "sender_id": user_id,
        "status": "pending"
    }).sort("created_at", -1))

    incoming = []
    outgoing = []

    for item in incoming_documents:
        sender = user_summary(item["sender_id"])

        if sender:
            incoming.append({
                "request_id": str(item["_id"]),
                "user": sender,
                "created_at": item["created_at"].isoformat()
            })

    for item in outgoing_documents:
        recipient = user_summary(item["recipient_id"])

        if recipient:
            outgoing.append({
                "request_id": str(item["_id"]),
                "user": recipient,
                "created_at": item["created_at"].isoformat()
            })

    return jsonify({
        "incoming": incoming,
        "outgoing": outgoing
    }), 200


# Accept an incoming request
@connections_bp.post("/requests/<request_id>/accept")
@token_required
def accept_request(current_user, request_id):
    if not valid_user_id(request_id):
        return jsonify({"error": "Invalid request ID"}), 400

    request_object_id = ObjectId(request_id)
    recipient_id = current_user["_id"]

    request_document = get_requests().find_one({
        "_id": request_object_id,
        "recipient_id": recipient_id,
        "status": "pending"
    })

    if not request_document:
        return jsonify({
            "error": "Pending connection request not found"
        }), 404

    sender_id = request_document["sender_id"]

    if is_blocked(sender_id, recipient_id):
        return jsonify({
            "error": "This connection request cannot be accepted"
        }), 403

    now = datetime.now(timezone.utc)

    # Atomically claim the pending request
    result = get_requests().update_one(
        {
            "_id": request_object_id,
            "recipient_id": recipient_id,
            "status": "pending"
        },
        {
            "$set": {
                "status": "accepted",
                "responded_at": now
            }
        }
    )

    if result.modified_count == 0:
        return jsonify({
            "error": "Request was already processed"
        }), 409

    # Create the accepted connection
    pair_key = make_pair_key(sender_id, recipient_id)

    try:
        get_connections().update_one(
            {"pair_key": pair_key},
            {
                "$setOnInsert": {
                    "pair_key": pair_key,
                    "participants": [sender_id, recipient_id],
                    "created_at": now
                }
            },
            upsert=True
        )
    except DuplicateKeyError:
        pass

    return jsonify({
        "message": "Connection accepted",
        "connection": {
            "user": user_summary(sender_id)
        }
    }), 200

# Decline an incoming request
@connections_bp.post("/requests/<request_id>/decline")
@token_required
def decline_request(current_user, request_id):
    if not valid_user_id(request_id):
        return jsonify({"error": "Invalid request ID"}), 400

    result = get_requests().update_one(
        {
            "_id": ObjectId(request_id),
            "recipient_id": current_user["_id"],
            "status": "pending"
        },
        {
            "$set": {
                "status": "declined",
                "responded_at": datetime.now(timezone.utc)
            }
        }
    )

    if result.modified_count == 0:
        return jsonify({
            "error": "Pending connection request not found"
        }), 404

    return jsonify({
        "message": "Connection request declined"
    }), 200

# Cancel an outgoing pending request
@connections_bp.delete("/requests/<request_id>/cancel")
@token_required
def cancel_request(current_user, request_id):
    if not valid_user_id(request_id):
        return jsonify({"error": "Invalid request ID"}), 400

    result = get_requests().delete_one({
        "_id": ObjectId(request_id),
        "sender_id": current_user["_id"],
        "status": "pending"
    })

    if result.deleted_count == 0:
        return jsonify({
            "error": "Outgoing pending request not found"
        }), 404

    return jsonify({
        "message": "Connection request cancelled"
    }), 200

# View accepted connections
@connections_bp.get("/")
@token_required
def list_connections(current_user):
    user_id = current_user["_id"]

    documents = list(get_connections().find({
        "participants": user_id
    }).sort("created_at", -1))

    results = []

    for document in documents:
        other_id = next(
            (
                participant
                for participant in document["participants"]
                if participant != user_id
            ),
            None
        )

        if not other_id:
            continue

        user = user_summary(other_id)

        if user:
            results.append({
                "connection_id": str(document["_id"]),
                "user": user,
                "created_at": document["created_at"].isoformat()
            })

    return jsonify({"connections": results}), 200


# Remove an accepted connection
@connections_bp.delete("/<user_id>")
@token_required
def remove_connection(current_user, user_id):
    if not valid_user_id(user_id):
        return jsonify({"error": "Invalid user ID"}), 400

    other_id = ObjectId(user_id)

    if other_id == current_user["_id"]:
        return jsonify({"error": "Invalid connection"}), 400

    result = get_connections().delete_one({
        "pair_key": make_pair_key(current_user["_id"], other_id)
    })

    if result.deleted_count == 0:
        return jsonify({
            "error": "Connection not found"
        }), 404

    return jsonify({
        "message": "Connection removed"
    }), 200


# Block a user
@connections_bp.post("/blocked/<user_id>")
@token_required
def block_user(current_user, user_id):
    if not valid_user_id(user_id):
        return jsonify({"error": "Invalid user ID"}), 400

    blocked_id = ObjectId(user_id)
    blocker_id = current_user["_id"]

    if blocked_id == blocker_id:
        return jsonify({"error": "You cannot block yourself"}), 400

    if not get_users().find_one({"_id": blocked_id}):
        return jsonify({"error": "User not found"}), 404

    now = datetime.now(timezone.utc)

    get_blocks().update_one(
        {
            "blocker_id": blocker_id,
            "blocked_id": blocked_id
        },
        {
            "$setOnInsert": {
                "blocker_id": blocker_id,
                "blocked_id": blocked_id,
                "created_at": now
            }
        },
        upsert=True
    )

    pair_key = make_pair_key(blocker_id, blocked_id)

    get_connections().delete_one({"pair_key": pair_key})

    get_requests().update_many(
        {
            "$or": [
                {"sender_id": blocker_id, "recipient_id": blocked_id},
                {"sender_id": blocked_id, "recipient_id": blocker_id}
            ],
            "status": "pending"
        },
        {
            "$set": {
                "status": "cancelled",
                "responded_at": now
            }
        }
    )

    return jsonify({"message": "User blocked"}), 200


# View users blocked by the current user
@connections_bp.get("/blocked")
@token_required
def list_blocked_users(current_user):
    documents = list(get_blocks().find({
        "blocker_id": current_user["_id"]
    }).sort("created_at", -1))

    results = []

    for document in documents:
        user = user_summary(document["blocked_id"])

        if user:
            results.append({
                "user": user,
                "created_at": document["created_at"].isoformat()
            })

    return jsonify({"blocked": results}), 200


# Unblock a user
@connections_bp.delete("/blocked/<user_id>")
@token_required
def unblock_user(current_user, user_id):
    if not valid_user_id(user_id):
        return jsonify({"error": "Invalid user ID"}), 400

    result = get_blocks().delete_one({
        "blocker_id": current_user["_id"],
        "blocked_id": ObjectId(user_id)
    })

    if result.deleted_count == 0:
        return jsonify({"error": "Blocked user not found"}), 404

    return jsonify({"message": "User unblocked"}), 200
