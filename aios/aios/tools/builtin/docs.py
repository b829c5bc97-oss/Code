"""Document, report and presentation generation.

Outputs are single-file, self-contained HTML: no build step, no CDN, opens
offline, prints to PDF cleanly, and survives being emailed as an attachment.
That constraint is why the Markdown renderer and the slide engine are written
here rather than pulled in - a document the user cannot open in two years is
not a deliverable.

Typography and spacing follow a small scale rather than ad-hoc values, and both
light and dark rendering are supported, because a report that is unreadable in
the reader's theme is a defect, not a preference.
"""

from __future__ import annotations

import html
import json
import re
from typing import Any

from ...foundation.errors import InvalidArguments
from ...security import capabilities as caps
from ...security.capabilities import RiskLevel
from ...security.policy import ActionRequest
from ..base import Tool, ToolContext, ToolResult

# --------------------------------------------------------------------------
# Markdown -> HTML
# --------------------------------------------------------------------------

_INLINE = (
    (re.compile(r"!\[([^\]]*)\]\(([^)\s]+)(?:\s+\"([^\"]*)\")?\)"),
     lambda m: f'<img src="{html.escape(m.group(2), quote=True)}" alt="{html.escape(m.group(1))}"'
               + (f' title="{html.escape(m.group(3))}"' if m.group(3) else "") + ">"),
    (re.compile(r"\[([^\]]+)\]\(([^)\s]+)\)"),
     lambda m: f'<a href="{html.escape(m.group(2), quote=True)}">{m.group(1)}</a>'),
    (re.compile(r"\*\*\*(.+?)\*\*\*", re.S), lambda m: f"<strong><em>{m.group(1)}</em></strong>"),
    (re.compile(r"\*\*(.+?)\*\*", re.S), lambda m: f"<strong>{m.group(1)}</strong>"),
    (re.compile(r"(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])", re.S), lambda m: f"<em>{m.group(1)}</em>"),
    (re.compile(r"~~(.+?)~~", re.S), lambda m: f"<del>{m.group(1)}</del>"),
)


def render_inline(text: str) -> str:
    """Escape, then apply inline markdown. Code spans are protected first."""
    spans: list[str] = []

    def stash(match: re.Match[str]) -> str:
        spans.append(match.group(1))
        return f"\x00{len(spans) - 1}\x00"

    text = re.sub(r"`([^`]+)`", stash, text)
    text = html.escape(text, quote=False)
    for pattern, replacement in _INLINE:
        text = pattern.sub(replacement, text)
    for index, code in enumerate(spans):
        text = text.replace(f"\x00{index}\x00", f"<code>{html.escape(code)}</code>")
    return text


def markdown_to_html(source: str) -> str:
    """A focused CommonMark subset: the constructs documents actually use."""
    out: list[str] = []
    lines = source.replace("\r\n", "\n").split("\n")
    index = 0
    list_stack: list[str] = []

    def close_lists(to: int = 0) -> None:
        while len(list_stack) > to:
            out.append(f"</{list_stack.pop()}>")

    while index < len(lines):
        line = lines[index]

        if line.strip().startswith("```"):
            language = line.strip()[3:].strip()
            body: list[str] = []
            index += 1
            while index < len(lines) and not lines[index].strip().startswith("```"):
                body.append(lines[index])
                index += 1
            close_lists()
            attr = f' class="language-{html.escape(language, quote=True)}"' if language else ""
            out.append(f"<pre><code{attr}>{html.escape(chr(10).join(body))}</code></pre>")
            index += 1
            continue

        if not line.strip():
            close_lists()
            index += 1
            continue

        if match := re.match(r"^(#{1,6})\s+(.*)$", line):
            close_lists()
            level = len(match.group(1))
            slug = re.sub(r"[^a-z0-9]+", "-", match.group(2).lower()).strip("-")
            out.append(f'<h{level} id="{slug}">{render_inline(match.group(2).strip())}</h{level}>')
            index += 1
            continue

        if re.match(r"^\s*([-*_])\s*\1\s*\1[\s\-*_]*$", line):
            close_lists()
            out.append("<hr>")
            index += 1
            continue

        if line.lstrip().startswith(">"):
            close_lists()
            quote: list[str] = []
            while index < len(lines) and lines[index].lstrip().startswith(">"):
                quote.append(lines[index].lstrip()[1:].lstrip())
                index += 1
            out.append(f"<blockquote>{markdown_to_html(chr(10).join(quote))}</blockquote>")
            continue

        if "|" in line and index + 1 < len(lines) and re.match(r"^[\s|:\-]+$", lines[index + 1]):
            close_lists()
            headers = [c.strip() for c in line.strip().strip("|").split("|")]
            index += 2
            rows: list[list[str]] = []
            while index < len(lines) and "|" in lines[index] and lines[index].strip():
                rows.append([c.strip() for c in lines[index].strip().strip("|").split("|")])
                index += 1
            head = "".join(f"<th>{render_inline(h)}</th>" for h in headers)
            body = "".join(
                "<tr>" + "".join(f"<td>{render_inline(c)}</td>" for c in row) + "</tr>"
                for row in rows
            )
            out.append(f"<div class='table-wrap'><table><thead><tr>{head}</tr></thead>"
                       f"<tbody>{body}</tbody></table></div>")
            continue

        if match := re.match(r"^(\s*)([-*+]|\d+[.)])\s+(.*)$", line):
            indent = len(match.group(1)) // 2 + 1
            ordered = match.group(2) not in {"-", "*", "+"}
            tag = "ol" if ordered else "ul"
            while len(list_stack) > indent:
                out.append(f"</{list_stack.pop()}>")
            while len(list_stack) < indent:
                list_stack.append(tag)
                out.append(f"<{tag}>")
            out.append(f"<li>{render_inline(match.group(3))}</li>")
            index += 1
            continue

        close_lists()
        paragraph: list[str] = []
        while index < len(lines) and lines[index].strip() and not re.match(
            r"^(#{1,6}\s|```|>|\s*([-*+]|\d+[.)])\s)", lines[index]
        ):
            paragraph.append(lines[index].strip())
            index += 1
        out.append(f"<p>{render_inline(' '.join(paragraph))}</p>")

    close_lists()
    return "\n".join(out)


