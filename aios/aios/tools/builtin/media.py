"""Video, audio and image tooling built on ffmpeg.

The governing rule is **never damage the original**. Every operation writes a
new file; nothing edits in place, so a bad automated edit costs disk space
rather than footage.

The non-obvious piece is :class:`RemoveSilence`. Naive silence removal makes
one cut per gap and re-encodes N times. This runs a single ``silencedetect``
analysis pass, inverts the detected silences into keep-ranges, and applies them
in one pass via ``select``/``aselect`` filters with ``setpts``/``asetpts``
regeneration - which is how an editor would do it, and keeps audio and video in
sync instead of drifting a frame per cut.
"""

from __future__ import annotations

import asyncio
import json
import re
import shutil
from pathlib import Path
from typing import Any

from ...foundation.errors import InvalidArguments, ToolExecutionError
from ...security import capabilities as caps
from ...security.capabilities import RiskLevel
from ...security.policy import ActionRequest
from ..base import Tool, ToolContext, ToolResult

VIDEO_SUFFIXES = {".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".flv"}
AUDIO_SUFFIXES = {".mp3", ".wav", ".flac", ".aac", ".m4a", ".ogg", ".opus"}


def _binary(name: str) -> str:
    path = shutil.which(name)
    if not path:
        raise ToolExecutionError(
            f"{name} is not installed. Install ffmpeg to enable media tools "
            "(macOS: `brew install ffmpeg`, Debian/Ubuntu: `apt install ffmpeg`).",
            context={"missing_binary": name},
        )
    return path


async def _run(argv: list[str], *, timeout: float) -> tuple[int, str]:
    process = await asyncio.create_subprocess_exec(
        *argv,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        stdin=asyncio.subprocess.DEVNULL,
    )
    try:
        out, _ = await asyncio.wait_for(process.communicate(), timeout=timeout)
    except TimeoutError:
        process.kill()
        await process.wait()
        raise
    return process.returncode or 0, out.decode("utf-8", "replace")


async def _ffmpeg(argv: list[str], ctx: ToolContext, *, timeout: float | None = None) -> str:
    limit = timeout or max(60.0, ctx.remaining_seconds())
    code, output = await _run([_binary("ffmpeg"), "-hide_banner", "-nostdin", "-y", *argv],
                              timeout=limit)
    if code != 0:
        raise ToolExecutionError(
            f"ffmpeg failed (exit {code})",
            context={"args": argv[:20], "output_tail": output[-2500:]},
        )
    return output


class MediaBase(Tool):
    capabilities = frozenset({caps.FS_READ, caps.FS_WRITE, caps.PROCESS_SPAWN})
    risk = RiskLevel.LOW
    default_timeout = 3600.0
    tags = ("media", "video", "audio")

    def plan_action(self, args: dict[str, Any]) -> ActionRequest:
        action = super().plan_action(args)
        action.paths = [
            str(args[key]) for key in ("input", "output", "source", "destination", "subtitles")
            if args.get(key)
        ]
        for item in args.get("inputs") or []:
            action.paths.append(str(item))
        return action

    @staticmethod
    def _default_output(source: Path, suffix: str, tag: str) -> Path:
        return source.with_name(f"{source.stem}.{tag}{suffix}")


class Probe(MediaBase):
    name = "media.probe"
    summary = "Inspect a media file: duration, streams, codecs, resolution, bitrate."
    tags = ("media", "video", "audio", "inspect", "read")
    capabilities = frozenset({caps.FS_READ, caps.PROCESS_SPAWN})
    risk = RiskLevel.SAFE
    default_timeout = 120.0
    parameters = {
        "type": "object",
        "properties": {"input": {"type": "string"}},
        "required": ["input"],
        "additionalProperties": False,
    }

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        source = ctx.jail.resolve(args["input"], must_exist=True)
        code, output = await _run(
            [_binary("ffprobe"), "-v", "error", "-print_format", "json",
             "-show_format", "-show_streams", str(source)],
            timeout=120,
        )
        if code != 0:
            raise ToolExecutionError(f"ffprobe failed: {output[-1000:]}")
        data = json.loads(output or "{}")
        fmt = data.get("format", {})
        video = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), {})
        audio = next((s for s in data.get("streams", []) if s.get("codec_type") == "audio"), {})
        summary = {
            "path": ctx.jail.relative(source),
            "duration_s": round(float(fmt.get("duration", 0) or 0), 3),
            "size_bytes": int(fmt.get("size", 0) or 0),
            "bitrate": int(fmt.get("bit_rate", 0) or 0),
            "format": fmt.get("format_name", ""),
            "video": {
                "codec": video.get("codec_name"),
                "width": video.get("width"),
                "height": video.get("height"),
                "fps": _fps(video.get("r_frame_rate", "")),
            } if video else None,
            "audio": {
                "codec": audio.get("codec_name"),
                "channels": audio.get("channels"),
                "sample_rate": audio.get("sample_rate"),
            } if audio else None,
            "streams": len(data.get("streams", [])),
        }
        parts = [f"{summary['duration_s']:.1f}s"]
        if summary["video"]:
            parts.append(f"{summary['video']['width']}x{summary['video']['height']}")
        if summary["audio"]:
            parts.append(f"{summary['audio']['codec']} audio")
        return ToolResult.success(summary, summary=" · ".join(parts))


