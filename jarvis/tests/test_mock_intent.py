from backend.ai.mock_intent import detect_tool_intent

ALL_TOOLS = {
    "browser.open",
    "browser.navigate",
    "browser.search",
    "browser.extract_text",
    "browser.close",
    "computer.open_application",
    "computer.describe_screen",
    "system.get_system_info",
    "memory.remember",
    "files.delete",
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


def test_detects_open_application_not_browser():
    call = detect_tool_intent("open chrome", ALL_TOOLS)
    assert call is not None
    assert call.name == "computer.open_application"
    assert call.arguments["name"] == "chrome"


def test_detects_describe_screen():
    call = detect_tool_intent("what's on my screen?", ALL_TOOLS)
    assert call is not None
    assert call.name == "computer.describe_screen"


def test_detects_system_info():
    call = detect_tool_intent("how's my computer doing?", ALL_TOOLS)
    assert call is not None
    assert call.name == "system.get_system_info"


def test_detects_remember_preserves_case():
    call = detect_tool_intent("Remember that I prefer Minimal Black-and-White designs", ALL_TOOLS)
    assert call is not None
    assert call.name == "memory.remember"
    assert call.arguments["content"] == "I prefer Minimal Black-and-White designs"


def test_detects_delete_preserves_path_case():
    call = detect_tool_intent("delete /tmp/MyFile.TXT", ALL_TOOLS)
    assert call is not None
    assert call.name == "files.delete"
    assert call.arguments["path"] == "/tmp/MyFile.TXT"


def test_no_match_for_unrelated_text():
    call = detect_tool_intent("what's the weather like on mars", ALL_TOOLS)
    assert call is None


def test_no_match_when_tool_not_available():
    call = detect_tool_intent("open the browser", set())
    assert call is None
