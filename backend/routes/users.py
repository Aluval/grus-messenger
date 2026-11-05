
from flask import Blueprint, jsonify, request
from routes.auth import token_required, get_users
from flask import current_app
from bson import ObjectId
from gridfs.errors import NoFile
from io import BytesIO
from flask import send_file
from routes.connections import are_connected, is_blocked

users_bp = Blueprint("users", __name__, url_prefix="/api/users")


@users_bp.get("/search")
@token_required
def search_users(current_user):
    query = request.args.get("q", "").strip().lower()

    if len(query) < 3:
        return jsonify({
            "error": "Enter at least 3 characters to search"
        }), 400

    users = get_users()

    results = users.find(
        {
            "username": {
                "$regex": "^" + query,
                "$options": "i"
            },
            "_id": {"$ne": current_user["_id"]}
        },
        {
            "username": 1
        }
    ).limit(20)

    return jsonify({
        "users": [
            {
                "id": str(user["_id"]),
                "username": user["username"]
            }
            for user in results
        ]
    }), 200


@users_bp.post("/profile-picture")
@token_required
def upload_profile_picture(current_user):
    image = request.files.get("image")

    if not image:
        return jsonify({"error": "Select an image first."}), 400

    MAX_PROFILE_PICTURE_SIZE = 5 * 1024 * 1024  # 5 MB

    image_data = image.read(MAX_PROFILE_PICTURE_SIZE + 1)

    if not image_data:
       return jsonify({"error": "The image is empty."}), 400

    if len(image_data) > MAX_PROFILE_PICTURE_SIZE:
       return jsonify({
        "error": "Profile picture must be 5 MB or smaller."
    }), 413

    # Validate actual file signatures, not only the supplied MIME type.
    if image_data.startswith(b"\xff\xd8\xff"):
        content_type = "image/jpeg"
    elif image_data.startswith(b"\x89PNG\r\n\x1a\n"):
        content_type = "image/png"
    elif (
        image_data.startswith(b"RIFF")
        and image_data[8:12] == b"WEBP"
    ):
        content_type = "image/webp"
    else:
        return jsonify({
            "error": "Only valid JPEG, PNG and WebP images are supported."
        }), 400

    db = current_app.extensions["mongo_db"]
    bucket = current_app.extensions["grus_images_bucket"]

    try:
        file_id = bucket.upload_from_stream(
            "profile-picture",
            BytesIO(image_data),
            metadata={
                "owner_id": str(current_user["_id"]),
                "image_type": "profile_picture",
                "content_type": content_type,
            },
        )

        # Replace the old picture only after the new upload succeeds.
        old_file_id = current_user.get("profile_picture_id")

        db["users"].update_one(
            {"_id": current_user["_id"]},
            {"$set": {"profile_picture_id": file_id}},
        )

        if old_file_id:
            try:
                bucket.delete(
                    old_file_id
                    if isinstance(old_file_id, ObjectId)
                    else ObjectId(old_file_id)
                )
            except (NoFile, Exception):
                pass

        return jsonify({
            "message": "Profile picture uploaded successfully.",
            "profile_picture_id": str(file_id),
        }), 201

    except Exception:
        current_app.logger.exception("Profile picture upload failed.")
        return jsonify({
            "error": "Could not upload the profile picture."
        }), 500


@users_bp.get("/profile-picture/<user_id>")
@token_required
def get_profile_picture(current_user, user_id):
    if not ObjectId.is_valid(user_id):
        return jsonify({"error": "Invalid user ID."}), 400

    db = current_app.extensions["mongo_db"]
    bucket = current_app.extensions["grus_images_bucket"]

    owner = db["users"].find_one({"_id": ObjectId(user_id)})

    if not owner or not owner.get("profile_picture_id"):
        return jsonify({"error": "Profile picture not found."}), 404

    viewer_id = str(current_user["_id"])
    owner_id = str(owner["_id"])

    # The owner can always view their own picture.
    if viewer_id != owner_id:
        # A block in either direction prevents access.
        if is_blocked(viewer_id, owner_id):
            return jsonify({"error": "Profile picture unavailable."}), 403

        visibility = owner.get(
            "profile_picture_visibility",
            "friends"
        )

        if visibility == "nobody":
            return jsonify({"error": "Profile picture unavailable."}), 403

        if visibility == "friends":
            if not are_connected(viewer_id, owner_id):
                return jsonify({"error": "Profile picture unavailable."}), 403

        elif visibility != "everyone":
            return jsonify({"error": "Profile picture unavailable."}), 403

    try:
        file_id = owner["profile_picture_id"]

        if not isinstance(file_id, ObjectId):
            file_id = ObjectId(file_id)

        grid_out = bucket.open_download_stream(file_id)
        image_data = grid_out.read()
        content_type = (
            grid_out.metadata.get("content_type", "application/octet-stream")
            if grid_out.metadata else "application/octet-stream"
        )

        response = send_file(
            BytesIO(image_data),
            mimetype=content_type,
            max_age=0
        )
        response.headers["Cache-Control"] = "private, no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"

        return response

    except NoFile:
        return jsonify({"error": "Profile picture not found."}), 404
    except Exception:
        current_app.logger.exception("Profile picture retrieval failed.")
        return jsonify({"error": "Could not retrieve profile picture."}), 500


@users_bp.patch("/profile-picture/privacy")
@token_required
def update_profile_picture_privacy(current_user):
    data = request.get_json(silent=True) or {}
    visibility = data.get("visibility")

    allowed_values = {"everyone", "friends", "nobody"}

    if visibility not in allowed_values:
        return jsonify({
            "error": "Visibility must be everyone, friends, or nobody."
        }), 400

    db = current_app.extensions["mongo_db"]

    db["users"].update_one(
        {"_id": current_user["_id"]},
        {"$set": {"profile_picture_visibility": visibility}}
    )

    return jsonify({
        "message": "Profile picture privacy updated.",
        "visibility": visibility
    }), 200


@users_bp.delete("/profile-picture")
@token_required
def remove_profile_picture(current_user):
    db = current_app.extensions["mongo_db"]
    bucket = current_app.extensions["grus_images_bucket"]

    owner = db["users"].find_one(
        {"_id": current_user["_id"]},
        {"profile_picture_id": 1}
    )

    if not owner or not owner.get("profile_picture_id"):
        return jsonify({
            "error": "You do not have a profile picture."
        }), 404

    file_id = owner["profile_picture_id"]

    # Remove the reference first so the picture is no longer accessible.
    db["users"].update_one(
        {"_id": current_user["_id"]},
        {"$unset": {"profile_picture_id": ""}}
    )

    try:
        if not isinstance(file_id, ObjectId):
            file_id = ObjectId(file_id)

        bucket.delete(file_id)
    except NoFile:
        current_app.logger.warning(
            "Profile picture reference existed but GridFS file was missing."
        )
    except Exception:
        current_app.logger.exception(
            "Could not delete old profile picture from GridFS."
        )

    return jsonify({
        "message": "Profile picture removed successfully."
    }), 200

@users_bp.get("/profile-picture/settings")
@token_required
def get_profile_picture_settings(current_user):
    db = current_app.extensions["mongo_db"]

    owner = db["users"].find_one(
        {"_id": current_user["_id"]},
        {
            "profile_picture_id": 1,
            "profile_picture_visibility": 1,
        }
    )

    if not owner:
        return jsonify({"error": "User not found."}), 404

    return jsonify({
        "has_picture": bool(owner.get("profile_picture_id")),
        "visibility": owner.get(
            "profile_picture_visibility",
            "friends"
        ),
    }), 200