def _fps(rate: str) -> float:
    if "/" not in rate:
        return 0.0
    num, _, den = rate.partition("/")
    try:
        return round(float(num) / float(den), 3) if float(den) else 0.0
    except ValueError:
        return 0.0


class Transcode(MediaBase):
    name = "media.transcode"
    summary = "Convert or compress a media file with quality/size presets."
    parameters = {
        "type": "object",
        "properties": {
            "input": {"type": "string"},
            "output": {"type": "string"},
            "preset": {"type": "string",
                       "enum": ["web", "high", "small", "audio-only", "gif", "lossless"],
                       "default": "web"},
            "resolution": {"type": "string",
                           "description": "Target height, e.g. '1080' or '720'."},
        },
        "required": ["input"],
        "additionalProperties": False,
    }

    PRESETS: dict[str, list[str]] = {
        # H.264 + AAC, faststart so it plays before it finishes downloading.
        "web": ["-c:v", "libx264", "-preset", "medium", "-crf", "23",
                "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart"],
        "high": ["-c:v", "libx264", "-preset", "slow", "-crf", "18",
                 "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"],
        "small": ["-c:v", "libx264", "-preset", "slower", "-crf", "30",
                  "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart"],
        "audio-only": ["-vn", "-c:a", "aac", "-b:a", "192k"],
        "gif": ["-vf", "fps=12,scale=640:-1:flags=lanczos", "-loop", "0"],
        "lossless": ["-c:v", "libx264", "-preset", "veryslow", "-qp", "0", "-c:a", "flac"],
    }

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        source = ctx.jail.resolve(args["input"], must_exist=True)
        preset = args.get("preset", "web")
        suffix = {"audio-only": ".m4a", "gif": ".gif"}.get(preset, ".mp4")
        destination = ctx.jail.resolve(
            args.get("output") or self._default_output(source, suffix, preset), write=True
        )
        if destination == source:
            raise InvalidArguments("output must differ from input; originals are never overwritten")
        destination.parent.mkdir(parents=True, exist_ok=True)

        argv = ["-i", str(source), *self.PRESETS[preset]]
        if args.get("resolution") and preset != "gif":
            height = re.sub(r"\D", "", str(args["resolution"])) or "1080"
            argv += ["-vf", f"scale=-2:{height}"]
        argv.append(str(destination))
        await _ffmpeg(argv, ctx)

        before, after = source.stat().st_size, destination.stat().st_size
        return ToolResult.success(
            {"input": ctx.jail.relative(source), "output": ctx.jail.relative(destination),
             "preset": preset, "input_bytes": before, "output_bytes": after,
             "ratio": round(after / before, 3) if before else 0},
            summary=f"{preset}: {before / 1e6:.1f}MB -> {after / 1e6:.1f}MB",
            artifacts=[ctx.keep_file(destination)],
        )


