"""Command line entry point: draw a struct's bit layout as a picture.

struct-vis desc.sv -o desc.png
struct-vis -e 'typedef struct packed { logic [3:0] a; logic [11:0] b; } t;'
cat regs.rdl | struct-vis --rows 64
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

from struct_vis.image import (
    ALIGN_WIDTHS,
    JUSTIFICATIONS,
    ROW_WIDTHS,
    SYNTAXES,
    Options,
    RenderError,
    list_types,
    render,
)

logger = logging.getLogger("struct-vis")

__all__ = ["main"]


def build_parser() -> argparse.ArgumentParser:
    """Describe every argument the command takes.

    Returns:
        The parser, ready to read a command line.
    """
    parser = argparse.ArgumentParser(
        prog="struct-vis",
        description="Draw the bit layout of a SystemVerilog or SystemRDL declaration.",
        epilog="The declaration is read from FILE, from --source, or from standard input.",
    )
    parser.add_argument("file", nargs="?", type=Path, help="a file holding the declaration")
    parser.add_argument("-e", "--source", help="the declaration itself, instead of a file")
    parser.add_argument(
        "-o",
        "--out",
        type=Path,
        help="where to write the picture (default: the type name, next to you)",
    )
    parser.add_argument(
        "--syntax", choices=SYNTAXES, default="auto", help="the language the declaration is in"
    )
    parser.add_argument("--type", dest="type_name", help="which declared type to draw")
    parser.add_argument(
        "--rows", type=int, choices=ROW_WIDTHS, default=32, help="bits per row of the diagram"
    )
    parser.add_argument(
        "--align",
        type=int,
        choices=ALIGN_WIDTHS,
        default=8,
        help="the word an unpacked struct pads each member out to",
    )
    parser.add_argument(
        "--justify",
        choices=JUSTIFICATIONS,
        default="msb",
        help="which end of that word the member sits at",
    )
    parser.add_argument(
        "--no-flatten",
        dest="flatten",
        action="store_false",
        help="draw a nested type as one block rather than as its fields",
    )
    parser.add_argument(
        "--hide-underscore",
        dest="underscore",
        action="store_false",
        help="leave the names of _fields off the picture",
    )
    parser.add_argument(
        "--width", type=int, default=1400, help="how wide to draw, in browser pixels"
    )
    parser.add_argument(
        "--list-types", action="store_true", help="print the types the declaration offers and stop"
    )
    return parser


def read_source(arguments: argparse.Namespace) -> str:
    """Find the declaration the command was pointed at.

    Args:
        arguments: The parsed command line.

    Returns:
        The declaration text.

    Raises:
        RenderError: If no declaration was given, or the file is empty or unreadable.
    """
    if arguments.file is not None and arguments.source is not None:
        raise RenderError("give a file or --source, not both")
    text: str
    if arguments.source is not None:
        text = str(arguments.source)
    elif arguments.file is not None:
        try:
            text = arguments.file.read_text(encoding="utf-8")
        except OSError as exc:
            raise RenderError(f"cannot read {arguments.file}: {exc}") from exc
    elif not sys.stdin.isatty():
        text = str(sys.stdin.read())
    else:
        raise RenderError("nothing to draw: give a file, --source, or pipe it in")
    if not text.strip():
        raise RenderError("the declaration is empty")
    return text


def main(argv: list[str] | None = None) -> int:
    """Draw a bit layout, or list the types on offer.

    Args:
        argv: The command line, without the program name. Taken from the process when None.

    Returns:
        A process exit status: 0 when the picture was written.
    """
    logging.basicConfig(format="%(message)s", level=logging.INFO)
    arguments = build_parser().parse_args(argv)

    try:
        source = read_source(arguments)
        options = Options(
            syntax=arguments.syntax,
            type_name=arguments.type_name,
            rows=arguments.rows,
            flatten=arguments.flatten,
            underscore=arguments.underscore,
            align=arguments.align,
            justify=arguments.justify,
            width=arguments.width,
        )

        if arguments.list_types:
            found = list_types(source, options)
            width = max(len(name) for name, _ in found)
            for name, summary in found:
                print(f"{name:<{width}}  {summary}")
            return 0

        destination = arguments.out
        if destination is None:
            first = arguments.type_name or list_types(source, options)[-1][0]
            destination = Path(f"{first}-bits.png")
        drawing = render(source, destination, options)
    except (RenderError, ValueError) as exc:
        logger.error("%s", exc)
        return 1

    print(
        f"{drawing.path}  {drawing.type_name}, {drawing.summary}, "
        f"{drawing.size[0]}x{drawing.size[1]} pixels"
    )
    return 0
