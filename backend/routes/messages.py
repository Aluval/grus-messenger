
import os
from datetime import datetime, timezone

from bson import ObjectId
from flask import Blueprint, current_app, jsonify, request, send_file
from io import BytesIO
from gridfs.errors import NoFile
from routes.auth import token_required
from routes.connections import are_connected, is_blocked
from services.message_service import create_message

messages_bp = Blueprint("messages", __name__, url_prefix="/api/messages")

MAX_MESSAGE_LENGTH = 20000

def utc_isoformat(value):
    """Serialize MongoDB datetimes as explicit UTC timestamps."""
    if value is None:
        return None

    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    else:
        value = value.astimezone(timezone.utc)

    return value.isoformat().replace("+00:00", "Z")

def get_collection():
    return current_app.extensions["mongo_db"]["messages"]

def cleanup_unreferenced_attachment(bucket, file_id):
    """
    Delete an uploaded GridFS file only when no message references it.

    If MongoDB cannot verify the reference state, preserve the file
    rather than risk breaking an existing message.
    """
    if not isinstance(file_id, ObjectId):
        return

    try:
        reference = get_collection().find_one(
            {
                "attachment.gridfs_id": file_id,
                "deleted_for_everyone": {"$ne": True},
            },
            {"_id": 1}
        )

    except Exception:
        current_app.logger.exception(
            "Could not verify GridFS attachment references. "
            "Preserving uploaded file."
        )
        return

    if reference:
        current_app.logger.warning(
            "Preserving GridFS attachment %s because a message references it.",
            file_id
        )
        return

    try:
        bucket.delete(file_id)

    except NoFile:
        pass

    except Exception:
        current_app.logger.exception(
            "Could not clean up unreferenced GridFS attachment %s.",
            file_id
        )

def get_conversation(conversation_id):
    if not ObjectId.is_valid(conversation_id):
        return None

    return current_app.extensions["mongo_db"]["conversations"].find_one({
        "_id": ObjectId(conversation_id)
    })


def check_conversation_access(current_user, conversation):
    user_id = current_user["_id"]

    if user_id not in conversation["participants"]:
        return False

    other_user_id = next(
        (p for p in conversation["participants"] if p != user_id),
        None
    )

    if other_user_id is None:
        return False

    if is_blocked(user_id, other_user_id):
        return False

    return are_connected(user_id, other_user_id)

# --------------------------------------------------
# ENCRYPTED IMAGE ATTACHMENTS
# --------------------------------------------------

MAX_IMAGE_SIZE = 5 * 1024 * 1024
MAX_ENCRYPTED_IMAGE_SIZE = MAX_IMAGE_SIZE + 16


@messages_bp.post("/<conversation_id>/attachments")
@token_required
def upload_message_attachment(current_user, conversation_id):
    conversation = get_conversation(conversation_id)

    if not conversation:
        return jsonify({"error": "Conversation not found"}), 404

    if not check_conversation_access(current_user, conversation):
        return jsonify({"error": "Messaging is not available"}), 403

    image = request.files.get("image")
    iv = request.form.get("iv", "").strip()
    content_type = request.form.get("content_type", "").strip()

    try:
        original_size = int(request.form.get("original_size", "0"))
    except (TypeError, ValueError):
        return jsonify({"error": "Invalid original image size"}), 400

    if not image:
        return jsonify({"error": "Encrypted image is required"}), 400

    if content_type not in ("image/jpeg", "image/png", "image/webp"):
        return jsonify({"error": "Unsupported image type"}), 400

    if not 1 <= original_size <= MAX_IMAGE_SIZE:
        return jsonify({"error": "Invalid image size"}), 400

    if not iv:
        return jsonify({"error": "Encryption IV is required"}), 400

    import base64
    import binascii

    try:
        decoded_iv = base64.b64decode(iv, validate=True)
    except (ValueError, binascii.Error):
        return jsonify({"error": "Invalid encryption IV"}), 400

    if len(decoded_iv) != 12:
        return jsonify({"error": "Invalid encryption IV length"}), 400

    encrypted_data = image.read(MAX_ENCRYPTED_IMAGE_SIZE + 1)

    if not 17 <= len(encrypted_data) <= MAX_ENCRYPTED_IMAGE_SIZE:
        return jsonify({"error": "Invalid encrypted image size"}), 413

    if len(encrypted_data) != original_size + 16:
        return jsonify({"error": "Encrypted image size mismatch"}), 400

    bucket = current_app.extensions["grus_images_bucket"]
    file_id = None

    try:
        file_id = bucket.upload_from_stream(
            "grus-encrypted-image",
            BytesIO(encrypted_data),
            metadata={
                "owner_id": str(current_user["_id"]),
                "conversation_id": conversation_id,
                "image_type": "encrypted_chat_attachment",
            },
        )

        attachment = {
            "gridfs_id": file_id,
            "iv": iv,
            "content_type": content_type,
            "original_size": original_size,
        }

        message, response_data = create_message(
            sender_id=current_user["_id"],
            conversation=conversation,
            conversation_id=conversation_id,
            attachment=attachment,
        )

        return jsonify({
            "message": "Encrypted image sent",
            "data": response_data,
        }), 201

    except (ValueError, PermissionError) as error:
        cleanup_unreferenced_attachment(bucket, file_id)

        status_code = 403 if isinstance(error, PermissionError) else 400
        return jsonify({"error": str(error)}), status_code

    except Exception:
        current_app.logger.exception("Encrypted image upload failed.")

        cleanup_unreferenced_attachment(bucket, file_id)

        return jsonify({
            "error": "Could not send encrypted image."
        }), 500