class Trim(MediaBase):
    name = "media.trim"
    summary = "Cut a time range out of a media file (stream-copy when possible)."
    parameters = {
        "type": "object",
        "properties": {
            "input": {"type": "string"},
            "output": {"type": "string"},
            "start": {"type": "string", "default": "0",
                      "description": "Seconds or HH:MM:SS(.ms)."},
            "end": {"type": "string"},
            "duration": {"type": "string"},
            "reencode": {"type": "boolean", "default": False,
                         "description": "Frame-accurate but slower."},
        },
        "required": ["input"],
        "additionalProperties": False,
    }

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        source = ctx.jail.resolve(args["input"], must_exist=True)
        destination = ctx.jail.resolve(
            args.get("output") or self._default_output(source, source.suffix, "trim"), write=True
        )
        if destination == source:
            raise InvalidArguments("output must differ from input")
        if not args.get("end") and not args.get("duration"):
            raise InvalidArguments("provide either `end` or `duration`")
        destination.parent.mkdir(parents=True, exist_ok=True)

        argv = ["-ss", str(args.get("start", "0")), "-i", str(source)]
        if args.get("duration"):
            argv += ["-t", str(args["duration"])]
        else:
            argv += ["-to", str(args["end"])]
        argv += (["-c:v", "libx264", "-crf", "20", "-c:a", "aac"]
                 if args.get("reencode") else ["-c", "copy"])
        argv.append(str(destination))
        await _ffmpeg(argv, ctx)
        return ToolResult.success(
            {"output": ctx.jail.relative(destination),
             "start": args.get("start", "0"),
             "end": args.get("end"), "duration": args.get("duration"),
             "bytes": destination.stat().st_size},
            summary=f"trimmed to {destination.name}",
            artifacts=[ctx.keep_file(destination)],
        )


class ExtractAudio(MediaBase):
    name = "media.extract_audio"
    summary = "Extract the audio track from a video."
    parameters = {
        "type": "object",
        "properties": {
            "input": {"type": "string"},
            "output": {"type": "string"},
            "format": {"type": "string", "enum": ["wav", "mp3", "m4a", "flac"], "default": "wav"},
        },
        "required": ["input"],
        "additionalProperties": False,
    }

    CODECS = {"wav": ["-c:a", "pcm_s16le", "-ar", "16000", "-ac", "1"],
              "mp3": ["-c:a", "libmp3lame", "-q:a", "2"],
              "m4a": ["-c:a", "aac", "-b:a", "192k"],
              "flac": ["-c:a", "flac"]}

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        source = ctx.jail.resolve(args["input"], must_exist=True)
        fmt = args.get("format", "wav")
        destination = ctx.jail.resolve(
            args.get("output") or source.with_suffix(f".{fmt}"), write=True
        )
        destination.parent.mkdir(parents=True, exist_ok=True)
        await _ffmpeg(["-i", str(source), "-vn", *self.CODECS[fmt], str(destination)], ctx)
        return ToolResult.success(
            {"output": ctx.jail.relative(destination), "format": fmt,
             "bytes": destination.stat().st_size},
            summary=f"extracted {fmt} audio to {destination.name}",
            artifacts=[ctx.keep_file(destination)],
        )


class Thumbnail(MediaBase):
    name = "media.thumbnail"
    summary = "Grab a poster frame, or a contact sheet of frames, from a video."
    parameters = {
        "type": "object",
        "properties": {
            "input": {"type": "string"},
            "output": {"type": "string"},
            "at": {"type": "string", "default": "10%",
                   "description": "Timestamp, or a percentage of duration."},
            "count": {"type": "integer", "minimum": 1, "maximum": 24, "default": 1},
            "width": {"type": "integer", "minimum": 64, "default": 1280},
        },
        "required": ["input"],
        "additionalProperties": False,
    }

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        source = ctx.jail.resolve(args["input"], must_exist=True)
        width = int(args.get("width", 1280))
        count = int(args.get("count", 1))
        duration = await _duration(source)
        at = str(args.get("at", "10%"))
        if at.endswith("%"):
            offset = duration * float(at.rstrip("%")) / 100
        else:
            offset = _seconds(at)

        artifacts = []
        outputs = []
        for index in range(count):
            timestamp = offset if count == 1 else duration * (index + 0.5) / count
            default = source.with_name(
                f"{source.stem}.thumb{'' if count == 1 else f'-{index + 1:02d}'}.jpg"
            )
            destination = ctx.jail.resolve(
                args.get("output") if count == 1 and args.get("output") else default, write=True
            )
            destination.parent.mkdir(parents=True, exist_ok=True)
            await _ffmpeg(
                ["-ss", f"{max(0.0, timestamp):.3f}", "-i", str(source), "-frames:v", "1",
                 "-vf", f"scale={width}:-2", "-q:v", "2", str(destination)],
                ctx,
                timeout=180,
            )
            outputs.append(ctx.jail.relative(destination))
            artifacts.append(ctx.keep_file(destination))
        return ToolResult.success(
            {"outputs": outputs, "count": len(outputs), "source_duration_s": duration},
            summary=f"captured {len(outputs)} frame(s)",
            artifacts=artifacts,
        )


