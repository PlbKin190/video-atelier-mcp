#!/usr/bin/env python3
"""JSON stdin -> JSON stdout. No shell, no machine-specific path.

Port of screen_composite_sam2.py:124-134,218-241,271-336:
HF video predictor, point prompts, forward propagation, erosion/Gaussian alpha,
mask-derived rotated rectangle and homography. Changes: all frames (no temporal
subsampling), max dimension 720, explicit prompts (no YOLO), CPU default, no audio.
A still image is a one-frame video: no unverified SAM2 image predictor API.
`propagate` samples foreground/background points from the supplied initial mask;
it is prompt-based propagation, NOT exact mask conditioning (the latter API was
not established in the source). `inpaint` is spatial OpenCV Telea, not generative.
The patched SAM2 distribution must be supplied separately by the sam2 profile.
"""
from __future__ import annotations

import contextlib
import json
import math
import os
from pathlib import Path
import shutil
import sys
import tempfile

MODEL_ID = "facebook/sam2-hiera-small"
COMMANDS = {"segment-image", "segment-video", "track", "propagate", "refine", "screen-replace", "inpaint"}
HELP = ("SAM2 unavailable: use the sam2 Docker profile "
        "(docker compose --profile sam2 up), with the dependencies and a "
        "compatible patched SAM2 distribution. Its source has yet to be identified.")


class RequestError(Exception):
    pass


class Unavailable(Exception):
    pass


def work_root() -> Path:
    root = Path(os.environ.get("ATELIER_WORK_DIR", "/work")).resolve()
    root.mkdir(parents=True, exist_ok=True)
    return root


def inside(root: Path, candidate: Path) -> Path:
    candidate = candidate.resolve()
    if not candidate.is_relative_to(root) or candidate == root:
        raise RequestError("Paths outside the work directory and the work directory itself are not allowed.")
    return candidate


def input_path(root: Path, value) -> Path:
    if not isinstance(value, str) or not value or Path(value).is_absolute() or "\0" in value:
        raise RequestError("A relative file path is required.")
    result = inside(root, root / value)
    if not result.is_file():
        raise RequestError("The input file is missing or is not a regular file in ATELIER_WORK_DIR.")
    return result


def output_path(root: Path, value) -> Path:
    if not isinstance(value, str) or not value or Path(value).is_absolute() or "\0" in value:
        raise RequestError("A relative output path is required.")
    raw = root / value
    # lexists detects dangling links as well; no destructive overwrite.
    if os.path.lexists(raw):
        raise RequestError("The destination already exists: overwriting is not allowed.")
    result = inside(root, raw)
    result.parent.mkdir(parents=True, exist_ok=True)
    inside(root, result.parent) if result.parent != root else None
    return result


def integer(value, low: int, high: int, name: str) -> int:
    if type(value) is not int or not low <= value <= high:
        raise RequestError(f"{name}: an integer between {low} and {high} is required.")
    return value


def refine_mask(mask_raw, erosion: int, blur: int):
    # Port source:271-285. Input 0..1, output 0..1 (not 0..255).
    kernel = np.ones((3, 3), np.uint8)
    eroded = cv2.erode(mask_raw.astype(np.float32), kernel, iterations=erosion)
    feather_px = (blur - 1) / 2
    alpha = cv2.GaussianBlur(eroded, (blur, blur), sigmaX=max(0.5, feather_px / 3.0))
    return np.clip(alpha, 0.0, 1.0)


def read_image(file: Path, grayscale=False):
    image = cv2.imread(str(file), cv2.IMREAD_GRAYSCALE if grayscale else cv2.IMREAD_COLOR)
    if image is None:
        raise RequestError("Cannot read the image or mask.")
    return image


def write_image(file: Path, image):
    if not cv2.imwrite(str(file), image):
        raise RequestError("Cannot write the output image.")