@messages_bp.get("/<conversation_id>/attachments/<attachment_id>")
@token_required
def download_message_attachment(
    current_user,
    conversation_id,
    attachment_id,
):
    conversation = get_conversation(conversation_id)

    if not conversation:
        return jsonify({"error": "Conversation not found"}), 404

    if not check_conversation_access(current_user, conversation):
        return jsonify({"error": "Messaging is not available"}), 403

    if not ObjectId.is_valid(attachment_id):
        return jsonify({"error": "Invalid attachment ID"}), 400

    bucket = current_app.extensions["grus_images_bucket"]

    try:
        grid_out = bucket.open_download_stream(
            ObjectId(attachment_id)
        )

        metadata = grid_out.metadata or {}

        if (
            metadata.get("image_type") != "encrypted_chat_attachment"
            or metadata.get("conversation_id") != conversation_id
        ):
            return jsonify({"error": "Attachment not found"}), 404

        attachment_message = get_collection().find_one({
            "conversation_id": ObjectId(conversation_id),
            "attachment.gridfs_id": ObjectId(attachment_id),
            "deleted_for_everyone": {"$ne": True},
            "deleted_for": {"$ne": current_user["_id"]},
        })

        if not attachment_message:
            return jsonify({"error": "Attachment not found"}), 404

        encrypted_data = grid_out.read()

        if not 17 <= len(encrypted_data) <= MAX_ENCRYPTED_IMAGE_SIZE:
            return jsonify({"error": "Invalid attachment data"}), 400

        response = send_file(
            BytesIO(encrypted_data),
            mimetype="application/octet-stream",
            max_age=0,
        )

        response.headers["Cache-Control"] = "private, no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"

        return response

    except NoFile:
        return jsonify({"error": "Attachment not found"}), 404

    except Exception:
        current_app.logger.exception(
            "Encrypted attachment download failed."
        )

        return jsonify({
            "error": "Could not retrieve attachment."
        }), 500


@messages_bp.post("/<conversation_id>")
@token_required
def send_message(current_user, conversation_id):
    conversation = get_conversation(conversation_id)

    if not conversation:
        return jsonify({"error": "Conversation not found"}), 404

    if not check_conversation_access(current_user, conversation):
        return jsonify({"error": "Messaging is not available"}), 403

    data = request.get_json(silent=True) or {}

    encrypted_payload = data.get("encrypted_payload")
    content = data.get("content")

    allow_dev_plaintext = (
        os.getenv("GRUS_ALLOW_DEV_PLAINTEXT", "false").lower() == "true"
    )

    try:
        message, response_data = create_message(
            sender_id=current_user["_id"],
            conversation=conversation,
            conversation_id=conversation_id,
            encrypted_payload=encrypted_payload,
            content=content,
            allow_dev_plaintext=allow_dev_plaintext,
        )

    except PermissionError as error:
        return jsonify({"error": str(error)}), 403

    except ValueError as error:
        return jsonify({"error": str(error)}), 400

    return jsonify({
        "message": "Message saved",
        "data": response_data
    }), 201



