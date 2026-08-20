import os, base64, time
import numpy as np
import cv2
import requests
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from ultralytics import YOLO

# ─────────────────────────────────────────────
# Load External YOLO Model
# ─────────────────────────────────────────────

MODEL_PATH = "best.pt"

print(f"[server] Loading YOLO model from: {MODEL_PATH}")
model = YOLO(MODEL_PATH)
CLASS_NAMES = model.names
print(f"[server] Model loaded ✓  Classes: {CLASS_NAMES}")

# ─────────────────────────────────────────────
# Ollama LLM Configuration
# ─────────────────────────────────────────────

OLLAMA_URL = "http://localhost:11434/api/generate"
OLLAMA_MODEL = "microplastic-expert:latest"

# ─────────────────────────────────────────────
# Flask App
# ─────────────────────────────────────────────

app = Flask(__name__, static_folder="dist")
CORS(app, resources={r"/*": {"origins": "*"}})

@app.route("/")
def index():
    return send_from_directory("dist", "index.html")

@app.route("/<path:path>")
def static_files(path):
    return send_from_directory("dist", path)

# ─────────────────────────────────────────────
# YOLO Detection Endpoint
# ─────────────────────────────────────────────

@app.route("/detect", methods=["POST"])
def detect():
    data = request.get_json(silent=True)
    if not data or "image" not in data:
        return jsonify({"error": "No image provided"}), 400

    try:
        img_bytes = base64.b64decode(data["image"])
        nparr = np.frombuffer(img_bytes, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    except Exception as e:
        return jsonify({"error": f"Image decode failed: {e}"}), 400

    t0 = time.perf_counter()
    results = model(img, conf=0.25, verbose=False)
    inference_ms = round((time.perf_counter() - t0) * 1000, 1)

    h_img, w_img = img.shape[:2]
    detections = []

    for r in results:
        for box in r.boxes:
            x1, y1, x2, y2 = box.xyxy[0].tolist()
            cls_id = int(box.cls[0])

            detections.append({
                "x1": x1 / w_img,
                "y1": y1 / h_img,
                "x2": x2 / w_img,
                "y2": y2 / h_img,
                "confidence": round(float(box.conf[0]), 4),
                "class_name": CLASS_NAMES.get(cls_id, f"class_{cls_id}"),
                "class_id": cls_id
            })

    return jsonify({
        "detections": detections,
        "inference_ms": inference_ms,
        "class_names": CLASS_NAMES
    })

# ─────────────────────────────────────────────
# Model Info Endpoint
# ─────────────────────────────────────────────

@app.route("/model-info", methods=["GET"])
def model_info():
    return jsonify({
        "model_name": "YOLOv8-nano (Microplastics)",
        "classes": CLASS_NAMES,
        "path": MODEL_PATH,
        "status": "loaded"
    })

# ─────────────────────────────────────────────
# LLM Chat Endpoint (Ollama)
# ─────────────────────────────────────────────

@app.route("/chat", methods=["POST"])
def chat():
    data = request.get_json(silent=True)

    if not data or "message" not in data:
        return jsonify({"error": "No message provided"}), 400

    user_message = data["message"]

    try:
        response = requests.post(
            OLLAMA_URL,
            json={
                "model": OLLAMA_MODEL,
                "prompt": f"""
You are a Microplastic Research Assistant.
Provide scientific and clear answers related to microplastics, contamination levels, detection methods, and environmental impact.

User Question:
{user_message}
""",
                "stream": False
            }
        )

        if response.status_code != 200:
            return jsonify({"error": "LLM failed"}), 500

        result = response.json()

        return jsonify({
            "response": result.get("response", "")
        })

    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ─────────────────────────────────────────────
# Run Server
# ─────────────────────────────────────────────

if __name__ == "__main__":
    print("[server] Starting on http://localhost:5000")
    app.run(host="0.0.0.0", port=5000, debug=False)