async def _duration(path: Path) -> float:
    code, output = await _run(
        [_binary("ffprobe"), "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", str(path)],
        timeout=60,
    )
    try:
        return float(output.strip().splitlines()[0]) if code == 0 and output.strip() else 0.0
    except (ValueError, IndexError):
        return 0.0


def _seconds(value: str) -> float:
    value = value.strip()
    if ":" not in value:
        return float(value or 0)
    parts = [float(p) for p in value.split(":")]
    while len(parts) < 3:
        parts.insert(0, 0.0)
    return parts[0] * 3600 + parts[1] * 60 + parts[2]


class RemoveSilence(MediaBase):
    """Detect silent ranges and cut them out in a single pass."""

    name = "media.remove_silence"
    summary = "Detect and remove silent gaps from a video or audio file."
    parameters = {
        "type": "object",
        "properties": {
            "input": {"type": "string"},
            "output": {"type": "string"},
            "threshold_db": {"type": "number", "default": -32,
                             "description": "Level below which audio counts as silence."},
            "min_silence_s": {"type": "number", "minimum": 0.05, "default": 0.6},
            "padding_s": {"type": "number", "minimum": 0, "default": 0.08,
                          "description": "Keep this much silence around speech, so cuts breathe."},
            "analyze_only": {"type": "boolean", "default": False},
        },
        "required": ["input"],
        "additionalProperties": False,
    }

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        source = ctx.jail.resolve(args["input"], must_exist=True)
        threshold = float(args.get("threshold_db", -32))
        min_silence = float(args.get("min_silence_s", 0.6))
        padding = float(args.get("padding_s", 0.08))
        duration = await _duration(source)
        if duration <= 0:
            raise ToolExecutionError("could not determine media duration")

        await ctx.progress("analysing audio for silence")
        _, analysis = await _run(
            [_binary("ffmpeg"), "-hide_banner", "-nostdin", "-i", str(source),
             "-af", f"silencedetect=noise={threshold}dB:d={min_silence}", "-f", "null", "-"],
            timeout=max(120.0, ctx.remaining_seconds()),
        )
        silences = _parse_silences(analysis, duration)
        keeps = _invert(silences, duration, padding)
        removed = duration - sum(end - start for start, end in keeps)

        report = {
            "input": ctx.jail.relative(source),
            "duration_s": round(duration, 3),
            "silences": [{"start": round(s, 3), "end": round(e, 3)} for s, e in silences[:200]],
            "silence_count": len(silences),
            "removed_s": round(removed, 3),
            "kept_segments": len(keeps),
            "new_duration_s": round(duration - removed, 3),
        }
        if args.get("analyze_only") or not silences:
            return ToolResult.success(
                report,
                summary=(
                    f"found {len(silences)} silent gap(s) totalling {removed:.1f}s"
                    + ("" if args.get("analyze_only") else "; nothing to remove")
                ),
            )
        if not keeps:
            raise ToolExecutionError(
                "the entire file was detected as silence; raise threshold_db and retry"
            )

        destination = ctx.jail.resolve(
            args.get("output") or self._default_output(source, source.suffix, "tightened"),
            write=True,
        )
        destination.parent.mkdir(parents=True, exist_ok=True)
        has_video = source.suffix.lower() in VIDEO_SUFFIXES

        # One expression per stream selects only the keep-ranges; setpts/asetpts
        # then rebuild a continuous timeline so A/V stay locked together.
        ranges = "+".join(f"between(t,{start:.3f},{end:.3f})" for start, end in keeps)
        filters = [f"[0:a]aselect='{ranges}',asetpts=N/SR/TB[a]"]
        maps = ["-map", "[a]"]
        if has_video:
            filters.insert(0, f"[0:v]select='{ranges}',setpts=N/FRAME_RATE/TB[v]")
            maps = ["-map", "[v]", "-map", "[a]"]

        await ctx.progress(f"cutting {len(silences)} silent gap(s)")
        await _ffmpeg(
            ["-i", str(source), "-filter_complex", ";".join(filters), *maps,
             *(["-c:v", "libx264", "-preset", "medium", "-crf", "22", "-pix_fmt", "yuv420p"]
               if has_video else []),
             "-c:a", "aac", "-b:a", "160k", str(destination)],
            ctx,
        )
        report["output"] = ctx.jail.relative(destination)
        report["output_bytes"] = destination.stat().st_size
        return ToolResult.success(
            report,
            summary=(
                f"removed {removed:.1f}s of silence across {len(silences)} gap(s); "
                f"{duration:.1f}s -> {duration - removed:.1f}s"
            ),
            artifacts=[ctx.keep_file(destination)],
        )


