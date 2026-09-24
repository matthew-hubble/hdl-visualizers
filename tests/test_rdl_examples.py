"""Check the register visualizer against systemrdl-compiler.

Every example the page ships is loaded in a real browser and put through the reference compiler as
well. Two things are asserted for each: the source is SystemRDL that elaborates, and the bits the
page draws each field in are the bits the compiler puts it in, once the register addresses are laid
end to end the way the page reads them. The values are then checked the same way, so a field shows
the bits of the vector that its own register and offset own.

The example sources are read from the running page rather than copied here, so the test exercises
what actually ships.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Iterator
from pathlib import Path
from typing import TypedDict, cast

import pytest
from playwright.sync_api import Browser, ConsoleMessage, Page
from systemrdl.compiler import RDLCompiler
from systemrdl.messages import MessagePrinter, RDLCompileError
from systemrdl.node import RegNode

logger = logging.getLogger(__name__)

PAGE_PATH = Path(__file__).resolve().parent.parent / "rdl-visualizer.html"

EXAMPLE_ENTRY = re.compile(r'^\s*\["([^"]+)",', re.MULTILINE)
BIT_RANGE = re.compile(r"^\[(\d+)(?::(\d+))?\]$")
INVENTED_RESERVED = re.compile(r"^_rsvd\d+$")
"""Reserved members the page invents for bits no field claimed. Not fields."""

PATTERN = 0x0123456789ABCDEF
"""The value the page opens a vector on, repeated up it in 64-bit words."""

STATE_JS = """
() => ({
    source: document.getElementById("src").value,
    drawn: document.getElementById("stampname").textContent,
    width: document.getElementById("stampw").textContent,
    notes: document.getElementById("notes").textContent,
    fields: [...document.querySelectorAll("#vtbody tr")].map(row => ({
        name: row.children[0].textContent.trim(),
        bits: row.children[1].textContent.trim(),
        hex: row.children[3].querySelector("input").value,
    })),
    vector: document.getElementById("v-hex").textContent,
})
"""


class FieldRow(TypedDict):
    """One row of the value table: which bits a field holds, and what it holds."""

    name: str
    bits: str
    hex: str


class PageState(TypedDict):
    """What the page reports about itself, as gathered by STATE_JS."""

    source: str
    drawn: str
    width: str
    notes: str
    fields: list[FieldRow]
    vector: str


def read_example_labels() -> list[str]:
    """Read the example button labels out of the page source.

    Returns:
        The labels in the order the page lists them.

    Raises:
        AssertionError: If the example table cannot be found in the page.
    """
    text = PAGE_PATH.read_text(encoding="utf-8")
    assert "const EXAMPLES = [" in text, f"no example table in {PAGE_PATH.name}"
    table = text.split("const EXAMPLES = [", 1)[1].split("\n  ];", 1)[0]
    labels = EXAMPLE_ENTRY.findall(table)
    assert labels, "the example table held no labels"
    return labels


EXAMPLE_LABELS = read_example_labels()


class QuietPrinter(MessagePrinter):
    """A systemrdl-compiler printer that keeps its findings off the console."""

    def emit_message(self, lines: list[str]) -> None:
        """Swallow a compiler message; the exception carries what the test needs."""
        return


def _is_script_error(message: ConsoleMessage) -> bool:
    """Whether a console error came from the page's own script rather than from the network.

    The pages ask a font service for their typefaces, and a request that does not arrive is
    logged as an error too. No test here turns on whether a web font was reachable, so only the
    page's own complaints count.

    Args:
        message: A console message from the page.

    Returns:
        True when the page reported something wrong with itself.
    """
    return message.type == "error" and not message.text.startswith("Failed to load resource")


@pytest.fixture
def page(browser: Browser) -> Iterator[Page]:
    """A freshly loaded register visualizer, checked for script errors on the way out."""
    errors: list[str] = []
    sheet = browser.new_page(viewport={"width": 1400, "height": 1400})
    sheet.on("pageerror", lambda exc: errors.append(str(exc)))
    sheet.on(
        "console",
        lambda msg: errors.append(f"console: {msg.text}") if _is_script_error(msg) else None,
    )
    sheet.goto(PAGE_PATH.as_uri())
    sheet.wait_for_timeout(500)
    yield sheet
    sheet.close()
    assert not errors, f"the page reported {errors}"


def load_example(page: Page, label: str) -> PageState:
    """Press an example button and return the page state once it has settled.

    Args:
        page: The loaded visualizer page.
        label: The text on the example button.

    Returns:
        The state reported by STATE_JS.
    """
    page.click(f'#presets button:text-is("{label}")')
    page.wait_for_timeout(250)
    return cast(PageState, page.evaluate(STATE_JS))


def model_spans(source: str, top: str, work: Path) -> list[tuple[int, int]]:
    """Where the reference compiler puts every field of one address map, in vector bits.

    The page lays the registers end to end with offset 0 at the bottom, so a field sits at its
    register's byte address times eight, plus its own offset inside that register.

    Args:
        source: The SystemRDL to compile.
        top: The name of the component the page drew.
        work: A directory to write the source into.

    Returns:
        One (msb, lsb) pair per field, sorted.

    Raises:
        AssertionError: If the source does not elaborate.
    """
    path = work / "example.rdl"
    path.write_text(source, encoding="utf-8")
    compiler = RDLCompiler(message_printer=QuietPrinter())
    try:
        compiler.compile_file(str(path))
        root = compiler.elaborate(top_def_name=top).top
    except RDLCompileError as exc:
        logger.error("systemrdl-compiler rejected %s in %s", top, path)
        pytest.fail(f"{top} did not elaborate: {exc}")
    return sorted(
        (node.absolute_address * 8 + field.msb, node.absolute_address * 8 + field.lsb)
        for node in root.descendants(unroll=True)
        if isinstance(node, RegNode)
        for field in node.fields()
    )


def page_spans(state: PageState) -> list[tuple[int, int]]:
    """Where the page draws every declared field, in vector bits.

    Args:
        state: The state the page reported.

    Returns:
        One (msb, lsb) pair per field, sorted, with the reserved runs left out.

    Raises:
        AssertionError: If a bit range cannot be read.
    """
    return sorted(span(row["bits"]) for row in state["fields"] if not reserved(row["name"]))


def reserved(name: str) -> bool:
    """Whether a value table row is a run of bits no field claimed.

    Args:
        name: The name in the field column.

    Returns:
        True for the reserved members the page invents.
    """
    return bool(INVENTED_RESERVED.match(name))


def span(bits: str) -> tuple[int, int]:
    """Read a bit range as the tables write it.

    Args:
        bits: A range such as ``[31:16]`` or ``[7]``.

    Returns:
        The most and least significant bit it covers.

    Raises:
        AssertionError: If the range cannot be read.
    """
    found = BIT_RANGE.match(bits)
    assert found, f"unreadable bit range {bits!r}"
    high = int(found.group(1))
    low = int(found.group(2)) if found.group(2) is not None else high
    return high, low


def seeded(width: int) -> int:
    """The value the page opens a vector of this width on.

    Args:
        width: How many bits the vector holds.

    Returns:
        The pattern, repeated up the vector and cut to its width.
    """
    whole = 0
    for at in range(0, width, 64):
        whole |= PATTERN << at
    return whole & ((1 << width) - 1)


def test_example_labels_match_the_page(page: Page) -> None:
    """The labels read from the page source are the buttons the page renders."""
    # Arrange / Act
    rendered = cast(
        list[str],
        page.eval_on_selector_all(
            "#presets button", "buttons => buttons.map(b => b.textContent.trim())"
        ),
    )

    # Assert
    assert rendered == EXAMPLE_LABELS


@pytest.mark.parametrize("label", EXAMPLE_LABELS)
def test_every_example_is_systemrdl_the_compiler_accepts(
    page: Page, label: str, tmp_path: Path
) -> None:
    """An example elaborates, and its fields land where the compiler says they do.

    Args:
        page: The loaded visualizer page.
        label: The text on the example button.
        tmp_path: Where to write the source for the compiler.
    """
    # Arrange
    state = load_example(page, label)
    assert state["source"], f"{label} loaded nothing"
    assert "Layout" not in state["notes"], f"{label} did not lay out: {state['notes']}"

    # Act
    drawn = page_spans(state)
    modelled = model_spans(state["source"], state["drawn"], tmp_path)

    # Assert
    assert drawn, f"{label} drew no fields"
    assert drawn == modelled, f"{label} draws fields the compiler places elsewhere"


@pytest.mark.parametrize("label", EXAMPLE_LABELS)
def test_a_field_holds_the_bits_of_the_vector_it_owns(page: Page, label: str) -> None:
    """Each field shows the bits of the whole vector that its own range covers.

    Args:
        page: The loaded visualizer page.
        label: The text on the example button.
    """
    # Arrange
    state = load_example(page, label)
    width = int(state["width"].split()[0])
    whole = seeded(width)

    # Act
    shown = {row["name"]: int(row["hex"], 16) for row in state["fields"]}
    expected = {
        row["name"]: (whole >> span(row["bits"])[1]) & ((1 << bits_in(row["bits"])) - 1)
        for row in state["fields"]
    }

    # Assert
    assert int(state["vector"], 16) == whole, "the vector did not open on the pattern"
    assert shown == expected, f"{label} shows a field bits it does not own"


def bits_in(bits: str) -> int:
    """How many bits a range covers.

    Args:
        bits: A range such as ``[31:16]`` or ``[7]``.

    Returns:
        The width in bits.
    """
    high, low = span(bits)
    return high - low + 1
