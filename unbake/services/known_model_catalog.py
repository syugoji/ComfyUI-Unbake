# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
#
# ComfyUI-Unbake の一部。著作権の所在を明示してあることが、
# 後から別のライセンスを足せる唯一の担保になる。
"""Catalog of well-known auxiliary models that Civitai does not distribute.

Upscalers referenced by ``UpscaleModelLoader`` are published on GitHub releases
or Hugging Face rather than Civitai, so the ``modelVersionId`` download path can
never reach them. This module maps the names that appear inside recipes and
workflows onto their official distribution URLs.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from ..utils.model_file_names import compact_model_name



# Only strip suffixes that are model container formats; a trailing ".190k" in a
# model name must survive normalization.
# 拡張子の一覧は py.utils.model_file_names が持つ。ここへ書き戻さないこと
# （2026-08-16 実測: 同じ規則が9箇所・5通りに散っていた）。


@dataclass(frozen=True)
class KnownModel:
    """A single catalog entry describing where a model can be obtained."""

    key: str
    filename: str
    folder: str
    aliases: Tuple[str, ...] = field(default_factory=tuple)
    url: Optional[str] = None
    page_url: Optional[str] = None
    size_bytes: Optional[int] = None
    license: str = "unknown"
    source_kind: str = "official"
    downloadable: bool = True


KNOWN_MODELS: Tuple[KnownModel, ...] = (
    KnownModel(
        key="swinir_4x",
        filename="SwinIR_4x.pth",
        folder="upscale_models",
        aliases=("SwinIR_4x", "SwinIR 4x"),
        url=(
            "https://github.com/JingyunLiang/SwinIR/releases/download/v0.0/"
            "003_realSR_BSRGAN_DFOWMFC_s64w8_SwinIR-L_x4_GAN.pth"
        ),
        size_bytes=142473939,
        license="Apache-2.0",
        source_kind="official",
    ),
    KnownModel(
        key="resrgan_4x_anime6b",
        filename="RealESRGAN_x4plus_anime_6B.pth",
        folder="upscale_models",
        aliases=(
            "R-ESRGAN 4x+ Anime6B",
            "RealESRGAN_x4plus_anime_6B",
            "RealESRGAN_x4plus_anime_6B.pth",
        ),
        url=(
            "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.2.4/"
            "RealESRGAN_x4plus_anime_6B.pth"
        ),
        size_bytes=17938799,
        license="BSD-3-Clause",
        source_kind="official",
    ),
    KnownModel(
        key="resrgan_4xplus",
        filename="RealESRGAN_x4plus.pth",
        folder="upscale_models",
        aliases=("R-ESRGAN 4x+", "RealESRGAN_x4plus", "RealESRGAN_x4plus.pth"),
        url=(
            "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/"
            "RealESRGAN_x4plus.pth"
        ),
        size_bytes=67040989,
        license="BSD-3-Clause",
        source_kind="official",
    ),
    KnownModel(
        key="resrgan_2xplus",
        filename="RealESRGAN_x2plus.pth",
        folder="upscale_models",
        aliases=("R-ESRGAN 2x+", "RealESRGAN_x2plus", "RealESRGAN_x2plus.pth"),
        url=(
            "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.1/"
            "RealESRGAN_x2plus.pth"
        ),
        size_bytes=67061725,
        license="BSD-3-Clause",
        source_kind="official",
    ),
    KnownModel(
        key="ultrasharp_4x",
        filename="4x-UltraSharp.pth",
        folder="upscale_models",
        aliases=("4x-UltraSharp", "4x_UltraSharp", "4xUltrasharp_4xUltrasharpV10"),
        url="https://huggingface.co/Kim2091/UltraSharp/resolve/main/4x-UltraSharp.pth",
        size_bytes=66961958,
        license="CC-BY-NC-SA-4.0",
        source_kind="official",
    ),
    KnownModel(
        key="animesharp_4x",
        filename="4x-AnimeSharp.pth",
        folder="upscale_models",
        aliases=("4x-AnimeSharp", "4x_AnimeSharp"),
        url="https://huggingface.co/Kim2091/AnimeSharp/resolve/main/4x-AnimeSharp.pth",
        size_bytes=67010245,
        license="CC-BY-NC-SA-4.0",
        source_kind="official",
    ),
    KnownModel(
        key="remacri_4x",
        filename="4x_foolhardy_Remacri.pth",
        folder="upscale_models",
        aliases=("4x_foolhardy_Remacri", "Remacri", "4x-Remacri"),
        url=(
            "https://huggingface.co/FacehugmanIII/4x_foolhardy_Remacri/resolve/main/"
            "4x_foolhardy_Remacri.pth"
        ),
        size_bytes=67025055,
        license="unknown",
        source_kind="mirror",
    ),
    KnownModel(
        key="nmkd_siax_4x",
        filename="4x_NMKD-Siax_200k.pth",
        folder="upscale_models",
        aliases=("4x_NMKD-Siax_200k", "4x-NMKD-Siax"),
        url=(
            "https://huggingface.co/uwg/upscaler/resolve/main/ESRGAN/"
            "4x_NMKD-Siax_200k.pth"
        ),
        size_bytes=66957746,
        license="unknown",
        source_kind="mirror",
    ),
    KnownModel(
        key="nomos8k_dat_4x",
        filename="4xNomos8kDAT.pth",
        folder="upscale_models",
        aliases=("4xNomos8kDAT", "4x_Nomos8kDAT"),
        url=(
            "https://github.com/Phhofm/models/releases/download/4xNomos8kDAT/"
            "4xNomos8kDAT.pth"
        ),
        size_bytes=154687598,
        license="CC-BY-4.0",
        source_kind="official",
    ),
    # 公式配布が zip 同梱のみで単体 .pth の直リンクが無いため、UI 側で
    # 「手動導入が要る」と説明できるよう正体だけを載せる。
    KnownModel(
        key="janai_dat2_190k",
        filename="4x_IllustrationJaNai_V1_DAT2_190k.pth",
        folder="upscale_models",
        aliases=("4x_IllustrationJaNai_V1_DAT2_190k",),
        page_url="https://github.com/the-database/MangaJaNai/releases",
        license="unknown",
        source_kind="official",
        downloadable=False,
    ),
    KnownModel(
        key="janai_esrgan_135k",
        filename="4x_IllustrationJaNai_V1_ESRGAN_135k.pth",
        folder="upscale_models",
        aliases=("4x_IllustrationJaNai_V1_ESRGAN_135k",),
        page_url="https://github.com/the-database/MangaJaNai/releases",
        license="unknown",
        source_kind="official",
        downloadable=False,
    ),
    # Real-ESRGAN's own releases ship ``RealESRGAN_x2plus.pth``; recipes ask for
    # the plain ``RealESRGAN_x2.pth`` that the ai-forever mirror publishes.
    # Measured 2026-08-10: both URLs report the same 67,061,725 bytes. Kept as a
    # separate entry so the download lands under the exact name the graph asks
    # for; ``R-ESRGAN 2x+`` stays on ``resrgan_2xplus`` to avoid an alias clash.
    KnownModel(
        key="resrgan_x2_plain",
        filename="RealESRGAN_x2.pth",
        folder="upscale_models",
        aliases=("RealESRGAN_x2", "RealESRGAN x2"),
        url="https://huggingface.co/ai-forever/Real-ESRGAN/resolve/main/RealESRGAN_x2.pth",
        size_bytes=67061725,
        license="BSD-3-Clause",
        source_kind="mirror",
    ),
    # ``UltralyticsDetectorProvider`` names detectors with their subfolder, e.g.
    # ``bbox/face_yolov8m.pt``. Impact-Subpack registers the folder as
    # ``ultralytics_bbox`` (not ``ultralytics``), so downloads must target that.
    KnownModel(
        key="face_yolov8m",
        filename="face_yolov8m.pt",
        folder="ultralytics_bbox",
        aliases=("bbox/face_yolov8m.pt", "bbox/face_yolov8m", "face_yolov8m"),
        url="https://huggingface.co/Bingsu/adetailer/resolve/main/face_yolov8m.pt",
        size_bytes=52026019,
        license="AGPL-3.0",
        source_kind="official",
    ),
    # HiDream reads four encoders through QuadrupleCLIPLoader (ComfyUI templates
    # hidream_i1_dev.json / hidream_i1_fast.json). t5xxl and ae are shared with
    # the Flux.1 entries above. Measured 2026-08-10 (HEAD).
    KnownModel(
        key="hidream_clip_l",
        filename="clip_l_hidream.safetensors",
        folder="text_encoders",
        aliases=("clip_l_hidream",),
        url=(
            "https://huggingface.co/Comfy-Org/HiDream-I1_ComfyUI/resolve/main/"
            "split_files/text_encoders/clip_l_hidream.safetensors"
        ),
        size_bytes=247586528,
        license="MIT",
        source_kind="official",
    ),
    KnownModel(
        key="hidream_clip_g",
        filename="clip_g_hidream.safetensors",
        folder="text_encoders",
        aliases=("clip_g_hidream",),
        url=(
            "https://huggingface.co/Comfy-Org/HiDream-I1_ComfyUI/resolve/main/"
            "split_files/text_encoders/clip_g_hidream.safetensors"
        ),
        size_bytes=1389743104,
        license="MIT",
        source_kind="official",
    ),
    KnownModel(
        key="hidream_llama_text_encoder",
        filename="llama_3.1_8b_instruct_fp8_scaled.safetensors",
        folder="text_encoders",
        aliases=("llama_3.1_8b_instruct_fp8_scaled",),
        url=(
            "https://huggingface.co/Comfy-Org/HiDream-I1_ComfyUI/resolve/main/"
            "split_files/text_encoders/llama_3.1_8b_instruct_fp8_scaled.safetensors"
        ),
        size_bytes=9081258056,
        license="unknown",
        source_kind="official",
    ),
    # Flux.1 loads two encoders. ``ae.safetensors`` is shared: HiDream, Lumina 2
    # and Z-Image repackagings all report the same 335,304,388 bytes, so the
    # single ``zimage_ae_vae`` entry serves them all. Black-Forest-Labs' own copy
    # is gated (HTTP 401), which is why the Comfy-Org mirror is used.
    # Measured 2026-08-10 (HEAD).
    KnownModel(
        key="flux1_t5xxl_text_encoder",
        filename="t5xxl_fp8_e4m3fn_scaled.safetensors",
        folder="text_encoders",
        aliases=("t5xxl_fp8_e4m3fn_scaled",),
        url=(
            "https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/"
            "t5xxl_fp8_e4m3fn_scaled.safetensors"
        ),
        size_bytes=5157348688,
        license="Apache-2.0",
        source_kind="official",
    ),
    KnownModel(
        key="flux1_clip_l_text_encoder",
        filename="clip_l.safetensors",
        folder="text_encoders",
        aliases=("clip_l",),
        url=(
            "https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/"
            "clip_l.safetensors"
        ),
        size_bytes=246144152,
        license="MIT",
        source_kind="official",
    ),
    # Flux.2 needs a different encoder and VAE than Flux.1: a single Mistral-3
    # text encoder (``type=flux2``) and ``flux2-vae.safetensors``. Names follow
    # ComfyUI's own templates (image_flux2_fp8.json). The bf16 encoder is
    # 35,584,897,447 bytes; the fp8 one below is the practical default.
    # Measured 2026-08-10 (HEAD).
    KnownModel(
        key="flux2_mistral_text_encoder",
        filename="mistral_3_small_flux2_fp8.safetensors",
        folder="text_encoders",
        aliases=("mistral_3_small_flux2_fp8", "mistral_3_small_flux2"),
        url=(
            "https://huggingface.co/Comfy-Org/flux2-dev/resolve/main/"
            "split_files/text_encoders/mistral_3_small_flux2_fp8.safetensors"
        ),
        size_bytes=18034640095,
        license="unknown",
        source_kind="official",
    ),
    KnownModel(
        key="flux2_vae",
        filename="flux2-vae.safetensors",
        folder="vae",
        aliases=("flux2-vae", "flux2_vae"),
        url=(
            "https://huggingface.co/Comfy-Org/flux2-dev/resolve/main/"
            "split_files/vae/flux2-vae.safetensors"
        ),
        size_bytes=336213556,
        license="unknown",
        source_kind="official",
    ),
    # Qwen-Image loads its own Qwen2.5-VL encoder plus the shared Qwen VAE
    # (ComfyUI template image_qwen_image.json). Measured 2026-08-10 (HEAD).
    KnownModel(
        key="qwen_image_text_encoder",
        filename="qwen_2.5_vl_7b_fp8_scaled.safetensors",
        folder="text_encoders",
        aliases=("qwen_2.5_vl_7b_fp8_scaled", "qwen_2.5_vl_7b"),
        url=(
            "https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/"
            "split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors"
        ),
        size_bytes=9384670680,
        license="Apache-2.0",
        source_kind="official",
    ),
    # Z-Image ships its VAE on Civitai as ``ae.safetensors``; Comfy-Org publishes
    # the same file. Measured 2026-08-10 (HEAD): 335,304,388 bytes.
    KnownModel(
        key="zimage_ae_vae",
        filename="ae.safetensors",
        folder="vae",
        aliases=("ae",),
        url=(
            "https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/"
            "split_files/vae/ae.safetensors"
        ),
        size_bytes=335304388,
        license="Apache-2.0",
        source_kind="official",
    ),
    # Krea 2 and Z-Image are distributed as diffusion models only; their text
    # encoders live in the Comfy-Org repackagings. Names follow those repos so a
    # downloaded file lands under the name the recorded graphs load.
    # Measured 2026-08-10 (HEAD): 8,875,719,384 / 8,044,982,048 bytes.
    KnownModel(
        key="krea2_qwen3vl_text_encoder",
        filename="qwen3vl_4b_bf16.safetensors",
        folder="text_encoders",
        aliases=("qwen3vl_4b_bf16", "qwen3vl_4b"),
        url=(
            "https://huggingface.co/Comfy-Org/Krea-2/resolve/main/"
            "text_encoders/qwen3vl_4b_bf16.safetensors"
        ),
        size_bytes=8875719384,
        license="unknown",
        source_kind="official",
    ),
    KnownModel(
        key="zimage_qwen3_4b_text_encoder",
        filename="qwen_3_4b.safetensors",
        folder="text_encoders",
        aliases=("qwen_3_4b",),
        url=(
            "https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/"
            "split_files/text_encoders/qwen_3_4b.safetensors"
        ),
        size_bytes=8044982048,
        license="Apache-2.0",
        source_kind="official",
    ),
    # Anima ships its text encoder alongside the UNet, but under a different
    # name than the workflows reference: the Civitai file is
    # ``anima_baseV10_txt.safetensors`` while every recorded graph loads
    # ``qwen_3_06b_base.safetensors``. Download it under the name the graphs
    # expect, otherwise the file lands and the recipe still reports it missing.
    # Measured 2026-08-10 (HEAD): 1,192,135,096 bytes.
    KnownModel(
        key="anima_qwen3_text_encoder",
        filename="qwen_3_06b_base.safetensors",
        folder="text_encoders",
        aliases=("qwen_3_06b_base", "anima_baseV10_txt", "anima_baseV10_txt.safetensors"),
        url=(
            "https://civitai.com/api/download/models/2945208"
            "?type=Text%20Encoder&format=Other&fp=bf16"
        ),
        size_bytes=1192135096,
        license="unknown",
        source_kind="official",
    ),
    # Anima (Qwen-Image based) ships this VAE; Comfy-Org republishes the same
    # file for ComfyUI. Measured 2026-08-10: 253,806,246 bytes.
    KnownModel(
        key="qwen_image_vae",
        filename="qwen_image_vae.safetensors",
        folder="vae",
        aliases=("qwen_image_vae",),
        url=(
            "https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/"
            "split_files/vae/qwen_image_vae.safetensors"
        ),
        size_bytes=253806246,
        license="Apache-2.0",
        source_kind="official",
    ),
)


# UNet単体で配られる系統が、本体のほかに必要とするファイル。
#
# Civitai はこれらの系統について拡散モデル本体しか配らない（Z-Image のVAEだけ例外）。
# 本体を落としただけでは動かないのに、それが判るのは**落とし終えてから**なので、
# ダウンロードが何往復にもなり、最初に見せる総容量も過少になる。
#
# 実測（2026-08-10 / 全346レシピ + 導入済み117チェックポイント）:
#   レシピでの使用    Flux.1 D 17 / Anima 9 / Krea 2 4 / ZImageTurbo 3
#   導入済みモデル    Anima 5 / Flux.1 D 4 / Krea 2 3 / ZImageTurbo 1
# 構成の裏が取れた系統だけを載せる。憶測で足すと、要らないファイルを
# 何GBも落とさせることになる。
DIFFUSION_MODEL_COMPANIONS: Dict[str, Tuple[str, ...]] = {
    "Anima": ("anima_qwen3_text_encoder", "qwen_image_vae"),
    "Krea 2": ("krea2_qwen3vl_text_encoder", "qwen_image_vae"),
    "Chroma": ("flux1_t5xxl_text_encoder", "zimage_ae_vae"),
    "HiDream": (
        "hidream_clip_l", "hidream_clip_g", "flux1_t5xxl_text_encoder",
        "hidream_llama_text_encoder", "zimage_ae_vae",
    ),
    "Flux.1 D": ("flux1_t5xxl_text_encoder", "flux1_clip_l_text_encoder", "zimage_ae_vae"),
    "Flux.1 Kontext": ("flux1_t5xxl_text_encoder", "flux1_clip_l_text_encoder", "zimage_ae_vae"),
    "Flux.1 Krea": ("flux1_t5xxl_text_encoder", "flux1_clip_l_text_encoder", "zimage_ae_vae"),
    "Flux.1 S": ("flux1_t5xxl_text_encoder", "flux1_clip_l_text_encoder", "zimage_ae_vae"),
    "Flux.2 D": ("flux2_mistral_text_encoder", "flux2_vae"),
    "Flux.2 Klein 4B": ("flux2_mistral_text_encoder", "flux2_vae"),
    "Flux.2 Klein 4B-base": ("flux2_mistral_text_encoder", "flux2_vae"),
    "Flux.2 Klein 9B": ("flux2_mistral_text_encoder", "flux2_vae"),
    "Flux.2 Klein 9B-base": ("flux2_mistral_text_encoder", "flux2_vae"),
    "Qwen": ("qwen_image_text_encoder", "qwen_image_vae"),
    "ZImageBase": ("zimage_qwen3_4b_text_encoder", "zimage_ae_vae"),
    "ZImageTurbo": ("zimage_qwen3_4b_text_encoder", "zimage_ae_vae"),
}


def companions_for(base_model: Any) -> List[KnownModel]:
    """Return the catalog entries a diffusion-model base needs alongside itself."""

    if not isinstance(base_model, str):
        return []
    keys = DIFFUSION_MODEL_COMPANIONS.get(base_model.strip())
    if not keys:
        return []
    return [entry for entry in (get_known_model(key) for key in keys) if entry]


def normalize_model_name(value: Any) -> str:
    """Reduce a model name to a comparison key.

    Recipes spell the same upscaler as ``R-ESRGAN 4x+ Anime6B`` while ComfyUI
    lists it as ``RealESRGAN_x4plus_anime_6B.pth``; only the alphanumerics
    survive both spellings.
    """

    if not isinstance(value, str):
        return ""

    return compact_model_name(value.strip())


def _build_alias_index() -> Dict[str, KnownModel]:
    index: Dict[str, KnownModel] = {}
    for entry in KNOWN_MODELS:
        for candidate in (entry.key, entry.filename, *entry.aliases):
            normalized = normalize_model_name(candidate)
            if normalized:
                index.setdefault(normalized, entry)
    return index


_ALIAS_INDEX: Dict[str, KnownModel] = _build_alias_index()


def find_known_model(name: Any) -> Optional[KnownModel]:
    """Resolve a recipe/workflow model name to a catalog entry."""

    normalized = normalize_model_name(name)
    if not normalized:
        return None
    return _ALIAS_INDEX.get(normalized)


def get_known_model(key: Any) -> Optional[KnownModel]:
    """Resolve a catalog entry by its exact key."""

    for entry in KNOWN_MODELS:
        if entry.key == key:
            return entry
    return None


def entry_to_dict(entry: KnownModel) -> Dict[str, Any]:
    """Serialize one catalog entry for the HTTP API."""

    return {
        "key": entry.key,
        "filename": entry.filename,
        "folder": entry.folder,
        "aliases": list(entry.aliases),
        "url": entry.url,
        "page_url": entry.page_url,
        "size_bytes": entry.size_bytes,
        "license": entry.license,
        "source_kind": entry.source_kind,
        "downloadable": entry.downloadable,
    }


def catalog_entries(folder: Optional[str] = None) -> List[Dict[str, Any]]:
    """Serialize the catalog, optionally narrowed to a single folder."""

    return [
        entry_to_dict(entry)
        for entry in KNOWN_MODELS
        if folder is None or entry.folder == folder
    ]


def catalog_folders() -> List[str]:
    """List every folder the catalog covers, in first-seen order."""

    folders: List[str] = []
    for entry in KNOWN_MODELS:
        if entry.folder not in folders:
            folders.append(entry.folder)
    return folders