def _parse_silences(output: str, duration: float) -> list[tuple[float, float]]:
    starts = [float(m) for m in re.findall(r"silence_start:\s*(-?[\d.]+)", output)]
    ends = [float(m) for m in re.findall(r"silence_end:\s*([\d.]+)", output)]
    spans: list[tuple[float, float]] = []
    for index, start in enumerate(starts):
        end = ends[index] if index < len(ends) else duration
        if end > start:
            spans.append((max(0.0, start), min(duration, end)))
    return spans


def _invert(
    silences: list[tuple[float, float]], duration: float, padding: float
) -> list[tuple[float, float]]:
    """Turn silence spans into the speech spans to keep, padded and merged."""
    keeps: list[tuple[float, float]] = []
    cursor = 0.0
    for start, end in sorted(silences):
        keep_end = min(duration, start + padding)
        if keep_end > cursor:
            keeps.append((cursor, keep_end))
        cursor = max(cursor, max(0.0, end - padding))
    if cursor < duration:
        keeps.append((cursor, duration))

    merged: list[tuple[float, float]] = []
    for start, end in keeps:
        if end - start < 0.02:  # sub-frame slivers create audible clicks
            continue
        if merged and start - merged[-1][1] < 0.02:
            merged[-1] = (merged[-1][0], end)
        else:
            merged.append((start, end))
    return merged


class Concat(MediaBase):
    name = "media.concat"
    summary = "Join multiple media files into one."
    parameters = {
        "type": "object",
        "properties": {
            "inputs": {"type": "array", "items": {"type": "string"}, "minItems": 2},
            "output": {"type": "string"},
            "reencode": {"type": "boolean", "default": True,
                         "description": "Required when inputs differ in codec or resolution."},
        },
        "required": ["inputs", "output"],
        "additionalProperties": False,
    }

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        sources = [ctx.jail.resolve(p, must_exist=True) for p in args["inputs"]]
        destination = ctx.jail.resolve(args["output"], write=True)
        destination.parent.mkdir(parents=True, exist_ok=True)

        if args.get("reencode", True):
            argv: list[str] = []
            for source in sources:
                argv += ["-i", str(source)]
            streams = "".join(f"[{i}:v][{i}:a]" for i in range(len(sources)))
            argv += ["-filter_complex", f"{streams}concat=n={len(sources)}:v=1:a=1[v][a]",
                     "-map", "[v]", "-map", "[a]",
                     "-c:v", "libx264", "-crf", "21", "-pix_fmt", "yuv420p",
                     "-c:a", "aac", "-b:a", "160k", str(destination)]
            await _ffmpeg(argv, ctx)
        else:
            listing = ctx.scratch / f"concat-{(ctx.step_id or 'adhoc')[-8:]}.txt"
            listing.parent.mkdir(parents=True, exist_ok=True)
            listing.write_text(
                "\n".join(f"file '{s.as_posix()}'" for s in sources), encoding="utf-8"
            )
            await _ffmpeg(
                ["-f", "concat", "-safe", "0", "-i", str(listing), "-c", "copy", str(destination)],
                ctx,
            )
        return ToolResult.success(
            {"output": ctx.jail.relative(destination), "inputs": len(sources),
             "bytes": destination.stat().st_size},
            summary=f"joined {len(sources)} file(s) into {destination.name}",
            artifacts=[ctx.keep_file(destination)],
        )


