"""Round-trip every example shipped on the struct visualizer page.

Each example button is loaded in a real browser, converted to the other syntax by the page's own
Source syntax control, and converted back. Three things are asserted: the bits every field occupies
do not move, the SystemRDL the page generates compiles with systemrdl-compiler, and the
SystemVerilog it generates lints with Verilator, which is also asked to confirm every width.

The example sources are read from the running page rather than copied here, so the test exercises
what actually ships.
"""

from __future__ import annotations

import logging
import re
import shutil
import subprocess
from collections.abc import Iterator
from pathlib import Path
from typing import TypedDict, cast

import pytest
from playwright.sync_api import Browser, Page, sync_playwright
from systemrdl.compiler import RDLCompiler
from systemrdl.messages import MessagePrinter, RDLCompileError

logger = logging.getLogger(__name__)

PAGE_PATH = Path(__file__).resolve().parent.parent / "struct-visualizer.html"
PAD_MARK = "\u2014"
"""The field table writes this in the name column of a padding row."""

INVENTED_RESERVED = re.compile(r"(^|\.)_rsvd\d+$")
"""Reserved members the page invents for bits no field claimed. Not fields."""

EXAMPLE_ENTRY = re.compile(r'^\s*\["([^"]+)",', re.MULTILINE)
ADDRMAP_NAME = re.compile(r"^addrmap ([A-Za-z0-9_]+) \{$", re.MULTILINE)
SV_TYPEDEF_END = re.compile(r"^\} ([A-Za-z0-9_]+);$", re.MULTILINE)
SV_MEMBER = re.compile(r"^ {2}logic(?: \[(\d+):0\])? +([A-Za-z0-9_$]+);", re.MULTILINE)
BIT_RANGE = re.compile(r"^\[(\d+)(?::(\d+))?\]$")

FIELD_BITS_JS = """
async (everyType) => {
    const sel = document.getElementById("root");
    const names = everyType ? [...sel.options].map(o => o.value) : [sel.value];
    const was = sel.value;
    const out = [];
    for (const name of names) {
        if (sel.value !== name) {
            sel.value = name;
            sel.dispatchEvent(new Event("change", {bubbles: true}));
            await new Promise(done => setTimeout(done, 40));
        }
        [...document.querySelectorAll("#ftbody tr")].forEach(row => {
            const cell = [...row.children].map(c => c.textContent.trim());
            out.push({name: cell[0], bits: cell[2]});
        });
    }
    if (sel.value !== was) {
        sel.value = was;
        sel.dispatchEvent(new Event("change", {bubbles: true}));
        await new Promise(done => setTimeout(done, 40));
    }
    return out;
}
"""

STATE_JS = """
() => ({
    syntax: document.querySelector('#syntax [aria-pressed="true"]').dataset.v,
    source: document.getElementById("src").value,
    generated: document.getElementById("pane-rdl").textContent,
    width: document.getElementById("stampw").textContent,
    drawn: document.getElementById("root").value,
    types: [...document.getElementById("root").options].map(o => o.value),
    notes: document.getElementById("notes").textContent,
})
"""


class PageState(TypedDict):
    """What the page reports about itself, as gathered by STATE_JS."""

    syntax: str
    source: str
    generated: str
    width: str
    drawn: str
    types: list[str]
    notes: str


class FieldRow(TypedDict):
    """One row of the field table."""

    name: str
    bits: str


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


@pytest.fixture(scope="session")
def browser() -> Iterator[Browser]:
    """A headless browser shared by every test in the session."""
    with sync_playwright() as play:
        instance = play.chromium.launch()
        yield instance
        instance.close()


