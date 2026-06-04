"""Audio service contract models."""

from app.shared.contracts.registry import IOModel


# Module identifiers
class AudioInputModule:
    """Module identifier for Audio Input service."""

    NAME = "AudioInput"


# Method identifiers
class AudioInputMethods:
    """Full method identifiers for Audio Input service."""

    # Note: The original topic was "Audio.Input.Control", but following the new convention
    # it should be "AudioInput.Control". However, to maintain compatibility with the
    # service implementation if it's not being updated right now, we might need to be careful.
    # But the goal is to migrate. Let's assume we update the service too.
    # Actually, let's check the service implementation first.
    # For now, I'll define it as per the new convention and update the service.
    CONTROL = f"{AudioInputModule.NAME}.Control"


class AudioInputControl(IOModel):
    """Control audio input."""

    action: str  # "start" | "stop" | "pause" | "resume"
    device_index: int | None = None
