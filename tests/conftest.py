"""Fixtures shared by every test that needs a browser.

Playwright's synchronous API cannot be started twice in one process, so the browser is opened once
for the session and handed to whoever asks. Anything that would otherwise start its own, including
the code behind the ``struct-vis`` command, takes this one instead.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from playwright.sync_api import Browser, sync_playwright


@pytest.fixture(scope="session")
def browser() -> Iterator[Browser]:
    """A headless browser shared by every test in the session."""
    with sync_playwright() as play:
        instance = play.chromium.launch()
        yield instance
        instance.close()