# Retrieve messages
@messages_bp.get("/<conversation_id>")
@token_required
def get_messages(current_user, conversation_id):
    conversation = get_conversation(conversation_id)

    if not conversation:
        return jsonify({"error": "Conversation not found"}), 404

    if not check_conversation_access(current_user, conversation):
        return jsonify({"error": "Messaging is not available"}), 403

    results = list(
        get_collection().find(
            {
    "conversation_id": ObjectId(conversation_id),
    "deleted_for": {"$ne": current_user["_id"]},
}
        )
        .sort("created_at", -1)
        .limit(100)
    )

    # Restore chronological order for the frontend.
    results.reverse()

    messages = []

    for message in results:
        item = {
            "id": str(message["_id"]),
            "sender_id": str(message["sender_id"]),
            "created_at": utc_isoformat(message["created_at"]),
            "delivery_status": message.get("delivery_status", "sent"),
            "delivered_at": utc_isoformat(message.get("delivered_at")),
            "read_at": utc_isoformat(message.get("read_at")),
        }

        if message.get("deleted_for_everyone"):
           item["deleted_for_everyone"] = True
           item["deleted_by"] = str(message.get("deleted_by", ""))
           item["deleted_at"] = utc_isoformat(message.get("deleted_at"))
           messages.append(item)
           continue

        if isinstance(message.get("attachment"), dict):
            attachment = dict(message["attachment"])

            gridfs_id = attachment.get("gridfs_id")

            if isinstance(gridfs_id, ObjectId):
                attachment["gridfs_id"] = str(gridfs_id)

            item["attachment"] = attachment
            item["message_type"] = "image"
            item["encryption_status"] = message.get(
                "encryption_status",
                "encrypted_attachment_received"
            )

            messages.append(item)
            continue

        if "encrypted_payload" in message:
            item["encrypted_payload"] = message["encrypted_payload"]
            item["encryption_status"] = message.get(
                "encryption_status",
                "encrypted_payload_received"
            )
        else:
            item["content"] = message.get("content", "")
            item["encryption_status"] = message.get(
                "encryption_status",
                "legacy_plaintext"
            )

        messages.append(item)

    return jsonify({"messages": messages}), 200

# Mark a message as delivered by its recipient
@messages_bp.post("/<conversation_id>/<message_id>/delivered")
@token_required
def mark_message_delivered(current_user, conversation_id, message_id):
    conversation = get_conversation(conversation_id)

    if not conversation:
        return jsonify({"error": "Conversation not found"}), 404

    if not check_conversation_access(current_user, conversation):
        return jsonify({"error": "Messaging is not available"}), 403

    if not ObjectId.is_valid(message_id):
        return jsonify({"error": "Invalid message ID"}), 400

    messages = get_collection()

    message = messages.find_one({
        "_id": ObjectId(message_id),
        "conversation_id": ObjectId(conversation_id),
    })

    if not message:
        return jsonify({"error": "Message not found"}), 404

    # Only the recipient may acknowledge delivery.
    if message["sender_id"] == current_user["_id"]:
        return jsonify({"error": "Sender cannot acknowledge own delivery"}), 403

    delivered_at = datetime.now(timezone.utc)

    messages.update_one(
        {
            "_id": ObjectId(message_id),
            "delivery_status": "sent",
        },
        {
            "$set": {
                "delivery_status": "delivered",
                "delivered_at": delivered_at,
            }
        },
    )

    updated_message = messages.find_one({
        "_id": ObjectId(message_id),
    })

    response_data = {
        "message_id": message_id,
        "conversation_id": conversation_id,
        "delivery_status": updated_message.get("delivery_status", "sent"),
        "delivered_at": utc_isoformat(updated_message.get("delivered_at")),
    }

    socketio = current_app.extensions.get("socketio")

    if socketio:
        socketio.emit(
            "message_delivered",
            response_data,
            to=f"conversation:{conversation_id}",
        )

    return jsonify(response_data), 200

# Retrieve messages waiting for delivery acknowledgement
@messages_bp.get("/pending-delivery")
@token_required
def get_pending_delivery(current_user):
    messages = get_collection()

    pending_messages = messages.find({
        "delivery_status": "sent",
        "sender_id": {"$ne": current_user["_id"]},
    }).sort("created_at", 1).limit(200)

    pending = []

    for message in pending_messages:
        conversation = get_conversation(
            str(message["conversation_id"])
        )

        if not conversation:
            continue

        if not check_conversation_access(current_user, conversation):
            continue

        pending.append({
            "message_id": str(message["_id"]),
            "conversation_id": str(message["conversation_id"]),
            "sender_id": str(message["sender_id"]),
        })

    return jsonify({"pending_messages": pending}), 200