def extract_frames(source: Path, directory: Path, single: bool):
    directory.mkdir()
    count = 0
    width = height = small_w = small_h = 0
    fps = 1.0
    cap = None
    if single:
        frame = read_image(source)
    else:
        cap = cv2.VideoCapture(str(source))
        if not cap.isOpened():
            cap.release()
            raise RequestError("OpenCV cannot read the video.")
        fps = float(cap.get(cv2.CAP_PROP_FPS))
        if not math.isfinite(fps) or fps <= 0:
            cap.release()
            raise RequestError("The video frame rate is missing or invalid.")
        ok, frame = cap.read()
        if not ok:
            cap.release()
            raise RequestError("The video contains no decodable frames.")
    try:
        while frame is not None:
            h, w = frame.shape[:2]
            if count == 0:
                width, height = w, h
                scale = min(1.0, 720 / max(w, h))
                small_w = max(2, int(w * scale) & ~1)
                small_h = max(2, int(h * scale) & ~1)
            elif (w, h) != (width, height):
                raise RequestError("Variable video dimensions are not supported.")
            write_image(directory / f"{count:05d}.jpg", cv2.resize(frame, (small_w, small_h)))
            count += 1
            if single:
                break
            ok, frame = cap.read()
            if not ok:
                break
    finally:
        if cap is not None:
            cap.release()
    return fps, width, height, small_w, small_h, count


def validate_points(value, width: int, height: int):
    try:
        points = np.asarray(value, dtype=np.float32)
    except (TypeError, ValueError):
        raise RequestError("Numeric [x,y] points are required.") from None
    if points.ndim != 2 or points.shape[1] != 2 or not 1 <= len(points) <= 256:
        raise RequestError("Between 1 and 256 [x,y] points are required.")
    if not np.isfinite(points).all() or (points < 0).any() or (points[:, 0] >= width).any() or (points[:, 1] >= height).any():
        raise RequestError("Points are outside the image or have non-finite coordinates.")
    return points


def mask_prompts(mask):
    # No add_new_mask API assumed: use only measured add_new_points_or_box.
    # Interior points spaced by iterative distance-transform maxima.
    points, labels = [], []
    foreground = mask > 127
    if not foreground.any():
        raise RequestError("The initial mask is empty.")
    for label, region in ((1, foreground), (0, ~foreground)):
        distance = cv2.distanceTransform(region.astype(np.uint8), cv2.DIST_L2, 5)
        for _ in range(8):
            _, maximum, _, location = cv2.minMaxLoc(distance)
            if maximum <= 0:
                break
            x, y = location
            points.append([x, y])
            labels.append(label)
            cv2.circle(distance, (x, y), max(4, int(maximum)), 0, -1)
    return np.asarray(points, dtype=np.float32), np.asarray(labels, dtype=np.int32)


def load_predictor():
    try:
        from sam2.build_sam import build_sam2_video_predictor_hf
    except (ImportError, OSError):
        raise Unavailable(HELP) from None
    device = os.environ.get("ATELIER_SAM2_DEVICE", "cpu")
    if device not in {"cpu", "cuda", "mps"}:
        raise RequestError("ATELIER_SAM2_DEVICE: cpu, cuda or mps is required.")
    try:
        predictor = build_sam2_video_predictor_hf(MODEL_ID, device=device)
    except (ImportError, AttributeError, TypeError):
        raise Unavailable(HELP) from None
    except Exception:
        raise RequestError("Cannot load the SAM2 model: check network access on first use, disk space, the models cache and sam2 profile compatibility.") from None
    for name in ("init_state", "reset_state", "add_new_points_or_box", "propagate_in_video"):
        if not callable(getattr(predictor, name, None)):
            raise Unavailable(HELP)
    return predictor


