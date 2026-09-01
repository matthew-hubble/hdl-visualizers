"""Check that the segmented controls tile the strip they are drawn in.

A ``.seg`` draws one rounded border around a row of buttons and clips them to it, so the buttons
have to cover the strip exactly. If the strip is wider than they are, the button at the end stops
short of the rounded corner and the fill it takes when pressed leaves a pale wedge behind it. A
strip is a flex item in a column, so that is what happens whenever its label is set wider than its
buttons. Nothing in the stylesheet says as much, which is why these tests measure the boxes a
browser actually lays out rather than reading the CSS.

The buttons are measured on every page that has a strip, so a control added later is covered
without being listed here.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterator
from pathlib import Path
from typing import TypedDict, cast

import pytest
from playwright.sync_api import Browser

ROOT = Path(__file__).resolve().parent.parent
PAGES = sorted(path.name for path in ROOT.glob("*.html"))

SLACK = 0.5
"""How many pixels of disagreement to forgive, since layout lands on fractions of a pixel."""

MEASURE_JS = """
() => [...document.querySelectorAll(".seg")].map(strip => {
    const box = strip.getBoundingClientRect();
    const edge = getComputedStyle(strip);
    return {
        name: strip.id || strip.getAttribute("aria-label") || "(unnamed)",
        inside: box.width
              - parseFloat(edge.borderLeftWidth)
              - parseFloat(edge.borderRightWidth),
        buttons: [...strip.children].map(button => ({
            label: button.textContent.trim(),
            width: button.getBoundingClientRect().width,
        })),
    };
})
"""


class Button(TypedDict):
    """One button of a segmented control, as rendered."""

    label: str
    width: float


class Strip(TypedDict):
    """One segmented control, as rendered.

    ``inside`` is the width the buttons have to share: the strip without its own border.
    """

    name: str
    inside: float
    buttons: list[Button]


@pytest.fixture(scope="session")
def strips(browser: Browser) -> Iterator[dict[str, list[Strip]]]:
    """Every segmented control on every page, measured once and keyed by page.

    Args:
        browser: The browser shared by the session.

    Yields:
        The strips each page lays out, in document order.
    """
    sheet = browser.new_page(viewport={"width": 1400, "height": 1200})
    measured = {}
    for page in PAGES:
        sheet.goto((ROOT / page).as_uri())
        sheet.wait_for_timeout(500)
        measured[page] = cast(list[Strip], sheet.evaluate(MEASURE_JS))
    yield measured
    sheet.close()


def test_the_pages_carry_segmented_controls(strips: dict[str, list[Strip]]) -> None:
    """Guard the selector itself, so a renamed class cannot quietly empty these tests.

    Args:
        strips: Every strip on every page.
    """
    # Arrange / Act
    found = sum(len(page) for page in strips.values())

    # Assert
    assert found, "no .seg was found on any page, so nothing below is being measured"


@pytest.mark.parametrize("page", PAGES)
def test_the_buttons_cover_the_strip_they_are_clipped_to(
    page: str, strips: dict[str, list[Strip]]
) -> None:
    """No strip is wider than the buttons in it, so a pressed button reaches the rounded end.

    Args:
        page: The file name of a page at the repository root.
        strips: Every strip on every page.
    """
    # Arrange / Act
    short = [
        (strip["name"], round(strip["inside"] - sum(b["width"] for b in strip["buttons"]), 2))
        for strip in strips[page]
        if strip["inside"] - sum(b["width"] for b in strip["buttons"]) > SLACK
    ]

    # Assert
    assert not short, f"{page} leaves unfilled space inside a strip: {short}"


@pytest.mark.parametrize("page", PAGES)
def test_buttons_labelled_alike_come_out_the_same_size(
    page: str, strips: dict[str, list[Strip]]
) -> None:
    """Labels of equal length are equally wide, since the buttons are set in a monospaced face.

    A divider drawn as a border rather than as a shadow would break this: it would widen every
    button but the first by the width of the line.

    Args:
        page: The file name of a page at the repository root.
        strips: Every strip on every page.
    """
    # Arrange
    uneven = []

    # Act
    for strip in strips[page]:
        alike: dict[int, list[Button]] = defaultdict(list)
        for button in strip["buttons"]:
            alike[len(button["label"])].append(button)
        for group in alike.values():
            widths = [button["width"] for button in group]
            if max(widths) - min(widths) > SLACK:
                labels = ", ".join(button["label"] for button in group)
                uneven.append((strip["name"], labels, round(max(widths) - min(widths), 2)))

    # Assert
    assert not uneven, f"{page} sizes matching buttons differently: {uneven}"
