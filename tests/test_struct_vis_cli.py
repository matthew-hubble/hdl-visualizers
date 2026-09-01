"""The command that draws a struct's bit layout as a picture.

Three kinds of check, so that the slow ones stay few:

* the parts that need no browser, on their own,
* the drawing, through the library, sharing the session's browser,
* the command itself, run as a command in its own process, which is the only way to see argument
  handling, exit statuses and what lands on stderr as a person would.
"""

from __future__ import annotations

import struct
import subprocess
import sys
from pathlib import Path

import pytest
from playwright.sync_api import Browser

from struct_vis import build_parser, read_source
from struct_vis.image import Options, RenderError, detect_syntax, list_types, render

DESCRIPTOR = """
typedef struct packed {
  logic [1:0] cmd;
  logic       valid;
  logic [4:0] _rsvd;
} ctrl_t;

typedef struct packed {
  ctrl_t       ctrl;
  logic [31:0] addr;
  logic [7:0]  len;
  logic [3:0]  qos;
  logic [11:0] _pad;
} desc_t;
"""

GPIO_RDL = """
addrmap gpio {
    default regwidth = 32;
    reg {
        field { desc = "direction"; } direction [31:16];
        field { desc = "out_value"; } out_value [15: 0];
    } gpio_0 @ 0x0;
};
"""

NESTED = (
    "typedef struct packed { logic [3:0] lo; logic [3:0] hi; } pair_t; "
    "typedef struct packed { pair_t a; logic [7:0] b; } outer_t;"
)

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def png_size(path: Path) -> tuple[int, int]:
    """Read the pixel size out of a PNG file.

    Args:
        path: The file to measure.

    Returns:
        Width and height in pixels.

    Raises:
        AssertionError: If the file is not a PNG.
    """
    data = path.read_bytes()
    assert data[:8] == PNG_MAGIC, f"{path} is not a PNG"
    width, height = struct.unpack(">II", data[16:24])
    return width, height


@pytest.fixture
def declaration(tmp_path: Path) -> Path:
    """A SystemVerilog file holding two struct declarations."""
    source = tmp_path / "desc.sv"
    source.write_text(DESCRIPTOR, encoding="utf-8")
    return source


# --------------------------------------------------------------------------------------------
# the parts that need no browser
# --------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        ("typedef struct packed { logic [3:0] a; } t;", "sv"),
        ("addrmap m { reg { field {} a [3:0]; } r @ 0x0; };", "rdl"),
        ("// addrmap in a comment\ntypedef struct packed { logic a; } t;", "sv"),
        ("regfile block { };", "rdl"),
        ("reg lonely { field {} a [3:0]; };", "rdl"),
        ("", "sv"),
    ],
)
def test_detect_syntax_reads_the_declaration(source: str, expected: str) -> None:
    """The language is told from the words the declaration uses, not from the file name."""
    assert detect_syntax(source) == expected


@pytest.mark.parametrize(
    "setting",
    [{"syntax": "perl"}, {"rows": 24}, {"align": 12}, {"justify": "middle"}, {"width": 100}],
)
def test_options_reject_settings_the_page_has_no_control_for(setting: dict[str, object]) -> None:
    """A setting outside the page's range is refused before a browser is opened."""
    # Arrange
    name = next(iter(setting))

    # Act / Assert
    with pytest.raises(ValueError, match=name):
        Options(**setting)  # type: ignore[arg-type]


def test_source_comes_from_a_file(declaration: Path) -> None:
    """A path on the command line is read as the declaration."""
    assert "desc_t" in read_source(build_parser().parse_args([str(declaration)]))


def test_source_comes_from_the_command_line() -> None:
    """--source is the declaration itself."""
    assert read_source(build_parser().parse_args(["-e", "typedef struct packed {} t;"])) == (
        "typedef struct packed {} t;"
    )


@pytest.mark.parametrize(
    ("argv", "complaint"),
    [
        (["-e", "   "], "empty"),
        (["/no/such/file.sv"], "cannot read"),
    ],
)
def test_a_source_that_cannot_be_read_is_named(argv: list[str], complaint: str) -> None:
    """Nothing reaches the browser without a declaration to draw."""
    with pytest.raises(RenderError, match=complaint):
        read_source(build_parser().parse_args(argv))


def test_a_file_and_a_source_together_is_refused(declaration: Path) -> None:
    """Two declarations at once is a mistake worth naming."""
    with pytest.raises(RenderError, match="not both"):
        read_source(build_parser().parse_args([str(declaration), "-e", "typedef struct {} t;"]))


