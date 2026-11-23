"""Zero-shot junk scoring with CLIP: how much an image looks like a forward, meme or greeting
versus a personal photograph. Scores only order the review; they never delete or skip anything."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import onnxruntime as ort
from huggingface_hub import hf_hub_download
from PIL import Image, ImageOps
from pillow_heif import register_heif_opener
from tokenizers import Tokenizer

register_heif_opener()

JUNK_PROMPTS = {
    "meme": "a meme with a caption",
    "greeting": "a good morning greeting card with flowers and text",
    "quote": "a motivational or religious quote image",
    "forward": "a forwarded message image full of text",
    "festival": "a festival wishes graphic",
    "screenshot": "a screenshot of a phone screen",
    "sticker": "a cartoon sticker or emoji",
}
KEEP_PROMPTS = {
    "people": "a photo of people",
    "selfie": "a selfie taken with a phone",
    "group": "a group photo of friends or family",
    "place": "a travel or landscape photo",
    "food": "a photo of food",
    "document": "a photo of a document, ticket or receipt",
    "event": "a photo of an event or celebration",
}

MEAN = np.array([0.48145466, 0.4578275, 0.40821073], dtype=np.float32)
STD = np.array([0.26862954, 0.26130258, 0.27577711], dtype=np.float32)
SIZE = 224


@dataclass(frozen=True)
class JunkScore:
    junk: float
    label: str


def _preprocess(path: Path) -> np.ndarray:
    with Image.open(path) as image:
        image = ImageOps.exif_transpose(image).convert("RGB")
        scale = SIZE / min(image.size)
        image = image.resize(
            (max(SIZE, round(image.width * scale)), max(SIZE, round(image.height * scale))),
            Image.Resampling.BICUBIC,
        )
        left, top = (image.width - SIZE) // 2, (image.height - SIZE) // 2
        image = image.crop((left, top, left + SIZE, top + SIZE))
        pixels = (np.asarray(image, dtype=np.float32) / 255.0 - MEAN) / STD
    return pixels.transpose(2, 0, 1)


def _normalise(vectors: np.ndarray) -> np.ndarray:
    return vectors / np.linalg.norm(vectors, axis=-1, keepdims=True)


class JunkClassifier:
    def __init__(self, repo: str, revision: str, model_dir: str) -> None:
        def fetch(name: str) -> str:
            return hf_hub_download(repo, name, revision=revision, cache_dir=model_dir)

        options = ort.SessionOptions()
        options.intra_op_num_threads = max(1, (os.cpu_count() or 2) // 2)
        self.vision = ort.InferenceSession(
            fetch("onnx/vision_model_quantized.onnx"), options, providers=["CPUExecutionProvider"]
        )
        text = ort.InferenceSession(
            fetch("onnx/text_model_quantized.onnx"), options, providers=["CPUExecutionProvider"]
        )
        tokenizer = Tokenizer.from_file(fetch("tokenizer.json"))
        tokenizer.enable_padding(length=77, pad_id=49407)
        tokenizer.enable_truncation(max_length=77)

        self.labels = list(JUNK_PROMPTS) + list(KEEP_PROMPTS)
        self.junk_count = len(JUNK_PROMPTS)
        prompts = list(JUNK_PROMPTS.values()) + list(KEEP_PROMPTS.values())
        encoded = tokenizer.encode_batch(prompts)
        input_ids = np.array([item.ids for item in encoded], dtype=np.int64)
        attention = np.array([item.attention_mask for item in encoded], dtype=np.int64)
        feeds = {"input_ids": input_ids}
        if "attention_mask" in {node.name for node in text.get_inputs()}:
            feeds["attention_mask"] = attention
        self.text_embeddings = _normalise(text.run(["text_embeds"], feeds)[0])

    def score(self, paths: list[Path]) -> list[JunkScore | None]:
        results: list[JunkScore | None] = [None] * len(paths)
        batch, positions = [], []
        for index, path in enumerate(paths):
            try:
                batch.append(_preprocess(path))
                positions.append(index)
            except Exception:  # unreadable or not an image: left unscored, never dropped
                continue
        if not batch:
            return results
        image_embeddings = _normalise(self.vision.run(["image_embeds"], {"pixel_values": np.stack(batch)})[0])
        logits = 100.0 * image_embeddings @ self.text_embeddings.T
        probabilities = np.exp(logits - logits.max(axis=1, keepdims=True))
        probabilities /= probabilities.sum(axis=1, keepdims=True)
        for row, index in enumerate(positions):
            best = int(probabilities[row].argmax())
            results[index] = JunkScore(
                junk=float(probabilities[row, : self.junk_count].sum()), label=self.labels[best]
            )
        return results