def propagated_masks(predictor, frames: Path, points, labels):
    # Direct port source:218-241; one object with ID 1; no mask interpolation.
    with torch.inference_mode():
        state = predictor.init_state(video_path=str(frames))
        predictor.reset_state(state)
        try:
            predictor.add_new_points_or_box(
                inference_state=state, frame_idx=0, obj_id=1,
                points=points, labels=labels,
            )
            for frame_idx, _object_ids, logits in predictor.propagate_in_video(state):
                yield int(frame_idx), (logits[0, 0] > 0.0).cpu().numpy().astype(np.uint8)
        finally:
            predictor.reset_state(state)


def sort_corners(box):
    # TL, TR, BR, BL; rejects degenerate assignments at projection time.
    total = box.sum(axis=1)
    delta = np.diff(box, axis=1).reshape(-1)
    return np.float32([box[np.argmin(total)], box[np.argmin(delta)],
                       box[np.argmax(total)], box[np.argmax(delta)]])


def compute_homography_from_mask(mask, ui, gray):
    # Port source:288-336: rotated mask bounding box, subpixel refinement, RANSAC.
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    contour = max(contours, key=cv2.contourArea)
    if cv2.contourArea(contour) < 100:
        return None
    box = sort_corners(np.float32(cv2.boxPoints(cv2.minAreaRect(contour))))
    try:
        box = cv2.cornerSubPix(
            gray, box.reshape(-1, 1, 2), winSize=(5, 5), zeroZone=(-1, -1),
            criteria=(cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 0.001),
        ).reshape(-1, 2)
    except cv2.error:
        pass
    if len(np.unique(box, axis=0)) != 4:
        return None
    h, w = ui.shape[:2]
    src = np.float32([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]])
    matrix, _ = cv2.findHomography(src, box, cv2.RANSAC, 5.0)
    return matrix if matrix is not None and np.isfinite(matrix).all() else None


def make_masks(command, args, root, temp, output, erosion, blur):
    source = input_path(root, args.get("input"))
    single = command == "segment-image"
    frames = temp / "frames"
    fps, w, h, sw, sh, count = extract_frames(source, frames, single)
    if command == "propagate":
        initial = read_image(input_path(root, args.get("mask")), True)
        if initial.shape != (h, w):
            raise RequestError("The initial mask must match the video dimensions.")
        points, labels = mask_prompts(initial)
    else:
        points = validate_points(args.get("points"), w, h)
        values = args.get("labels", [1] * len(points))
        if not isinstance(values, list) or len(values) != len(points) or any(type(v) is not int or v not in (0, 1) for v in values) or 1 not in values:
            raise RequestError("labels must contain a 0 or 1 for each point and at least one 1.")
        labels = np.asarray(values, dtype=np.int32)
    points = points * np.float32([sw / w, sh / h])
    predictor = load_predictor()
    masks = temp / "masks"
    masks.mkdir()
    trajectory = masks / "track.jsonl"
    seen = set()
    with trajectory.open("w", encoding="utf8") as track:
        for index, raw in propagated_masks(predictor, frames, points, labels):
            if index < 0 or index >= count or index in seen:
                raise RequestError("Inconsistent SAM2 propagation indices.")
            seen.add(index)
            full = cv2.resize(raw, (w, h), interpolation=cv2.INTER_NEAREST)
            alpha = refine_mask(full, erosion, blur)
            write_image(masks / f"{index:05d}.png", np.uint8(np.rint(alpha * 255)))
            ys, xs = np.where(full > 0)
            bbox = [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1] if len(xs) else None
            centroid = [float(xs.mean()), float(ys.mean())] if len(xs) else None
            track.write(json.dumps({"frame": index, "time": index / fps, "object_id": 1, "bbox_xyxy": bbox, "centroid": centroid}) + "\n")
    if len(seen) != count:
        raise RequestError("SAM2 did not produce a mask for every frame.")
    metadata = {"frames": count, "fps": fps, "width": w, "height": h, "model": MODEL_ID,
                "mask_pattern": "%05d.png", "track": "track.jsonl", "audio": False}
    if command == "propagate":
        metadata["conditioning"] = "foreground/background points sampled from initial mask; not exact mask conditioning"
    (masks / "metadata.json").write_text(json.dumps(metadata), encoding="utf8")
    if single:
        if output.suffix.lower() != ".png":
            raise RequestError("segment-image exige une sortie .png.")
        publish_file(masks / "00000.png", output)
    elif command in {"segment-video", "track", "propagate"}:
        # Exclusive directory creation; private workdir required against symlink races.
        output.mkdir()
        try:
            for item in masks.iterdir():
                shutil.copyfile(item, output / item.name)
        except Exception:
            shutil.rmtree(output)
            raise
    else:
        render_video(command, args, root, source, masks, temp, output, metadata)
    return {"path": args["output"], **metadata}


