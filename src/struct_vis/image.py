"""Draw the struct visualizer's bit layout as a picture, without opening a browser yourself.

The picture is the one the page draws. The page is loaded headless, the declaration and the
switches are set, and the diagram is taken exactly as the Copy image button would hand it over.
Nothing here draws anything, so the command and the page cannot drift apart.
"""

from __future__ import annotations

import base64
import re
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

from playwright.sync_api import Browser, Page, sync_playwright

PAGE_PATH = Path(__file__).resolve().parents[2] / "struct-visualizer.html"

ALIGN_WIDTHS = (8, 16, 32, 64)
ROW_WIDTHS = (32, 64)
SYNTAXES = ("auto", "sv", "rdl")
JUSTIFICATIONS = ("msb", "lsb")

_COMMENTS = re.compile(r"//[^\n]*|/\*.*?\*/", re.DOTALL)
_RDL_WORDS = re.compile(r"\b(?:addrmap|regfile)\b")
_SV_WORDS = re.compile(r"\b(?:typedef|struct|union|logic|parameter)\b")
_RDL_REG = re.compile(r"\breg\b\s*[A-Za-z0-9_]*\s*\{")

_CLIPBOARD_PNG = """
async () => {
    const items = await navigator.clipboard.read();
    const holder = items.find(item => item.types.includes("image/png"));
    if (!holder) return "";
    const bytes = new Uint8Array(await (await holder.getType("image/png")).arrayBuffer());
    const chunk = 0x8000;
    let binary = "";
    for (let at = 0; at < bytes.length; at += chunk)
        binary += String.fromCharCode.apply(null, bytes.subarray(at, at + chunk));
    return btoa(binary);
}
"""

_PRESSED_SYNTAX = """() => document.querySelector('#syntax [aria-pressed="true"]').dataset.v"""


class RenderError(RuntimeError):
    """The page could not draw the declaration it was given."""


@dataclass(frozen=True)
class Options:
    """The switches on the page that change what the diagram looks like.

    Attributes:
        syntax: ``sv``, ``rdl``, or ``auto`` to tell from the declaration itself.
        type_name: Which declared type to draw. The page's own choice when None.
        rows: Bits per row of the diagram, 32 or 64.
        flatten: Expand a nested type into its fields rather than drawing one block.
        underscore: Show the names of fields that start with an underscore.
        align: The word an unpacked struct pads each member out to.
        justify: Which end of that word the member sits at.
        width: The browser width in pixels, which sets how wide the diagram is drawn.
    """

    syntax: str = "auto"
    type_name: str | None = None
    rows: int = 32
    flatten: bool = True
    underscore: bool = True
    align: int = 8
    justify: str = "msb"
    width: int = 1400

    def __post_init__(self) -> None:
        """Reject any setting the page has no control for.

        Raises:
            ValueError: If a setting is outside the range the page offers.
        """
        if self.syntax not in SYNTAXES:
            raise ValueError(f"syntax must be one of {SYNTAXES}, not {self.syntax!r}")
        if self.rows not in ROW_WIDTHS:
            raise ValueError(f"rows must be one of {ROW_WIDTHS}, not {self.rows}")
        if self.align not in ALIGN_WIDTHS:
            raise ValueError(f"align must be one of {ALIGN_WIDTHS}, not {self.align}")
        if self.justify not in JUSTIFICATIONS:
            raise ValueError(f"justify must be one of {JUSTIFICATIONS}, not {self.justify!r}")
        if self.width < 400:
            raise ValueError(f"width must be at least 400 pixels, not {self.width}")


@dataclass(frozen=True)
class Drawing:
    """What was drawn.

    Attributes:
        type_name: The type the diagram shows.
        summary: The page's own summary of it, such as ``64 bits``.
        path: Where the picture was written.
        size: The picture's width and height in pixels.
    """

    type_name: str
    summary: str
    path: Path
    size: tuple[int, int]


def detect_syntax(source: str) -> str:
    """Tell whether a declaration is written in SystemVerilog or SystemRDL.

    Args:
        source: The declaration text.

    Returns:
        Either ``sv`` or ``rdl``. SystemVerilog is the answer when nothing points either way,
        since that is what most declarations are.

    Examples:
        >>> detect_syntax("addrmap gpio { reg { field {} a[0:0]; } r @ 0x0; };")
        'rdl'
        >>> detect_syntax("typedef struct packed { logic [3:0] a; } t;")
        'sv'
    """
    bare = _COMMENTS.sub(" ", source)
    if _RDL_WORDS.search(bare):
        return "rdl"
    if _SV_WORDS.search(bare):
        return "sv"
    return "rdl" if _RDL_REG.search(bare) else "sv"


@contextmanager
def _borrowed(browser: Browser | None) -> Iterator[Browser]:
    """A browser to work in: the one given, or one opened for the moment.

    Playwright's synchronous API cannot be started inside another, so anything that already has a
    browser open has to pass it in rather than let one be opened here.

    Args:
        browser: An open browser, or None to open and close one.

    Yields:
        The browser to use.
    """
    if browser is not None:
        yield browser
        return
    with sync_playwright() as play:
        opened = play.chromium.launch()
        try:
            yield opened
        finally:
            opened.close()


