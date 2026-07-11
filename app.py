"""
app.py — Backend server for the Image Compressor web app.

Framework: Flask
Image processing: Pillow (PIL)

What this file does, at a high level:
1.  Serves the frontend (index.html, style.css, script.js).
2.  Exposes a POST /compress endpoint that:
      - Receives an uploaded image + a "quality" value from the browser.
      - Validates the file (type + size).
      - Uses Pillow to open, compress, and re-save the image in memory.
      - Sends back the compressed image as a base64 string (for instant
        preview) plus the original/compressed file sizes.
3.  Exposes a GET /download/<filename> endpoint that lets the user download
    the final compressed file from the server's temporary storage.
"""

import os
import io
import uuid
import base64

from flask import Flask, request, jsonify, render_template, send_from_directory
from PIL import Image, UnidentifiedImageError

# ----------------------------------------------------------------------------
# App configuration
# ----------------------------------------------------------------------------
app = Flask(__name__)

# Folder where we temporarily store compressed images so they can be
# downloaded later via a normal URL (GET /download/<filename>).
COMPRESSED_FOLDER = os.path.join(os.path.dirname(__file__), "compressed")
os.makedirs(COMPRESSED_FOLDER, exist_ok=True)

# Only allow these image types. Anything else gets rejected before we even
# try to open it with Pillow.
ALLOWED_EXTENSIONS = {"png", "jpg", "jpeg", "webp", "bmp", "gif", "tiff"}

# Hard cap on upload size (in bytes) to avoid someone trying to crash the
# server with a huge file. Flask enforces this automatically and raises a
# 413 error if exceeded (handled below).
app.config["MAX_CONTENT_LENGTH"] = 20 * 1024 * 1024  # 20 MB


def allowed_file(filename: str) -> bool:
    """
    Checks that the uploaded filename has one of our allowed image
    extensions. We check the extension in addition to trying to open the
    file with Pillow, as a first, cheap line of defense.
    """
    return (
        "." in filename
        and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS
    )


# ----------------------------------------------------------------------------
# Route: Homepage
# ----------------------------------------------------------------------------
@app.route("/")
def index():
    """Renders the single-page frontend (templates/index.html)."""
    return render_template("index.html")


