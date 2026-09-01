"""Check that the site GitHub Pages publishes is whole and self-contained.

The deploy job copies every root-level ``.html``, ``.css`` and ``.js`` file into a flat directory
and nothing else, so a page that asks for an asset outside that set, or for one that is not there,
would go live broken. These tests read the pages themselves rather than a list kept beside them,
so adding a page is enough to bring it under the check.
"""

from __future__ import annotations

import re
from html.parser import HTMLParser
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
LANDING = "index.html"
PUBLISHED_SUFFIXES = frozenset({".html", ".css", ".js"})
"""The extensions the deploy job in .github/workflows/ci.yml copies into the site."""

LINKING_ATTRIBUTES = frozenset({"href", "src"})
ELSEWHERE = re.compile(r"[a-z][a-z0-9+.\-]*:|//|#")
"""A target that leaves this site: an absolute URL, a scheme such as data:, or a bare anchor."""

PAGES = sorted(path.name for path in ROOT.glob("*.html"))


class ReferenceReader(HTMLParser):
    """Gathers the local href and src targets of one page.

    Attribute values inside a script or style element are not read, so the JavaScript the pages
    inline cannot be mistaken for markup.
    """

    def __init__(self) -> None:
        super().__init__()
        self.targets: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        """Record any local href or src carried by an opening tag.

        Args:
            tag: The element name, which is not used.
            attrs: The attributes of the tag, as name and value pairs.
        """
        self.targets.extend(
            value
            for name, value in attrs
            if name in LINKING_ATTRIBUTES and value and not ELSEWHERE.match(value)
        )


def local_references(page: str) -> list[str]:
    """Every local href and src on one page.

    Args:
        page: The file name of a page at the repository root.

    Returns:
        The reference targets in the order they appear, such as ``["hdl-visualizers.css"]``.
    """
    reader = ReferenceReader()
    reader.feed((ROOT / page).read_text(encoding="utf-8"))
    reader.close()
    return reader.targets


def test_the_root_has_a_landing_page() -> None:
    """GitHub Pages serves index.html for the bare site URL, so there has to be one."""
    # Arrange / Act / Assert
    assert (ROOT / LANDING).is_file(), f"{LANDING} is what the site URL opens"


@pytest.mark.parametrize("page", PAGES)
def test_every_reference_a_page_makes_is_published(page: str) -> None:
    """Each local href and src resolves to a file the deploy job copies.

    Args:
        page: The file name of a page at the repository root.
    """
    # Arrange
    references = local_references(page)

    # Act
    outside = [
        target
        for target in references
        if "/" in target or Path(target).suffix not in PUBLISHED_SUFFIXES
    ]
    absent = [target for target in references if not (ROOT / target).is_file()]

    # Assert
    assert references, f"{page} links nothing at all, not even the shared stylesheet"
    assert not outside, f"{page} reaches outside what is published: {outside}"
    assert not absent, f"{page} asks for files that are not there: {absent}"


def test_the_landing_page_links_every_other_page() -> None:
    """The landing page is the only way in, so it must offer every other page."""
    # Arrange
    expected = {page for page in PAGES if page != LANDING}

    # Act
    linked = set(local_references(LANDING))

    # Assert
    assert expected, "no pages were found at the repository root"
    assert expected <= linked, f"{LANDING} does not link {sorted(expected - linked)}"
