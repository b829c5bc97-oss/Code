"""Shared exception for the computer-control package."""


class ComputerControlError(RuntimeError):
    """Raised when a mouse/keyboard/screen/window/application action can't be performed."""
