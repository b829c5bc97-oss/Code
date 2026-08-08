from backend.ai.mock_intent import detect_tool_intent

ALL_TOOLS = {
    "browser.open",
    "browser.navigate",
    "browser.search",
    "browser.extract_text",
    "browser.close",
}


def test_detects_youtube_search():
    call = detect_tool_intent("search youtube for the latest ai news", ALL_TOOLS)
    assert call is not None
    assert call.name == "browser.search"
    assert call.arguments["engine"] == "youtube"
    assert "latest ai news" in call.arguments["query"]


def test_detects_google_search():
    call = detect_tool_intent("search for best python tutorials", ALL_TOOLS)
    assert call is not None
    assert call.name == "browser.search"
    assert call.arguments["engine"] == "google"


def test_detects_navigate_with_url():
    call = detect_tool_intent("go to wikipedia.org", ALL_TOOLS)
    assert call is not None
    assert call.name == "browser.navigate"
    assert "wikipedia.org" in call.arguments["url"]


def test_detects_open_browser():
    call = detect_tool_intent("please open the browser", ALL_TOOLS)
    assert call is not None
    assert call.name == "browser.open"


def test_detects_close_browser():
    call = detect_tool_intent("close the browser now", ALL_TOOLS)
    assert call is not None
    assert call.name == "browser.close"


def test_detects_extract_text():
    call = detect_tool_intent("summarize this webpage for me", ALL_TOOLS)
    assert call is not None
    assert call.name == "browser.extract_text"


def test_no_match_for_unrelated_text():
    call = detect_tool_intent("what's the weather like on mars", ALL_TOOLS)
    assert call is None


def test_no_match_when_tool_not_available():
    call = detect_tool_intent("open the browser", set())
    assert call is None