# Mark a message as read by its recipient
@messages_bp.post("/<conversation_id>/<message_id>/read")
@token_required
def mark_message_read(current_user, conversation_id, message_id):
    conversation = get_conversation(conversation_id)

    if not conversation:
        return jsonify({"error": "Conversation not found"}), 404

    if not check_conversation_access(current_user, conversation):
        return jsonify({"error": "Messaging is not available"}), 403

    if not ObjectId.is_valid(message_id):
        return jsonify({"error": "Invalid message ID"}), 400

    messages = get_collection()

    message = messages.find_one({
        "_id": ObjectId(message_id),
        "conversation_id": ObjectId(conversation_id),
    })

    if not message:
        return jsonify({"error": "Message not found"}), 404

    # Only the recipient can mark the message as read.
    if message["sender_id"] == current_user["_id"]:
        return jsonify({"error": "Sender cannot read their own message"}), 403

    # Ensure delivery is recorded before reading.
    read_at = datetime.now(timezone.utc)

    messages.update_one(
        {
            "_id": ObjectId(message_id),
            "read_at": None,
        },
        {
            "$set": {
                "delivery_status": "read",
                "read_at": read_at,
                "delivered_at": message.get("delivered_at") or read_at,
            }
        },
    )

    updated_message = messages.find_one({
        "_id": ObjectId(message_id),
    })

    response_data = {
        "message_id": message_id,
        "conversation_id": conversation_id,
        "delivery_status": updated_message.get("delivery_status", "sent"),
        "delivered_at": utc_isoformat(updated_message.get("delivered_at")),
        "read_at": utc_isoformat(updated_message.get("read_at")),
    }

    socketio = current_app.extensions.get("socketio")

    if socketio:
        socketio.emit(
            "message_read",
            response_data,
            to=f"conversation:{conversation_id}",
        )

    return jsonify(response_data), 200




# --------------------------------------------------
# BULK DELETE MESSAGES
# --------------------------------------------------

