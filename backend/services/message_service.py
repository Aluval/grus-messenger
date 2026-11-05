import base64
import binascii

from datetime import datetime, timezone

from bson import ObjectId
from flask import current_app

MAX_ENCRYPTED_PAYLOAD_LENGTH = 20000
MAX_PLAINTEXT_LENGTH = 5000


def utc_isoformat(value):
    """Convert a datetime into an explicit UTC ISO timestamp."""
    if value is None:
        return None

    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    else:
        value = value.astimezone(timezone.utc)

    return value.isoformat().replace("+00:00", "Z")


def get_database():
    return current_app.extensions["mongo_db"]

def safe_socket_emit(event, data, room):
    """
    Send a Socket.IO event without allowing notification failures
    to invalidate an already-persisted message.
    """
    socketio = current_app.extensions.get("socketio")

    if not socketio:
        return False

    try:
        socketio.emit(
            event,
            data,
            to=room,
        )
        return True

    except Exception:
        current_app.logger.exception(
            "Socket.IO notification failed: %s",
            event,
        )
        return False

def serialize_message(message):
    """Create the common API and Socket.IO message representation."""
    result = {
        "id": str(message["_id"]),
        "conversation_id": str(message["conversation_id"]),
        "sender_id": str(message["sender_id"]),
        "created_at": utc_isoformat(message["created_at"]),
        "delivery_status": message.get("delivery_status", "sent"),
        "delivered_at": utc_isoformat(message.get("delivered_at")),
        "read_at": utc_isoformat(message.get("read_at")),
        "encryption_status": message.get(
            "encryption_status",
            "encrypted_payload_received"
        ),
    }

    if "encrypted_payload" in message:
        result["encrypted_payload"] = message["encrypted_payload"]

    if "content" in message:
        result["content"] = message["content"]

    if "attachment" in message:
        attachment = dict(message["attachment"])

        if isinstance(attachment.get("gridfs_id"), ObjectId):
            attachment["gridfs_id"] = str(attachment["gridfs_id"])

        result["attachment"] = attachment

    return result



def create_message(
    sender_id,
    conversation,
    conversation_id,
    encrypted_payload=None,
    content=None,
    allow_dev_plaintext=False,
    attachment=None,
):
    """
    Validate, persist and broadcast one message.

    Conversation authorization must be completed by the caller.

    Once MongoDB successfully inserts the message, failures in
    conversation metadata updates or Socket.IO notifications
    must not invalidate the saved message.
    """

    if not isinstance(sender_id, ObjectId):
        raise ValueError("Invalid sender identity.")

    if not ObjectId.is_valid(conversation_id):
        raise ValueError("Invalid conversation ID.")

    conversation_object_id = ObjectId(conversation_id)

    if conversation["_id"] != conversation_object_id:
        raise ValueError("Conversation ID mismatch.")

    if sender_id not in conversation.get("participants", []):
        raise PermissionError("Sender is not a conversation participant.")

    message = {
        "conversation_id": conversation_object_id,
        "sender_id": sender_id,
        "created_at": datetime.now(timezone.utc),
        "delivery_status": "sent",
        "delivered_at": None,
        "read_at": None,
    }

    if isinstance(encrypted_payload, str) and encrypted_payload.strip():
        encrypted_payload = encrypted_payload.strip()

        if len(encrypted_payload) > MAX_ENCRYPTED_PAYLOAD_LENGTH:
            raise ValueError("Message payload is too large.")

        message["encrypted_payload"] = encrypted_payload
        message["encryption_status"] = "encrypted_payload_received"

    elif isinstance(attachment, dict):
        gridfs_id = attachment.get("gridfs_id")
        iv = attachment.get("iv")
        content_type = attachment.get("content_type")
        original_size = attachment.get("original_size")

        if not isinstance(gridfs_id, ObjectId):
            raise ValueError("Invalid attachment storage ID.")

        if not isinstance(iv, str):
            raise ValueError("Invalid attachment encryption IV.")

        try:
            decoded_iv = base64.b64decode(iv, validate=True)
        except (ValueError, binascii.Error):
            raise ValueError("Invalid attachment encryption IV.")

        if len(decoded_iv) != 12:
            raise ValueError("Invalid attachment encryption IV length.")

        if content_type not in (
            "image/jpeg",
            "image/png",
            "image/webp",
        ):
            raise ValueError("Unsupported image type.")

        if (
            not isinstance(original_size, int)
            or isinstance(original_size, bool)
            or not 1 <= original_size <= 5 * 1024 * 1024
        ):
            raise ValueError("Invalid attachment size.")

        message["attachment"] = {
            "gridfs_id": gridfs_id,
            "version": 1,
            "algorithm": "AES-256-GCM",
            "iv": iv,
            "content_type": content_type,
            "original_size": original_size,
        }

        message["encryption_status"] = "encrypted_attachment_received"

    elif isinstance(content, str) and content.strip():
        if not allow_dev_plaintext:
            raise PermissionError("Plaintext messaging is disabled.")

        content = content.strip()

        if len(content) > MAX_PLAINTEXT_LENGTH:
            raise ValueError("Message is too long.")

        message["content"] = content
        message["encryption_status"] = "development_plaintext"

    else:
        raise ValueError("Encrypted message payload is required.")

    database = get_database()

    # Persist the message first. This is the primary operation.
    insert_result = database["messages"].insert_one(message)
    message["_id"] = insert_result.inserted_id

    # Build the response from the persisted message.
    response_data = serialize_message(message)

    # Update conversation metadata independently.
    # $max prevents an older concurrent message from moving
    # last_message_at backwards.
    try:
        database["conversations"].update_one(
            {
                "_id": conversation_object_id,
                "participants": sender_id,
            },
            {
                "$max": {
                    "last_message_at": message["created_at"]
                }
            }
        )

    except Exception:
        current_app.logger.exception(
            "Message saved, but conversation timestamp update failed."
        )

    # Notifications are secondary to successful persistence.
    conversation_room = f"conversation:{conversation_id}"

    safe_socket_emit(
        "new_message",
        response_data,
        conversation_room,
    )

    recipient_id = next(
        (
            participant
            for participant in conversation["participants"]
            if participant != sender_id
        ),
        None,
    )

    if recipient_id:
        notification_data = {
            "message_id": str(insert_result.inserted_id),
            "conversation_id": conversation_id,
            "sender_id": str(sender_id),
            "created_at": response_data["created_at"],
        }

        safe_socket_emit(
            "message_notification",
            notification_data,
            f"user:{recipient_id}",
        )

    return message, response_data