def publish_file(source: Path, output: Path):
    # Exclusive creation, removes partial result on error, never overwrites.
    with output.open("xb") as target:
        try:
            with source.open("rb") as src:
                shutil.copyfileobj(src, target)
        except Exception:
            output.unlink(missing_ok=True)
            raise


def render_video(command, args, root, source, masks, temp, output, metadata):
    if output.suffix.lower() != ".mp4":
        raise RequestError("Les rendus SAM2 exigent une sortie .mp4.")
    w, h, fps, count = metadata["width"], metadata["height"], metadata["fps"], metadata["frames"]
    if w % 2 or h % 2:
        raise RequestError("Rendu MP4 : dimensions paires requises.")
    # Portable OpenCV MPEG-4 video; no proprietary Apple codec and no audio.
    intermediate = temp / "render.mp4"
    writer = cv2.VideoWriter(str(intermediate), cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))
    if not writer.isOpened():
        writer.release()
        raise RequestError("Encodeur OpenCV mp4v indisponible dans le profil sam2.")
    cap = cv2.VideoCapture(str(source))
    replacement_cap = None
    replacement_image = None
    last_ui = None
    try:
        if command == "screen-replace":
            replacement = input_path(root, args.get("replacement"))
            replacement_image = cv2.imread(str(replacement), cv2.IMREAD_COLOR)
            if replacement_image is None:
                replacement_cap = cv2.VideoCapture(str(replacement))
                if not replacement_cap.isOpened():
                    raise RequestError("Replacement image or video could not be read.")
        for index in range(count):
            ok, frame = cap.read()
            if not ok:
                raise RequestError("Video interrupted during rendering.")
            mask = read_image(masks / f"{index:05d}.png", True)
            if command == "inpaint":
                # Explicit spatial fallback, not a temporal/generative inpainting model.
                rendered = cv2.inpaint(frame, np.uint8(mask > 0) * 255, 3, cv2.INPAINT_TELEA)
            else:
                ui = replacement_image
                if replacement_cap is not None:
                    # One replacement frame per source frame, independent of replacement FPS.
                    ok, ui = replacement_cap.read()
                    if ok:
                        last_ui = ui
                    else:
                        ui = last_ui
                if ui is None:
                    raise RequestError("Replacement has no decodable frame.")
                matrix = compute_homography_from_mask(np.uint8(mask > 127), ui, cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY))
                rendered = frame
                if matrix is not None:
                    warped = cv2.warpPerspective(ui, matrix, (w, h))
                    coverage = cv2.warpPerspective(np.ones(ui.shape[:2], np.float32), matrix, (w, h))
                    alpha = (mask.astype(np.float32) / 255.0 * np.clip(coverage, 0, 1))[..., None]
                    rendered = np.uint8(np.clip(frame.astype(np.float32) * (1 - alpha) + warped.astype(np.float32) * alpha, 0, 255))
            writer.write(rendered)
    finally:
        cap.release()
        writer.release()
        if replacement_cap is not None:
            replacement_cap.release()
    if not intermediate.is_file() or intermediate.stat().st_size == 0:
        raise RequestError("The rendered video is empty.")
    publish_file(intermediate, output)


