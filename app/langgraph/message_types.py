from enum import Enum


class MessageSource(Enum):
    STT = "user"
    TEXT = "system"


class AuroraMessage:
    def __init__(self, text, source: MessageSource = MessageSource.STT):
        self.text = text
        self.source = source
        # Time marker used to uniquely identify this message
        from datetime import datetime

        self.timestamp = datetime.now().timestamp()

    def __str__(self):
        return self.text
