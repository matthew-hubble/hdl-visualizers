"""Elaborate a generated SystemRDL file and print the register model as JSON.

The JavaScript suites use this to check the SystemRDL the page writes: they read back where the
compiler decided each register and field sits, rather than trusting the text they just produced.

Usage:
    python tests/rdl_model.py <file.rdl> <addrmap> [<addrmap> ...]

Prints one object per address map on success. On a compile error it prints ``{"error": ...}`` and
exits non-zero.
"""

from __future__ import annotations

import json
import sys

from systemrdl.compiler import RDLCompiler
from systemrdl.messages import MessagePrinter, RDLCompileError
from systemrdl.node import RegNode


class QuietPrinter(MessagePrinter):
    """A printer that keeps compiler chatter off the console."""

    def emit_message(self, lines: list[str]) -> None:
        """Swallow a message; the raised error carries what the caller needs."""
        return


def model_of(path: str, top: str) -> dict[str, object]:
    """Elaborate one address map and describe every register in it.

    Args:
        path: The SystemRDL file to compile.
        top: The name of the address map to elaborate.

    Returns:
        The address map's name, description and registers, each with its address, width and fields.

    Raises:
        RDLCompileError: If the file does not compile, or the address map is not in it.
    """
    compiler = RDLCompiler(message_printer=QuietPrinter())
    compiler.compile_file(path)
    amap = compiler.elaborate(top_def_name=top).top
    registers = [
        {
            "inst": node.inst_name,
            "addr": node.absolute_address,
            "regwidth": node.get_property("regwidth"),
            "desc": node.get_property("desc"),
            "fields": [
                {
                    "name": field.inst_name,
                    "desc": field.get_property("desc"),
                    "msb": field.msb,
                    "lsb": field.lsb,
                    "width": field.width,
                    "sw": str(field.get_property("sw")),
                    "hw": str(field.get_property("hw")),
                }
                for field in node.fields()
            ],
        }
        for node in amap.descendants()
        if isinstance(node, RegNode)
    ]
    return {
        "top": top,
        "name": amap.get_property("name"),
        "desc": amap.get_property("desc"),
        "regs": registers,
    }


def main(argv: list[str]) -> int:
    """Elaborate every address map named on the command line.

    Args:
        argv: The arguments after the program name: a file, then one or more address map names.

    Returns:
        A process exit status: 0 when every address map elaborated.
    """
    if len(argv) < 2:
        print(json.dumps({"error": "usage: rdl_model.py <file.rdl> <addrmap> ..."}))
        return 2
    path, tops = argv[0], argv[1:]
    models = []
    for top in tops:
        try:
            models.append(model_of(path, top))
        except RDLCompileError as exc:
            print(json.dumps({"error": f"{top}: {exc}"}))
            return 1
    print(json.dumps(models))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