def execute(command, args):
    global cv2, np, torch
    if command not in COMMANDS or not isinstance(args, dict):
        raise RequestError("Sous-commande inconnue ou arguments JSON objet manquants.")
    shared = {"input", "output", "erosion", "blur"}
    extras = {
        "refine": set(), "propagate": {"mask"},
        "segment-image": {"points", "labels"}, "segment-video": {"points", "labels"},
        "track": {"points", "labels"}, "inpaint": {"points", "labels"},
        "screen-replace": {"points", "labels", "replacement"},
    }
    if set(args) - shared - extras[command]:
        raise RequestError("Unknown parameter for this subcommand.")
    root = work_root()
    # Must be set BEFORE importing Hugging Face/SAM2. No model in the base image.
    models = inside(root, root / "models")
    models.mkdir(parents=True, exist_ok=True)
    os.environ["HF_HOME"] = str(models)
    os.environ["HF_HUB_CACHE"] = str(models / "hub")
    os.environ["HUGGINGFACE_HUB_CACHE"] = str(models / "hub")
    os.environ["TORCH_HOME"] = str(models / "torch")
    try:
        import cv2
        import numpy as np
        if command != "refine":
            import torch
            from sam2.build_sam import build_sam2_video_predictor_hf  # noqa: F401
    except (ImportError, OSError):
        raise Unavailable(HELP) from None
    source = input_path(root, args.get("input"))
    output = output_path(root, args.get("output"))
    erosion = integer(args.get("erosion", 2), 0, 31, "erosion")
    blur = integer(args.get("blur", 9), 1, 99, "blur")
    if blur % 2 == 0:
        raise RequestError("blur doit être impair.")
    # Temporary frames and masks are always cleaned, including failed inference.
    with tempfile.TemporaryDirectory(prefix="sam2-", dir=root) as directory:
        temp = Path(directory)
        if command == "refine":
            if output.suffix.lower() != ".png":
                raise RequestError("refine exige une sortie .png.")
            alpha = refine_mask(read_image(source, True).astype(np.float32) / 255, erosion, blur)
            intermediate = temp / "refined.png"
            write_image(intermediate, np.uint8(np.rint(alpha * 255)))
            publish_file(intermediate, output)
            return {"path": args["output"], "erosion": erosion, "blur": blur}
        return make_masks(command, args, root, temp, output, erosion, blur)


def main():
    # Redirect FD 1 too: native extensions and tqdm must not corrupt JSON stdout.
    json_fd = os.dup(sys.stdout.fileno())
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    status = 0
    try:
        if len(sys.argv) != 2:
            raise RequestError("Une sous-commande est requise : " + ", ".join(sorted(COMMANDS)))
        raw = sys.stdin.buffer.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise RequestError("JSON request too large.")
        try:
            args = json.loads(raw)
        except (ValueError, UnicodeError):
            raise RequestError("Invalid JSON input.") from None
        with contextlib.redirect_stdout(sys.stderr):
            result = execute(sys.argv[1], args)
        response = {"ok": True, "result": result}
    except Unavailable:
        status = 2
        response = {"ok": False, "error": {"code": "SAM2_UNAVAILABLE", "message": HELP}}
    except RequestError as error:
        status = 1
        response = {"ok": False, "error": {"code": "INVALID_REQUEST", "message": str(error)}}
    except Exception:
        status = 1
        # No traceback, exception body, request, local path or credential in output.
        response = {"ok": False, "error": {"code": "SAM2_FAILED", "message": "Traitement SAM2 impossible : vérifier média, mémoire disponible, cache models et compatibilité du paquet patché dans le profil sam2."}}
    with os.fdopen(json_fd, "w", encoding="utf8") as stream:
        stream.write(json.dumps(response, ensure_ascii=False, allow_nan=False) + "\n")
    return status


if __name__ == "__main__":
    sys.exit(main())