_DOCUMENT_CSS = """
:root{color-scheme:light dark;--fg:#16181d;--muted:#5b6270;--bg:#ffffff;--surface:#f6f7f9;
--border:#e2e5ea;--accent:#3350e8;--code-bg:#f2f3f7;--maxw:74ch}
@media (prefers-color-scheme:dark){:root{--fg:#e6e9f0;--muted:#98a0b0;--bg:#0f1116;
--surface:#171a21;--border:#272b35;--accent:#8ea2ff;--code-bg:#161920}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
font:16px/1.65 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
-webkit-font-smoothing:antialiased}
main{max-width:var(--maxw);margin:0 auto;padding:4rem 1.5rem 6rem}
h1,h2,h3,h4{line-height:1.25;margin:2.2em 0 .6em;font-weight:650;letter-spacing:-.011em}
h1{font-size:2.1rem;margin-top:0} h2{font-size:1.5rem} h3{font-size:1.18rem} h4{font-size:1rem}
p,ul,ol,blockquote,pre,.table-wrap{margin:0 0 1.1em}
ul,ol{padding-left:1.4em} li{margin:.3em 0}
a{color:var(--accent);text-decoration-thickness:1px;text-underline-offset:2px}
code{background:var(--code-bg);padding:.15em .38em;border-radius:4px;
font:.88em/1.5 ui-monospace,"SF Mono",Menlo,Consolas,monospace}
pre{background:var(--code-bg);border:1px solid var(--border);border-radius:10px;
padding:1rem 1.1rem;overflow-x:auto}
pre code{background:none;padding:0;font-size:.85rem;line-height:1.6}
blockquote{border-left:3px solid var(--accent);padding:.1em 0 .1em 1.1em;color:var(--muted)}
.table-wrap{overflow-x:auto;border:1px solid var(--border);border-radius:10px}
table{border-collapse:collapse;width:100%;font-size:.94rem}
th,td{padding:.6em .85em;text-align:left;border-bottom:1px solid var(--border)}
th{background:var(--surface);font-weight:620}
tbody tr:last-child td{border-bottom:none}
hr{border:0;border-top:1px solid var(--border);margin:2.5em 0}
img{max-width:100%;height:auto;border-radius:8px}
.doc-meta{color:var(--muted);font-size:.9rem;margin:-.5rem 0 2.5rem}
@media print{body{background:#fff;color:#000}main{padding:0;max-width:none}pre,.table-wrap{break-inside:avoid}}
"""