class BurnSubtitles(MediaBase):
    name = "media.subtitles"
    summary = "Burn an SRT subtitle track into a video, or attach it as a soft track."
    parameters = {
        "type": "object",
        "properties": {
            "input": {"type": "string"},
            "subtitles": {"type": "string", "description": "Path to an .srt file."},
            "output": {"type": "string"},
            "mode": {"type": "string", "enum": ["burn", "attach"], "default": "burn"},
            "font_size": {"type": "integer", "minimum": 8, "default": 24},
        },
        "required": ["input", "subtitles"],
        "additionalProperties": False,
    }

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        source = ctx.jail.resolve(args["input"], must_exist=True)
        subtitles = ctx.jail.resolve(args["subtitles"], must_exist=True)
        destination = ctx.jail.resolve(
            args.get("output") or self._default_output(source, source.suffix, "subtitled"),
            write=True,
        )
        destination.parent.mkdir(parents=True, exist_ok=True)
        if args.get("mode", "burn") == "attach":
            await _ffmpeg(
                ["-i", str(source), "-i", str(subtitles), "-c", "copy",
                 "-c:s", "mov_text", "-metadata:s:s:0", "language=eng", str(destination)],
                ctx,
            )
        else:
            # ffmpeg's subtitles filter needs escaping for ':' and '\' in paths.
            escaped = str(subtitles).replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")
            style = (
                f"FontSize={int(args.get('font_size', 24))},"
                "PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=0"
            )
            await _ffmpeg(
                ["-i", str(source), "-vf", f"subtitles='{escaped}':force_style='{style}'",
                 "-c:v", "libx264", "-crf", "21", "-pix_fmt", "yuv420p",
                 "-c:a", "copy", str(destination)],
                ctx,
            )
        return ToolResult.success(
            {"output": ctx.jail.relative(destination), "mode": args.get("mode", "burn")},
            summary=f"{args.get('mode', 'burn')}ed subtitles into {destination.name}",
            artifacts=[ctx.keep_file(destination)],
        )


class ImageEdit(MediaBase):
    name = "media.image"
    summary = "Resize, crop, convert or compress an image."
    tags = ("media", "image", "design")
    parameters = {
        "type": "object",
        "properties": {
            "input": {"type": "string"},
            "output": {"type": "string"},
            "width": {"type": "integer", "minimum": 1},
            "height": {"type": "integer", "minimum": 1},
            "crop": {"type": "string", "description": "w:h:x:y"},
            "quality": {"type": "integer", "minimum": 1, "maximum": 31, "default": 3,
                        "description": "Lower is better quality."},
        },
        "required": ["input"],
        "additionalProperties": False,
    }

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        source = ctx.jail.resolve(args["input"], must_exist=True)
        destination = ctx.jail.resolve(
            args.get("output") or self._default_output(source, source.suffix, "edit"), write=True
        )
        if destination == source:
            raise InvalidArguments("output must differ from input")
        destination.parent.mkdir(parents=True, exist_ok=True)
        filters = []
        if args.get("crop"):
            if not re.fullmatch(r"\d+:\d+:\d+:\d+", str(args["crop"])):
                raise InvalidArguments("crop must be 'w:h:x:y' with integer values")
            filters.append(f"crop={args['crop']}")
        if args.get("width") or args.get("height"):
            width = args.get("width", -2)
            height = args.get("height", -2)
            filters.append(f"scale={width}:{height}")
        argv = ["-i", str(source)]
        if filters:
            argv += ["-vf", ",".join(filters)]
        argv += ["-q:v", str(int(args.get("quality", 3))), str(destination)]
        await _ffmpeg(argv, ctx, timeout=300)
        return ToolResult.success(
            {"output": ctx.jail.relative(destination), "bytes": destination.stat().st_size},
            summary=f"wrote {destination.name}",
            artifacts=[ctx.keep_file(destination)],
        )


def tools() -> list[Tool]:
    return [
        Probe(), Transcode(), Trim(), ExtractAudio(), Thumbnail(),
        RemoveSilence(), Concat(), BurnSubtitles(), ImageEdit(),
    ]


__all__ = ["tools"]
