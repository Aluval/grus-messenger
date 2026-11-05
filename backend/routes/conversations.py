
from datetime import datetime, timezone

from bson import ObjectId
from flask import Blueprint, jsonify, request, current_app
from pymongo.errors import DuplicateKeyError

from routes.auth import token_required, get_users
from routes.connections import (
    are_connected,
    is_blocked,
    make_pair_key
)

conversations_bp = Blueprint(
    "conversations",
    __name__,
    url_prefix="/api/conversations"
)


def get_conversations():
    return current_app.extensions["mongo_db"]["conversations"]


@conversations_bp.post("/")
@token_required
def create_conversation(current_user):
    data = request.get_json(silent=True) or {}
    recipient_id = data.get("recipient_id")

    # Validate recipient ID
    if not isinstance(recipient_id, str) or not ObjectId.is_valid(recipient_id):
        return jsonify({
            "error": "Valid recipient ID is required"
        }), 400

    sender_id = current_user["_id"]
    recipient_object_id = ObjectId(recipient_id)

    # Prevent self-conversations
    if recipient_object_id == sender_id:
        return jsonify({
            "error": "You cannot start a conversation with yourself"
        }), 400

    # Verify recipient account
    recipient = get_users().find_one({
        "_id": recipient_object_id
    })

    if not recipient:
        return jsonify({
            "error": "Recipient account not found"
        }), 404

    # Check whether either user has blocked the other
    if is_blocked(sender_id, recipient_object_id):
        return jsonify({
            "error": "Conversation is not available"
        }), 403

    # Only accepted connections can start conversations
    if not are_connected(sender_id, recipient_object_id):
        return jsonify({
            "error": "You must be connected before starting a conversation"
        }), 403

    # Generate a consistent key for this user pair
    pair_key = make_pair_key(sender_id, recipient_object_id)

    participant_ids = sorted([
        str(sender_id),
        str(recipient_object_id)
    ])

    conversations = get_conversations()

    # Reuse an existing conversation
    existing = conversations.find_one({
        "pair_key": pair_key
    })

    if existing:
        return jsonify({
            "message": "Conversation already exists",
            "conversation": {
                "id": str(existing["_id"]),
                "participants": participant_ids
            }
        }), 200

    # Create a new conversation
    now = datetime.now(timezone.utc)

    conversation = {
        "pair_key": pair_key,
        "participants": [
            sender_id,
            recipient_object_id
        ],
        "created_at": now,
        "last_message_at": None
    }

    try:
        result = conversations.insert_one(conversation)

    except DuplicateKeyError:
        # Another request may have created it simultaneously
        existing = conversations.find_one({
            "pair_key": pair_key
        })

        if not existing:
            return jsonify({
                "error": "Could not create conversation"
            }), 500

        return jsonify({
            "message": "Conversation already exists",
            "conversation": {
                "id": str(existing["_id"]),
                "participants": participant_ids
            }
        }), 200

    return jsonify({
        "message": "Conversation created successfully",
        "conversation": {
            "id": str(result.inserted_id),
            "participants": participant_ids
        }
    }), 201