def _document_shell(title: str, body: str, subtitle: str = "") -> str:
    meta = f'<p class="doc-meta">{html.escape(subtitle)}</p>' if subtitle else ""
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(title)}</title>
<style>{_DOCUMENT_CSS}</style>
</head>
<body><main>{meta}{body}</main></body>
</html>
"""


class RenderDocument(Tool):
    name = "doc.render"
    summary = "Render Markdown into a self-contained, print-ready HTML document."
    tags = ("document", "write", "create", "content")
    capabilities = frozenset({caps.FS_WRITE})
    risk = RiskLevel.LOW
    parameters = {
        "type": "object",
        "properties": {
            "markdown": {"type": "string", "minLength": 1},
            "output": {"type": "string"},
            "title": {"type": "string", "default": "Document"},
            "subtitle": {"type": "string", "default": ""},
        },
        "required": ["markdown", "output"],
        "additionalProperties": False,
    }

    def plan_action(self, args: dict[str, Any]) -> ActionRequest:
        action = super().plan_action(args)
        action.paths = [str(args.get("output", ""))]
        return action

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        destination = ctx.jail.resolve(args["output"], write=True)
        destination.parent.mkdir(parents=True, exist_ok=True)
        body = markdown_to_html(args["markdown"])
        page = _document_shell(args.get("title", "Document"), body, args.get("subtitle", ""))
        destination.write_text(page, encoding="utf-8")
        words = len(re.findall(r"\w+", args["markdown"]))
        return ToolResult.success(
            {"path": ctx.jail.relative(destination), "bytes": destination.stat().st_size,
             "words": words, "reading_minutes": max(1, round(words / 220))},
            summary=f"rendered {words}-word document to {destination.name}",
            artifacts=[ctx.keep_file(destination)],
        )


_DECK_CSS = """
:root{--fg:#f2f4f8;--muted:#9aa3b5;--bg:#0d0f14;--accent:#7c93ff;--surface:#161a22;
--border:#262b36}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);overflow:hidden;
font:400 16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.deck{position:relative;width:100vw;height:100vh}
.slide{position:absolute;inset:0;display:none;flex-direction:column;justify-content:center;
padding:clamp(2rem,7vw,7rem);gap:1.1rem;animation:fade .32s ease}
.slide.active{display:flex}
@keyframes fade{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.slide h1{font-size:clamp(2rem,5.5vw,4rem);line-height:1.06;margin:0;letter-spacing:-.025em;
font-weight:680}
.slide h2{font-size:clamp(1.5rem,3.4vw,2.5rem);line-height:1.15;margin:0;letter-spacing:-.018em;
font-weight:650}
.slide .kicker{color:var(--accent);font-size:.82rem;letter-spacing:.16em;text-transform:uppercase;
font-weight:600}
.slide ul{margin:.6rem 0 0;padding-left:1.3em;font-size:clamp(1rem,1.7vw,1.4rem)}
.slide li{margin:.55em 0;color:#dfe4ee}
.slide p{font-size:clamp(1rem,1.7vw,1.35rem);color:var(--muted);max-width:60ch;margin:0}
.slide.title{align-items:flex-start;justify-content:center;
background:radial-gradient(80rem 40rem at 12% 0%,rgba(124,147,255,.16),transparent 62%)}
.notes{display:none}
.chrome{position:fixed;bottom:1.1rem;right:1.4rem;display:flex;gap:.7rem;align-items:center;
color:var(--muted);font-size:.8rem;font-variant-numeric:tabular-nums}
.chrome button{background:var(--surface);border:1px solid var(--border);color:var(--fg);
border-radius:7px;width:2rem;height:2rem;cursor:pointer;font-size:1rem;line-height:1}
.chrome button:hover{border-color:var(--accent)}
.progress{position:fixed;top:0;left:0;height:2px;background:var(--accent);transition:width .3s}
table{border-collapse:collapse;font-size:clamp(.85rem,1.3vw,1.05rem)}
th,td{padding:.5em .8em;border-bottom:1px solid var(--border);text-align:left}
@media print{.slide{display:flex;position:static;height:100vh;page-break-after:always}
.chrome,.progress{display:none}}
"""

_DECK_JS = """
const slides=[...document.querySelectorAll('.slide')];let index=0;
const progress=document.querySelector('.progress');
const counter=document.querySelector('.counter');
function show(next){index=Math.max(0,Math.min(slides.length-1,next));
slides.forEach((s,i)=>s.classList.toggle('active',i===index));
progress.style.width=((index+1)/slides.length*100)+'%';
counter.textContent=(index+1)+' / '+slides.length;
location.hash='#'+(index+1);}
document.addEventListener('keydown',e=>{
if(['ArrowRight','ArrowDown',' ','PageDown','n'].includes(e.key)){e.preventDefault();show(index+1);}
if(['ArrowLeft','ArrowUp','PageUp','p'].includes(e.key)){e.preventDefault();show(index-1);}
if(e.key==='Home')show(0); if(e.key==='End')show(slides.length-1);
if(e.key==='f')document.documentElement.requestFullscreen?.();});
document.querySelector('.prev').onclick=()=>show(index-1);
document.querySelector('.next').onclick=()=>show(index+1);
show(parseInt(location.hash.slice(1))-1||0);
"""


class BuildPresentation(Tool):
    """Turn a structured outline into a keyboard-driven, self-contained deck."""

    name = "doc.presentation"
    summary = "Build a self-contained HTML slide deck from a structured outline."
    tags = ("document", "presentation", "write", "create", "content")
    capabilities = frozenset({caps.FS_WRITE})
    risk = RiskLevel.LOW
    parameters = {
        "type": "object",
        "properties": {
            "output": {"type": "string"},
            "title": {"type": "string"},
            "subtitle": {"type": "string", "default": ""},
            "slides": {
                "type": "array",
                "minItems": 1,
                "items": {
                    "type": "object",
                    "properties": {
                        "kicker": {"type": "string"},
                        "heading": {"type": "string"},
                        "body": {"type": "string"},
                        "bullets": {"type": "array", "items": {"type": "string"}},
                        "notes": {"type": "string"},
                        "layout": {"type": "string", "enum": ["title", "content", "statement"],
                                   "default": "content"},
                    },
                    "required": ["heading"],
                    "additionalProperties": False,
                },
            },
        },
        "required": ["output", "title", "slides"],
        "additionalProperties": False,
    }

    def plan_action(self, args: dict[str, Any]) -> ActionRequest:
        action = super().plan_action(args)
        action.paths = [str(args.get("output", ""))]
        action.summary = f"build a {len(args.get('slides') or [])}-slide deck"
        return action

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        destination = ctx.jail.resolve(args["output"], write=True)
        destination.parent.mkdir(parents=True, exist_ok=True)
        title = args["title"]

        sections = [
            f'<section class="slide title"><span class="kicker">{html.escape(args.get("subtitle", "") or "Presentation")}</span>'
            f"<h1>{html.escape(title)}</h1></section>"
        ]
        for slide in args["slides"]:
            layout = slide.get("layout", "content")
            parts = []
            if slide.get("kicker"):
                parts.append(f'<span class="kicker">{html.escape(slide["kicker"])}</span>')
            tag = "h1" if layout in {"title", "statement"} else "h2"
            parts.append(f"<{tag}>{render_inline(slide['heading'])}</{tag}>")
            if slide.get("body"):
                parts.append(f"<p>{render_inline(slide['body'])}</p>")
            if slide.get("bullets"):
                items = "".join(f"<li>{render_inline(b)}</li>" for b in slide["bullets"])
                parts.append(f"<ul>{items}</ul>")
            if slide.get("notes"):
                parts.append(f'<div class="notes">{html.escape(slide["notes"])}</div>')
            sections.append(f'<section class="slide {html.escape(layout)}">{"".join(parts)}</section>')

        page = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(title)}</title>
<style>{_DECK_CSS}</style>
</head>
<body>
<div class="progress"></div>
<div class="deck">{"".join(sections)}</div>
<div class="chrome"><button class="prev" aria-label="Previous slide">‹</button>
<button class="next" aria-label="Next slide">›</button><span class="counter"></span></div>
<script>{_DECK_JS}</script>
</body>
</html>
"""
        destination.write_text(page, encoding="utf-8")
        count = len(sections)
        return ToolResult.success(
            {"path": ctx.jail.relative(destination), "slides": count,
             "bytes": destination.stat().st_size},
            summary=f"built a {count}-slide deck at {destination.name}",
            artifacts=[ctx.keep_file(destination)],
        )


class WriteReport(Tool):
    """Compose a structured report from sections plus optional data tables."""

    name = "doc.report"
    summary = "Compose a structured report (summary, findings, data tables) as Markdown + HTML."
    tags = ("document", "write", "create", "content", "analysis")
    capabilities = frozenset({caps.FS_WRITE})
    risk = RiskLevel.LOW
    parameters = {
        "type": "object",
        "properties": {
            "output": {"type": "string"},
            "title": {"type": "string"},
            "summary": {"type": "string", "default": ""},
            "sections": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "heading": {"type": "string"},
                        "body": {"type": "string"},
                        "table": {"type": "array", "items": {"type": "object"}},
                    },
                    "required": ["heading"],
                    "additionalProperties": False,
                },
            },
        },
        "required": ["output", "title"],
        "additionalProperties": False,
    }

    def plan_action(self, args: dict[str, Any]) -> ActionRequest:
        action = super().plan_action(args)
        action.paths = [str(args.get("output", ""))]
        return action

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        destination = ctx.jail.resolve(args["output"], write=True)
        destination.parent.mkdir(parents=True, exist_ok=True)

        lines = [f"# {args['title']}", ""]
        if args.get("summary"):
            lines += ["## Summary", "", args["summary"], ""]
        for section in args.get("sections") or []:
            lines += [f"## {section['heading']}", ""]
            if section.get("body"):
                lines += [section["body"], ""]
            if section.get("table"):
                lines += [_markdown_table(section["table"]), ""]
        markdown = "\n".join(lines)

        artifacts = []
        if destination.suffix.lower() in {".html", ".htm"}:
            destination.write_text(
                _document_shell(args["title"], markdown_to_html(markdown), args.get("summary", "")[:160]),
                encoding="utf-8",
            )
        else:
            destination.write_text(markdown, encoding="utf-8")
            companion = destination.with_suffix(".html")
            companion.write_text(
                _document_shell(args["title"], markdown_to_html(markdown)), encoding="utf-8"
            )
            artifacts.append(ctx.keep_file(companion))
        artifacts.insert(0, ctx.keep_file(destination))
        return ToolResult.success(
            {"path": ctx.jail.relative(destination), "sections": len(args.get("sections") or []),
             "words": len(re.findall(r"\w+", markdown))},
            summary=f"wrote report {destination.name} ({len(args.get('sections') or [])} sections)",
            artifacts=artifacts,
        )