def list_types(
    source: str, options: Options, browser: Browser | None = None
) -> list[tuple[str, str]]:
    """The types a declaration offers, with the size of each.

    Args:
        source: The declaration text.
        options: The switches to set before reading the list.
        browser: An open browser to work in. One is opened and closed when None.

    Returns:
        Pairs of type name and the page's summary of it, in the order the page lists them.

    Raises:
        RenderError: If the page could not read the declaration.
    """
    with _borrowed(browser) as instance:
        page = instance.new_page(viewport={"width": options.width, "height": 1200})
        try:
            page.goto(PAGE_PATH.as_uri())
            page.wait_for_timeout(300)
            _apply(page, source, options, choose_type=False)
            found = []
            for name in _type_names(page):
                page.select_option("#root", name)
                page.wait_for_timeout(120)
                found.append((name, (page.text_content("#stampw") or "").strip()))
            return found
        finally:
            page.close()


def render(
    source: str, destination: Path, options: Options, browser: Browser | None = None
) -> Drawing:
    """Draw a declaration's bit layout and write it out as a PNG.

    Args:
        source: The declaration text, SystemVerilog or SystemRDL.
        destination: Where to write the picture.
        options: The switches to set before drawing.
        browser: An open browser to work in. One is opened and closed when None.

    Returns:
        What was drawn and where it went.

    Raises:
        RenderError: If the page could not draw the declaration, or would not part with the
            picture.
    """
    with _borrowed(browser) as instance:
        context = instance.new_context(viewport={"width": options.width, "height": 1200})
        context.grant_permissions(["clipboard-read", "clipboard-write"])
        try:
            page = context.new_page()
            page.goto(PAGE_PATH.as_uri())
            page.wait_for_timeout(300)
            _apply(page, source, options, choose_type=True)

            page.click("#copyimg")
            page.wait_for_timeout(400)
            encoded = page.evaluate(_CLIPBOARD_PNG)
            if not encoded:
                raise RenderError("the browser would not hand the picture over")
            picture = base64.b64decode(encoded)
            destination.write_bytes(picture)

            return Drawing(
                type_name=page.input_value("#root")
                or (page.text_content("#stampname") or "").strip(),
                summary=(page.text_content("#stampw") or "").strip(),
                path=destination,
                size=_png_size(picture),
            )
        finally:
            context.close()


def _apply(page: Page, source: str, options: Options, choose_type: bool) -> None:
    """Put the declaration and every switch into the page, then check it drew something.

    Args:
        page: The loaded visualizer page.
        source: The declaration text.
        options: The switches to set.
        choose_type: Select the requested type. Skipped when only the type list is wanted.

    Raises:
        RenderError: If the declaration would not lay out, or names a type it does not declare.
    """
    syntax = detect_syntax(source) if options.syntax == "auto" else options.syntax
    # the control converts whatever is in the box, so it has to be set before the source is
    if page.evaluate(_PRESSED_SYNTAX) != syntax:
        page.click(f'#syntax [data-v="{syntax}"]')
        page.wait_for_timeout(200)

    page.fill("#src", source)
    page.wait_for_timeout(300)

    page.set_checked("#w64", options.rows == 64)
    page.set_checked("#us", options.underscore)
    page.set_checked("#flat", options.flatten)
    page.click(f'#unit button[data-v="{options.align}"]')
    page.click(f'#just button[data-v="{options.justify}"]')
    page.wait_for_timeout(200)

    if choose_type and options.type_name is not None:
        names = _type_names(page)
        if options.type_name not in names:
            offered = ", ".join(names) if names else "nothing"
            raise RenderError(f"no type named {options.type_name!r}; the source declares {offered}")
        page.select_option("#root", options.type_name)
        page.wait_for_timeout(250)

    # the note is a label and a message; the message is the part worth repeating
    alert = page.query_selector(".note.alert span") or page.query_selector(".note.alert")
    if alert is not None:
        raise RenderError((alert.text_content() or "the page could not lay it out").strip())
    if not _type_names(page):
        raise RenderError("the declaration holds no struct, union or address map to draw")
    if page.eval_on_selector_all(".drow", "rows => rows.length") == 0:
        raise RenderError("the declaration produced no bits to draw")


def _type_names(page: Page) -> list[str]:
    """Every type the page is offering to draw."""
    names: list[str] = page.eval_on_selector_all(
        "#root option", "options => options.map(option => option.value)"
    )
    return names


def _png_size(picture: bytes) -> tuple[int, int]:
    """Read the pixel size out of a PNG header.

    Args:
        picture: The whole PNG file.

    Returns:
        Width and height in pixels.

    Raises:
        RenderError: If the bytes are not a PNG.
    """
    if len(picture) < 24 or picture[:8] != b"\x89PNG\r\n\x1a\n":
        raise RenderError("what came back was not a PNG")
    return (
        int.from_bytes(picture[16:20], "big"),
        int.from_bytes(picture[20:24], "big"),
    )