@pytest.fixture
def page(browser: Browser) -> Iterator[Page]:
    """A freshly loaded page, checked for script errors on the way out."""
    errors: list[str] = []
    sheet = browser.new_page(viewport={"width": 1400, "height": 1200})
    sheet.on("pageerror", lambda exc: errors.append(str(exc)))
    sheet.on(
        "console",
        lambda msg: errors.append(f"console: {msg.text}") if msg.type == "error" else None,
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


def switch_syntax(page: Page, target: str) -> PageState:
    """Press the Source syntax control and return the page state afterwards.

    Args:
        page: The loaded visualizer page.
        target: Either ``sv`` or ``rdl``.

    Returns:
        The state reported by STATE_JS.
    """
    page.click(f'#syntax [data-v="{target}"]')
    page.wait_for_timeout(350)
    return cast(PageState, page.evaluate(STATE_JS))


def field_bits(page: Page, every_type: bool = False) -> list[str]:
    """The bits each real field occupies, sorted so two layouts can be compared.

    Padding rows and the reserved members the page invents for unclaimed bits are left out: they
    are consequences of the layout, not fields of it.

    Args:
        page: The loaded visualizer page.
        every_type: Walk the whole type list rather than only the type on screen. A union arrives
            as one type and leaves as an address map per member, so the comparison needs both.

    Returns:
        The sorted bit ranges, such as ``["[15:0]", "[31:16]"]``.
    """
    rows = cast(list[FieldRow], page.evaluate(FIELD_BITS_JS, every_type))
    return sorted(
        row["bits"]
        for row in rows
        if row["name"] != PAD_MARK and not INVENTED_RESERVED.search(row["name"])
    )


def squash(name: str) -> str:
    """Reduce a field name to the identifier every language would spell it as.

    SystemVerilog has no dots and SystemRDL has neither dots nor brackets, so ``ctrl.cmd`` and
    ``slot[3].lo`` are written ``ctrl_cmd`` and ``slot_3_lo``. Comparing the squashed forms lets a
    round trip be checked without those forced changes counting as differences.

    Args:
        name: A field name as the field table shows it.

    Returns:
        The name as an identifier.
    """
    return re.sub(r"[^0-9A-Za-z_]+", "_", name.replace("]", ""))


def field_names(page: Page, every_type: bool = False) -> list[str]:
    """The squashed name of every real field, sorted so two layouts can be compared.

    Args:
        page: The loaded visualizer page.
        every_type: Walk the whole type list rather than only the type on screen.

    Returns:
        The sorted names.
    """
    rows = cast(list[FieldRow], page.evaluate(FIELD_BITS_JS, every_type))
    return sorted(
        squash(row["name"])
        for row in rows
        if row["name"] != PAD_MARK and not INVENTED_RESERVED.search(row["name"])
    )


def view_count(page: Page) -> int:
    """How many vectors the diagram is drawing, which is one per union member."""
    return cast(int, page.eval_on_selector_all(".view", "views => views.length")) or 1


def compile_systemrdl(text: str, work: Path) -> None:
    """Elaborate every address map in some SystemRDL, raising if any of it is rejected.

    Args:
        text: The SystemRDL source.
        work: A directory to write the source into.

    Raises:
        AssertionError: If the source declares no address map, or fails to elaborate.
    """
    tops = ADDRMAP_NAME.findall(text)
    assert tops, "the generated SystemRDL declared no addrmap"
    source = work / "generated.rdl"
    source.write_text(text, encoding="utf-8")
    for top in tops:
        compiler = RDLCompiler(message_printer=QuietPrinter())
        try:
            compiler.compile_file(str(source))
            compiler.elaborate(top_def_name=top)
        except RDLCompileError as exc:
            logger.error("systemrdl-compiler rejected %s in %s", top, source)
            pytest.fail(f"{top} did not elaborate: {exc}")


def lint_systemverilog(text: str, work: Path) -> None:
    """Lint some SystemVerilog, asking Verilator to confirm every declared width.

    Each typedef is instantiated and checked with an elaboration-time assertion, so Verilator has
    to agree on the width of the type and of every member for the lint to pass.

    Args:
        text: The SystemVerilog source, one or more packed typedefs.
        work: A directory to write the source into.

    Raises:
        AssertionError: If the source declares no typedef, or Verilator rejects it.
    """
    verilator = shutil.which("verilator")
    if verilator is None:
        pytest.skip("verilator is not installed")

    types = SV_TYPEDEF_END.findall(text)
    assert types, "the generated SystemVerilog declared no typedef"

    lines = ["module gen_check;", *(f"  {line}" for line in text.splitlines())]
    for index, name in enumerate(types):
        widths = _member_widths(text, name)
        total = sum(widths.values())
        lines.append(f"  {name} probe{index};")
        lines.append(f'  if ($bits({name}) != {total}) $error("{name} is %0d", $bits({name}));')
        for member, width in widths.items():
            lines.append(
                f"  if ($bits(probe{index}.{member}) != {width}) "
                f'$error("{name}.{member} is %0d", $bits(probe{index}.{member}));'
            )
    lines.append("endmodule")

    source = work / "gen_check.sv"
    source.write_text("\n".join(lines) + "\n", encoding="utf-8")
    done = subprocess.run(
        [verilator, "--lint-only", "-sv", str(source)],
        capture_output=True,
        text=True,
        check=False,
    )
    if done.returncode != 0:
        logger.error("verilator rejected %s", source)
        pytest.fail(done.stderr.strip()[:600])


def _member_widths(text: str, type_name: str) -> dict[str, int]:
    """The declared width of each member of one typedef in generated SystemVerilog.

    Args:
        text: The whole generated source.
        type_name: The typedef to read, without its trailing semicolon.

    Returns:
        Member name to width in bits, in declaration order.
    """
    body = text.split("typedef struct packed {")
    for chunk in body[1:]:
        declaration, _, rest = chunk.partition("\n}")
        if rest.lstrip().startswith(type_name):
            return {
                name: int(high) + 1 if high else 1 for high, name in SV_MEMBER.findall(declaration)
            }
    return {}


def bits_to_width(bits: str) -> int:
    """Turn a field table bit range into a width.

    Args:
        bits: A range as the table writes it, such as ``[31:16]`` or ``[7]``.

    Returns:
        The number of bits the range covers.

    Raises:
        AssertionError: If the range cannot be read.
    """
    found = BIT_RANGE.match(bits)
    assert found, f"unreadable bit range {bits!r}"
    high = int(found.group(1))
    low = int(found.group(2)) if found.group(2) is not None else high
    return high - low + 1


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
def test_conversion_keeps_every_field_in_place(page: Page, label: str) -> None:
    """Converting an example to the other syntax and back leaves every field in its own bits."""
    # Arrange
    start = load_example(page, label)
    assert start["source"], f"{label} loaded nothing"
    assert "Layout" not in start["notes"], f"{label} did not lay out: {start['notes']}"
    before = field_bits(page)
    assert before, f"{label} drew no fields"

    # Act
    other = "rdl" if start["syntax"] == "sv" else "sv"
    middle = switch_syntax(page, other)
    middle_all = field_bits(page, every_type=True)
    middle_drawn = field_bits(page)
    returned = switch_syntax(page, start["syntax"])
    after = field_bits(page, every_type=True)

    # Assert
    assert middle["source"] == start["generated"], "the editor did not take the generated code"
    assert middle["syntax"] == other
    assert "Layout" not in middle["notes"], f"the conversion did not lay out: {middle['notes']}"
    assert middle_all == before, "a field moved on the way out"
    # The last tab carries the type on screen, so a union that left as an address map per member
    # comes back as the one that was being drawn.
    assert after == middle_drawn, "a field moved on the way back"
    assert returned["syntax"] == start["syntax"]
    assert returned["source"], "the editor came back empty"


@pytest.mark.parametrize("label", EXAMPLE_LABELS)
def test_generated_systemrdl_compiles(page: Page, label: str, tmp_path: Path) -> None:
    """The SystemRDL the page writes for an example elaborates as a register map."""
    # Arrange
    start = load_example(page, label)
    if start["syntax"] == "sv":
        text = start["generated"]
    else:
        text = switch_syntax(page, "sv")["generated"]

    # Act / Assert
    compile_systemrdl(text, tmp_path)
    assert len(ADDRMAP_NAME.findall(text)) >= 1


@pytest.mark.parametrize("label", EXAMPLE_LABELS)
def test_generated_systemverilog_lints(page: Page, label: str, tmp_path: Path) -> None:
    """The SystemVerilog the page writes for an example is valid and the widths agree."""
    # Arrange
    start = load_example(page, label)
    if start["syntax"] == "rdl":
        text = start["generated"]
        drawn_width = int(start["width"].split()[0])
    else:
        switched = switch_syntax(page, "rdl")
        text = switched["generated"]
        drawn_width = int(switched["width"].split()[0])

    # Act
    lint_systemverilog(text, tmp_path)

    # Assert
    types = SV_TYPEDEF_END.findall(text)
    assert types, "no typedef was written"
    if len(types) == 1:
        widths = _member_widths(text, types[0])
        assert sum(widths.values()) == drawn_width, (
            f"{types[0]} adds up to {sum(widths.values())}, but the page drew {drawn_width}"
        )


@pytest.mark.parametrize("label", EXAMPLE_LABELS)
def test_field_names_survive_the_round_trip(page: Page, label: str) -> None:
    """Every field answers to the same name after the conversion, allowing for squashing."""
    # Arrange
    start = load_example(page, label)
    before = field_names(page)
    views = view_count(page)

    # Act
    other = "rdl" if start["syntax"] == "sv" else "sv"
    switch_syntax(page, other)
    after = field_names(page, every_type=True)

    # Assert
    if views > 1:
        pytest.skip(
            f"{label} draws {views} union members, which leave as an address map each and so "
            "shed the member prefix from their field names"
        )
    assert after == before


@pytest.mark.parametrize("label", EXAMPLE_LABELS)
def test_field_widths_survive_the_round_trip(page: Page, label: str) -> None:
    """Every field keeps its width, not just its position, through both conversions."""
    # Arrange
    start = load_example(page, label)
    before = sorted(bits_to_width(bits) for bits in field_bits(page))

    # Act
    other = "rdl" if start["syntax"] == "sv" else "sv"
    switch_syntax(page, other)
    after = sorted(bits_to_width(bits) for bits in field_bits(page, every_type=True))

    # Assert
    assert after == before
    # A union overlays its members, so the widths of everything on offer may add up to more than
    # the vector; no single field may be wider than it.
    assert max(after) <= int(start["width"].split()[0])