def _markdown_table(rows: list[dict[str, Any]]) -> str:
    if not rows:
        return ""
    headers: list[str] = []
    for row in rows:
        for key in row:
            if key not in headers:
                headers.append(key)
    out = ["| " + " | ".join(headers) + " |", "|" + "|".join(["---"] * len(headers)) + "|"]
    for row in rows[:500]:
        out.append(
            "| " + " | ".join(str(row.get(h, "")).replace("|", "\\|") for h in headers) + " |"
        )
    return "\n".join(out)


class ExtractText(Tool):
    """Pull plain text out of common document formats without extra dependencies."""

    name = "doc.extract"
    summary = "Extract text from txt/md/html/json/csv/docx files."
    tags = ("document", "read", "inspect", "content")
    capabilities = frozenset({caps.FS_READ})
    risk = RiskLevel.SAFE
    parameters = {
        "type": "object",
        "properties": {
            "path": {"type": "string"},
            "max_chars": {"type": "integer", "minimum": 100, "default": 100000},
        },
        "required": ["path"],
        "additionalProperties": False,
    }

    def plan_action(self, args: dict[str, Any]) -> ActionRequest:
        action = super().plan_action(args)
        action.paths = [str(args.get("path", ""))]
        return action

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        path = ctx.jail.resolve(args["path"], must_exist=True)
        limit = int(args.get("max_chars", 100_000))
        suffix = path.suffix.lower()

        if suffix == ".docx":
            text = _docx_text(path)
        elif suffix in {".html", ".htm"}:
            from .net import _TextExtractor

            parser = _TextExtractor()
            parser.feed(path.read_text("utf-8", errors="replace"))
            text = parser.text()
        elif suffix == ".json":
            text = json.dumps(json.loads(path.read_text("utf-8", errors="replace")), indent=2)
        elif suffix == ".pdf":
            raise InvalidArguments(
                "PDF extraction needs an external extractor; convert with "
                "`pdftotext` via shell.run, or install the `data` extra."
            )
        else:
            text = path.read_text("utf-8", errors="replace")

        text = text[:limit]
        return ToolResult.success(
            {"path": ctx.jail.relative(path), "text": text, "chars": len(text),
             "words": len(re.findall(r"\w+", text))},
            summary=f"extracted {len(text)} chars from {path.name}",
        )


def _docx_text(path: Any) -> str:
    """docx is a zip of XML; paragraphs are <w:p> and runs are <w:t>."""
    import zipfile

    with zipfile.ZipFile(path) as archive:
        xml = archive.read("word/document.xml").decode("utf-8", "replace")
    xml = re.sub(r"</w:p>", "\n", xml)
    xml = re.sub(r"<w:tab[^>]*/>", "\t", xml)
    text = re.sub(r"<[^>]+>", "", xml)
    return html.unescape(text).strip()


def tools() -> list[Tool]:
    return [RenderDocument(), BuildPresentation(), WriteReport(), ExtractText()]


__all__ = ["markdown_to_html", "render_inline", "tools"]