# --------------------------------------------------------------------------------------------
# the drawing, through the library
# --------------------------------------------------------------------------------------------


def test_draws_a_declaration_to_a_png(tmp_path: Path, browser: Browser) -> None:
    """A declaration becomes a picture of its last type."""
    # Arrange
    out = tmp_path / "desc.png"

    # Act
    drawing = render(DESCRIPTOR, out, Options(), browser=browser)

    # Assert
    assert drawing.type_name == "desc_t"
    assert drawing.summary == "64 bits"
    assert drawing.size == png_size(out)
    width, height = drawing.size
    assert width > 1000, f"the picture is only {width} pixels wide"
    assert 100 < height < width, f"{width}x{height} is not the shape of a bit diagram"
    assert out.stat().st_size > 3000, "the picture looks blank"


def test_row_width_changes_the_shape_of_the_picture(tmp_path: Path, browser: Browser) -> None:
    """Sixty-four bit rows halve the number of rows, and so the height."""
    # Arrange / Act
    narrow = render(DESCRIPTOR, tmp_path / "r32.png", Options(rows=32), browser=browser)
    wide = render(DESCRIPTOR, tmp_path / "r64.png", Options(rows=64), browser=browser)

    # Assert
    assert narrow.size[1] > wide.size[1], "two rows should be taller than one"
    assert narrow.size[0] == wide.size[0], "the width should not have moved"


def test_width_changes_how_wide_the_picture_is(tmp_path: Path, browser: Browser) -> None:
    """The browser width sets how wide the diagram is drawn."""
    # Arrange / Act
    small = render(DESCRIPTOR, tmp_path / "small.png", Options(width=900), browser=browser)
    large = render(DESCRIPTOR, tmp_path / "large.png", Options(width=1600), browser=browser)

    # Assert
    assert small.size[0] < large.size[0]


def test_a_named_type_is_drawn_instead_of_the_last_one(tmp_path: Path, browser: Browser) -> None:
    """The type to draw can be any of the declared ones."""
    # Act
    drawing = render(
        DESCRIPTOR, tmp_path / "ctrl.png", Options(type_name="ctrl_t"), browser=browser
    )

    # Assert
    assert drawing.type_name == "ctrl_t"
    assert drawing.summary == "8 bits"
    assert drawing.size[1] < 400, "one row of eight bits should be a short picture"


def test_systemrdl_is_recognised_and_drawn(tmp_path: Path, browser: Browser) -> None:
    """A register map is drawn without being told which language it is in."""
    # Act
    drawing = render(GPIO_RDL, tmp_path / "gpio.png", Options(), browser=browser)

    # Assert
    assert drawing.type_name == "gpio"
    assert drawing.summary == "32 bits"


def test_unflattened_nesting_draws_something_else(tmp_path: Path, browser: Browser) -> None:
    """Leaving a nested type unflattened changes the picture."""
    # Arrange
    flat, block = tmp_path / "flat.png", tmp_path / "block.png"

    # Act
    render(NESTED, flat, Options(), browser=browser)
    render(NESTED, block, Options(flatten=False), browser=browser)

    # Assert
    assert flat.read_bytes() != block.read_bytes(), "the switch made no difference"


def test_hiding_underscore_names_changes_the_picture(tmp_path: Path, browser: Browser) -> None:
    """The underscore switch reaches the drawing."""
    # Arrange
    shown, hidden = tmp_path / "shown.png", tmp_path / "hidden.png"

    # Act
    render(DESCRIPTOR, shown, Options(), browser=browser)
    render(DESCRIPTOR, hidden, Options(underscore=False), browser=browser)

    # Assert
    assert shown.read_bytes() != hidden.read_bytes()


def test_alignment_reaches_an_unpacked_struct(tmp_path: Path, browser: Browser) -> None:
    """A plain struct padded to 32-bit words is wider than one padded to bytes."""
    # Arrange
    plain = "typedef struct { logic [2:0] mode; logic [11:0] count; } cfg_t;"

    # Act
    bytes_wide = render(plain, tmp_path / "a8.png", Options(align=8), browser=browser)
    words_wide = render(
        plain, tmp_path / "a32.png", Options(align=32, justify="lsb"), browser=browser
    )

    # Assert
    assert bytes_wide.summary == "24 bits"
    assert words_wide.summary == "64 bits"