@messages_bp.delete("/<conversation_id>/bulk")
@token_required
def bulk_delete_messages(current_user, conversation_id):
    conversation = get_conversation(conversation_id)

    if not conversation:
        return jsonify({"error": "Conversation not found"}), 404

    if current_user["_id"] not in conversation["participants"]:
        return jsonify({"error": "Access denied"}), 403

    data = request.get_json(silent=True) or {}

    delete_for = data.get("delete_for")
    select_all = data.get("select_all", False)
    message_ids = data.get("message_ids", [])

    if delete_for not in ("me", "everyone"):
        return jsonify({
            "error": "delete_for must be 'me' or 'everyone'"
        }), 400

    if not isinstance(select_all, bool):
        return jsonify({
            "error": "select_all must be a boolean"
        }), 400

    conversation_oid = ObjectId(conversation_id)
    messages = get_collection()

    # --------------------------------------------------
    # FIND TARGET MESSAGES
    # --------------------------------------------------

    if select_all:
        if message_ids:
            return jsonify({
                "error": "Do not provide message_ids with select_all"
            }), 400

        target_messages = list(
            messages.find(
                {
                    "conversation_id": conversation_oid,
                    "deleted_for": {"$ne": current_user["_id"]},
                    "deleted_for_everyone": {"$ne": True},
                },
                {
                    "_id": 1,
                    "sender_id": 1,
                    "deleted_for_everyone": 1,
                    "attachment.gridfs_id": 1,
                }
            )
        )

    else:
        if (
            not isinstance(message_ids, list)
            or not message_ids
            or len(message_ids) > 500
        ):
            return jsonify({
                "error": "Select between 1 and 500 messages"
            }), 400

        if any(
            not isinstance(message_id, str)
            or not ObjectId.is_valid(message_id)
            for message_id in message_ids
        ):
            return jsonify({
                "error": "Invalid message ID"
            }), 400

        unique_ids = list(dict.fromkeys(message_ids))

        target_messages = list(
            messages.find(
                {
                    "_id": {
                        "$in": [
                            ObjectId(message_id)
                            for message_id in unique_ids
                        ]
                    },
                    "conversation_id": conversation_oid,
                    "deleted_for_everyone": {"$ne": True},
                    "deleted_for": {"$ne": current_user["_id"]},
                },
                {
                    "_id": 1,
                    "sender_id": 1,
                    "deleted_for_everyone": 1,
                    "deleted_for": 1,
                    "attachment.gridfs_id": 1,
                }
            )
        )

        if len(target_messages) != len(unique_ids):
            return jsonify({
                "error": (
                    "One or more selected messages were not found "
                    "or are unavailable"
                )
            }), 404

    if not target_messages:
        return jsonify({
            "message": "No messages to delete",
            "affected_count": 0,
            "message_ids": [],
        }), 200

    # --------------------------------------------------
    # VALIDATE DELETE FOR EVERYONE
    # --------------------------------------------------

    if delete_for == "everyone":
        for message in target_messages:

            if message.get("deleted_for_everyone"):
                return jsonify({
                    "error": (
                        "One or more messages were already "
                        "deleted for everyone"
                    )
                }), 409

            if message["sender_id"] != current_user["_id"]:
                return jsonify({
                    "error": (
                        "You can delete for everyone only "
                        "your own messages"
                    )
                }), 403

    # --------------------------------------------------
    # PERFORM ATOMIC DELETIONS
    # --------------------------------------------------

    deleted_at = (
        datetime.now(timezone.utc)
        if delete_for == "everyone"
        else None
    )

    deleted_message_ids = []
    attachment_ids = []

    for message in target_messages:

        message_oid = message["_id"]

        # ----------------------------------------------
        # DELETE FOR ME
        # ----------------------------------------------

        if delete_for == "me":

            result = messages.update_one(
                {
                    "_id": message_oid,
                    "conversation_id": conversation_oid,
                    "deleted_for": {"$ne": current_user["_id"]},
                    "deleted_for_everyone": {"$ne": True},
                },
                {
                    "$addToSet": {
                        "deleted_for": current_user["_id"]
                    }
                }
            )

        # ----------------------------------------------
        # DELETE FOR EVERYONE
        # ----------------------------------------------

        else:

            result = messages.update_one(
                {
                    "_id": message_oid,
                    "conversation_id": conversation_oid,
                    "sender_id": current_user["_id"],
                    "deleted_for_everyone": {"$ne": True},
                },
                {
                    "$set": {
                        "deleted_for_everyone": True,
                        "deleted_by": current_user["_id"],
                        "deleted_at": deleted_at,
                    },
                    "$unset": {
                        "encrypted_payload": "",
                        "content": "",
                        "attachment": "",
                    },
                }
            )

        # Only record messages actually modified by MongoDB.
        if result.modified_count != 1:
            continue

        deleted_message_ids.append(str(message_oid))

        # Collect attachments only after successful
        # Delete for Everyone operations.
        if delete_for == "everyone":

            attachment = message.get("attachment")

            if isinstance(attachment, dict):
                attachment_id = attachment.get("gridfs_id")

                if isinstance(attachment_id, ObjectId):
                    attachment_ids.append(attachment_id)

    # --------------------------------------------------
    # GRIDFS ATTACHMENT CLEANUP
    # Delete for Everyone only.
    # --------------------------------------------------

    if delete_for == "everyone" and attachment_ids:

        bucket = current_app.extensions.get("grus_images_bucket")

        if bucket:
            for attachment_id in set(attachment_ids):
                cleanup_unreferenced_attachment(
                    bucket,
                    attachment_id
                )

    # --------------------------------------------------
    # SOCKET.IO SYNCHRONIZATION
    # Emit only successfully modified message IDs.
    # --------------------------------------------------

    socketio = current_app.extensions.get("socketio")

    if socketio:
        for message_id in deleted_message_ids:

            response_data = {
                "message_id": message_id,
                "conversation_id": conversation_id,
                "delete_for": delete_for,
                "deleted_by": str(current_user["_id"]),
            }

            if delete_for == "everyone":

                response_data["deleted_at"] = utc_isoformat(
                    deleted_at
                )

                room = f"conversation:{conversation_id}"

            else:
                room = f"user:{current_user['_id']}"

            try:
                socketio.emit(
                    "message_deleted",
                    response_data,
                    to=room,
                )

            except Exception:
                current_app.logger.exception(
                    "Failed to emit bulk message deletion event: %s",
                    message_id
                )

    # --------------------------------------------------
    # RESPONSE
    # --------------------------------------------------

    return jsonify({
        "message": "Messages deleted",
        "delete_for": delete_for,
        "affected_count": len(deleted_message_ids),
        "message_ids": deleted_message_ids,
    }), 200


# --------------------------------------------------
# CLEAR CONVERSATION FOR CURRENT USER ONLY
# --------------------------------------------------