# ----------------------------------------------------------------------------
# Route: Compress image
# ----------------------------------------------------------------------------
@app.route("/compress", methods=["POST"])
def compress_image():
    """
    Main compression endpoint.

    Expects a multipart/form-data POST request containing:
      - "image":   the image file itself
      - "quality": an integer from 1-100 (compression quality)

    Returns JSON:
      {
        "success": true,
        "original_size": <bytes>,
        "compressed_size": <bytes>,
        "preview": "data:image/jpeg;base64,....",   # for instant <img> preview
        "download_url": "/download/<generated_filename>",
        "filename": "<generated_filename>"
      }

    On failure, returns JSON with "success": false and an "error" message,
    along with an appropriate HTTP status code.
    """

    # --- Step 1: Validate that a file was actually sent -------------------
    if "image" not in request.files:
        return jsonify({"success": False, "error": "No image file was uploaded."}), 400

    file = request.files["image"]

    if file.filename == "":
        return jsonify({"success": False, "error": "No file selected."}), 400

    if not allowed_file(file.filename):
        return jsonify({
            "success": False,
            "error": "Unsupported file type. Please upload a PNG, JPG, WEBP, BMP, GIF, or TIFF image."
        }), 400

    # --- Step 2: Validate & parse the quality slider value -----------------
    # request.form holds regular text fields sent alongside the file.
    try:
        quality = int(request.form.get("quality", 80))
        # Clamp quality to Pillow's valid range (1-95 is the practical
        # useful range for JPEG; values above ~95 barely reduce size).
        quality = max(1, min(quality, 100))
    except ValueError:
        return jsonify({"success": False, "error": "Invalid quality value."}), 400

    # --- Step 3: Read the raw bytes of the uploaded file --------------------
    # file.read() reads the entire uploaded file into memory as raw bytes.
    original_bytes = file.read()
    original_size = len(original_bytes)

    if original_size == 0:
        return jsonify({"success": False, "error": "Uploaded file is empty."}), 400

    # --- Step 4: Open the image with Pillow ---------------------------------
    try:
        # io.BytesIO wraps the raw bytes so Pillow can treat them like a file
        # on disk, without us ever writing the original upload to disk.
        input_buffer = io.BytesIO(original_bytes)
        img = Image.open(input_buffer)

        # img.load() forces Pillow to fully read/decode the pixel data now.
        # Without this, corrupted files might not raise an error until later,
        # deeper in processing (which is harder to catch cleanly).
        img.load()
    except UnidentifiedImageError:
        return jsonify({
            "success": False,
            "error": "The file could not be read as a valid image. It may be corrupted."
        }), 400

    # --- Step 5: Normalize color mode for JPEG compatibility ----------------
    # JPEG does not support transparency (alpha channels) or palette-based
    # images (mode "P", used by some PNGs/GIFs). If we tried to save an RGBA
    # or "P" image directly as JPEG, Pillow would raise an error.
    # So: if the image has transparency, we flatten it onto a white
    # background first. Otherwise we just convert straight to RGB.
    if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
        # Create a plain white canvas the same size as the image...
        background = Image.new("RGB", img.size, (255, 255, 255))
        # ...convert the source image to RGBA so we can use its alpha
        # channel as a mask, then paste it onto the white background.
        rgba_img = img.convert("RGBA")
        background.paste(rgba_img, mask=rgba_img.split()[3])  # index 3 = alpha channel
        img = background
    else:
        img = img.convert("RGB")

    # --- Step 6: Compress and save into an in-memory buffer -----------------
    # Instead of writing to a temp file on disk (slower, needs cleanup), we
    # save directly into a BytesIO buffer that lives in RAM.
    output_buffer = io.BytesIO()
    img.save(
        output_buffer,
        format="JPEG",     # We standardize output to JPEG since it has the
                            # best quality-to-size ratio for lossy compression
                            # and directly exposes a "quality" parameter.
        quality=quality,    # 1 (smallest/worst) to 100 (largest/best).
        optimize=True,      # Tells Pillow's JPEG encoder to do an extra pass
                            # to choose more efficient Huffman tables —
                            # slightly slower, but produces smaller files
                            # at the same visual quality.
    )
    compressed_bytes = output_buffer.getvalue()
    compressed_size = len(compressed_bytes)

    # --- Step 7: Save the compressed file to disk so it can be downloaded ---
    # We generate a random, unique filename (uuid4) so multiple users'
    # uploads never collide or overwrite each other.
    output_filename = f"{uuid.uuid4().hex}.jpg"
    output_path = os.path.join(COMPRESSED_FOLDER, output_filename)
    with open(output_path, "wb") as f:
        f.write(compressed_bytes)

    # --- Step 8: Base64-encode the compressed image for instant preview -----
    # We send the compressed image straight back in the JSON response as a
    # base64 data URL, so the browser can display the "after" preview
    # immediately without needing a second network round-trip.
    encoded_preview = base64.b64encode(compressed_bytes).decode("utf-8")
    preview_data_url = f"data:image/jpeg;base64,{encoded_preview}"

    return jsonify({
        "success": True,
        "original_size": original_size,
        "compressed_size": compressed_size,
        "preview": preview_data_url,
        "download_url": f"/download/{output_filename}",
        "filename": output_filename,
    })


# ----------------------------------------------------------------------------
# Route: Download compressed file
# ----------------------------------------------------------------------------
@app.route("/download/<filename>")
def download_file(filename):
    """
    Serves a previously compressed file from the COMPRESSED_FOLDER so the
    user's browser downloads it. `as_attachment=True` forces a download
    dialog instead of trying to render the image inline in the browser tab.
    """
    return send_from_directory(COMPRESSED_FOLDER, filename, as_attachment=True)


# ----------------------------------------------------------------------------
# Error handler: file too large (triggered by MAX_CONTENT_LENGTH above)
# ----------------------------------------------------------------------------
@app.errorhandler(413)
def file_too_large(e):
    return jsonify({
        "success": False,
        "error": "File is too large. Maximum upload size is 20 MB."
    }), 413


# ----------------------------------------------------------------------------
# Generic error handler for anything unexpected, so the frontend always
# receives valid JSON (rather than an HTML error page it can't parse).
# ----------------------------------------------------------------------------
@app.errorhandler(500)
def server_error(e):
    return jsonify({
        "success": False,
        "error": "Something went wrong on the server while processing your image."
    }), 500


if __name__ == "__main__":
    # debug=True gives helpful auto-reload + error pages during local
    # development. Turn this off in production.
    app.run(debug=True, port=5000)