def test_list_types_names_each_one_with_its_size(browser: Browser) -> None:
    """The types on offer are reported in the order the page lists them."""
    assert list_types(DESCRIPTOR, Options(), browser=browser) == [
        ("ctrl_t", "8 bits"),
        ("desc_t", "64 bits"),
    ]


@pytest.mark.parametrize(
    ("source", "options", "complaint"),
    [
        ("typedef struct packed { missing_t x; } oops_t;", Options(), "unknown type"),
        ("// nothing at all", Options(), "Nothing to draw"),
        (DESCRIPTOR, Options(type_name="absent_t"), "no type named"),
    ],
)
def test_a_declaration_that_will_not_draw_raises(
    source: str, options: Options, complaint: str, tmp_path: Path, browser: Browser
) -> None:
    """Nothing is written when the page cannot draw, and the reason says why."""
    # Arrange
    out = tmp_path / "never.png"

    # Act / Assert
    with pytest.raises(RenderError, match=complaint):
        render(source, out, options, browser=browser)
    assert not out.exists()


# --------------------------------------------------------------------------------------------
# the command itself
# --------------------------------------------------------------------------------------------


def run_command(*arguments: str, stdin: str | None = None) -> subprocess.CompletedProcess[str]:
    """Run the installed command in its own process.

    Args:
        *arguments: The command line, without the program name.
        stdin: What to pipe in, if anything.

    Returns:
        The finished process, with its output captured.
    """
    return subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys; from struct_vis import main; sys.exit(main())",
            *arguments,
        ],
        input=stdin,
        capture_output=True,
        text=True,
        check=False,
        timeout=180,
    )


def test_the_command_writes_a_picture_and_says_where(declaration: Path, tmp_path: Path) -> None:
    """A plain run writes the file it was asked for and reports it."""
    # Arrange
    out = tmp_path / "desc.png"

    # Act
    done = run_command(str(declaration), "-o", str(out))

    # Assert
    assert done.returncode == 0, done.stderr
    assert out.exists()
    assert str(out) in done.stdout
    assert "desc_t" in done.stdout and "64 bits" in done.stdout
    assert png_size(out)[0] > 1000


def test_the_command_reads_a_declaration_piped_in(tmp_path: Path) -> None:
    """With no file and no --source the declaration comes from standard input."""
    # Arrange
    out = tmp_path / "piped.png"

    # Act
    done = run_command("-o", str(out), stdin=GPIO_RDL)

    # Assert
    assert done.returncode == 0, done.stderr
    assert out.exists()


def test_the_command_names_the_file_after_the_type(declaration: Path, tmp_path: Path) -> None:
    """Without --out the picture lands in the working directory, named for the type."""
    # Act
    done = subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys; from struct_vis import main; sys.exit(main())",
            str(declaration),
        ],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        check=False,
        timeout=180,
    )

    # Assert
    assert done.returncode == 0, done.stderr
    assert (tmp_path / "desc_t-bits.png").exists()


def test_the_command_lists_the_types(declaration: Path) -> None:
    """--list-types names each type and its size, and draws nothing."""
    # Act
    done = run_command(str(declaration), "--list-types")

    # Assert
    assert done.returncode == 0, done.stderr
    assert "ctrl_t" in done.stdout and "8 bits" in done.stdout
    assert "desc_t" in done.stdout and "64 bits" in done.stdout


def test_the_command_reports_a_declaration_it_cannot_draw(tmp_path: Path) -> None:
    """A failure is explained on stderr, nothing is written, and the status is not zero."""
    # Arrange
    out = tmp_path / "never.png"

    # Act
    done = run_command("-e", "typedef struct packed { missing_t x; } oops_t;", "-o", str(out))

    # Assert
    assert done.returncode == 1
    assert not out.exists()
    assert "unknown type" in done.stderr


def test_the_command_lists_the_types_it_does_have(declaration: Path, tmp_path: Path) -> None:
    """A wrong --type says what could have been asked for instead."""
    # Act
    done = run_command(str(declaration), "--type", "nope", "-o", str(tmp_path / "no.png"))

    # Assert
    assert done.returncode == 1
    assert "ctrl_t" in done.stderr and "desc_t" in done.stderr


def test_the_command_refuses_a_setting_the_page_has_no_control_for(tmp_path: Path) -> None:
    """argparse turns away a row width the page does not offer."""
    # Act
    done = run_command(
        "-e",
        "typedef struct packed { logic a; } t;",
        "--rows",
        "48",
        "-o",
        str(tmp_path / "no.png"),
    )

    # Assert
    assert done.returncode == 2
    assert "--rows" in done.stderr