@messages_bp.delete("/<conversation_id>/clear")
@token_required
def clear_conversation(current_user, conversation_id):
    conversation = get_conversation(conversation_id)

    if not conversation:
        return jsonify({"error": "Conversation not found"}), 404

    if current_user["_id"] not in conversation["participants"]:
        return jsonify({"error": "Access denied"}), 403

    result = get_collection().update_many(
        {
            "conversation_id": ObjectId(conversation_id),
            "deleted_for": {"$ne": current_user["_id"]},
        },
        {
            "$addToSet": {
                "deleted_for": current_user["_id"]
            }
        }
    )

    response_data = {
        "conversation_id": conversation_id,
        "affected_count": result.modified_count,
    }

    socketio = current_app.extensions.get("socketio")

    if socketio:
        socketio.emit(
            "conversation_cleared",
            response_data,
            to=f"user:{current_user['_id']}",
        )

    return jsonify({
        "message": "Conversation cleared for your account",
        "data": response_data,
    }), 200


# Delete an individual message
@messages_bp.delete("/<conversation_id>/<message_id>")
@token_required
def delete_message(current_user, conversation_id, message_id):
    conversation = get_conversation(conversation_id)

    if not conversation:
        return jsonify({"error": "Conversation not found"}), 404

    if current_user["_id"] not in conversation["participants"]:
        return jsonify({"error": "Access denied"}), 403

    if not ObjectId.is_valid(message_id):
        return jsonify({"error": "Invalid message ID"}), 400

    data = request.get_json(silent=True) or {}
    delete_for = data.get("delete_for")

    if delete_for not in ("me", "everyone"):
        return jsonify({
            "error": "delete_for must be 'me' or 'everyone'"
        }), 400

    messages = get_collection()

    message_object_id = ObjectId(message_id)
    conversation_object_id = ObjectId(conversation_id)

    message = messages.find_one({
        "_id": message_object_id,
        "conversation_id": conversation_object_id,
    })

    if not message:
        return jsonify({"error": "Message not found"}), 404

    if message.get("deleted_for_everyone"):
        return jsonify({"error": "Message was already deleted"}), 404

    response_data = {
        "message_id": message_id,
        "conversation_id": conversation_id,
        "delete_for": delete_for,
        "deleted_by": str(current_user["_id"]),
    }

    if delete_for == "me":

        result = messages.update_one(
            {
                "_id": message_object_id,
                "conversation_id": conversation_object_id,
                "deleted_for_everyone": {"$ne": True},
                "deleted_for": {"$ne": current_user["_id"]},
            },
            {
                "$addToSet": {
                    "deleted_for": current_user["_id"]
                }
            }
        )

        if result.modified_count != 1:
            return jsonify({
                "error": "Message could not be deleted."
            }), 409

    else:
        # Only the original sender can delete for everyone.
        if message["sender_id"] != current_user["_id"]:
            return jsonify({
                "error": "Only the sender can delete for everyone"
            }), 403

        deleted_at = datetime.now(timezone.utc)

        # Preserve the attachment ID before removing its reference.
        attachment = message.get("attachment")
        attachment_id = (
            attachment.get("gridfs_id")
            if isinstance(attachment, dict)
            else None
        )

        result = messages.update_one(
            {
                "_id": message_object_id,
                "conversation_id": conversation_object_id,
                "sender_id": current_user["_id"],
                "deleted_for_everyone": {"$ne": True},
            },
            {
                "$set": {
                    "deleted_for_everyone": True,
                    "deleted_by": current_user["_id"],
                    "deleted_at": deleted_at,
                },
                "$unset": {
                    "encrypted_payload": "",
                    "content": "",
                    "attachment": "",
                },
            },
        )

        if result.modified_count != 1:
            return jsonify({
                "error": "Message could not be deleted. It may already have been deleted."
            }), 409

        response_data["deleted_at"] = utc_isoformat(deleted_at)

        # Clean up only after the database deletion succeeds.
        if isinstance(attachment_id, ObjectId):
            bucket = current_app.extensions["grus_images_bucket"]

            cleanup_unreferenced_attachment(
                bucket,
                attachment_id
            )

    socketio = current_app.extensions.get("socketio")

    if socketio:
        if delete_for == "everyone":
            socketio.emit(
                "message_deleted",
                response_data,
                to=f"conversation:{conversation_id}",
            )
        else:
            socketio.emit(
                "message_deleted",
                response_data,
                to=f"user:{current_user['_id']}",
            )

    return jsonify({
        "message": "Message deleted",
        "data": response_data,
    }), 200
