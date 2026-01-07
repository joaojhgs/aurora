"""Contract IO Models for Aurora services.

This package contains Pydantic models that define the input/output schemas
for all service methods registered via @method_contract.

Organization:
- common.py: Shared/base models used across multiple services
- tts.py: Text-to-Speech service models
- stt.py: Speech-to-Text service models
- config.py: Configuration service models
- db.py: Database service models
- orchestrator.py: Orchestrator/LLM service models
- gateway.py: Gateway/API service models
"""

from .common import *
from .config import *
from .db import *
from .gateway import *
from .orchestrator import *
from .stt import *
from .tts import *

__all__ = [
    # Common
    "EmptyInput",
    "EmptyOutput",
    "ErrorOutput",
    # TTS
    "TTSRequest",
    "TTSControl",
    "TTSStatus",
    "TTSError",
    # STT
    "STTTranscriptionRequest",
    "STTTranscriptionResult",
    "STTPartialResult",
    "STTControl",
    "STTError",
    # Config
    "ConfigGetRequest",
    "ConfigGetResponse",
    "ConfigSetRequest",
    "ConfigSetResponse",
    # DB
    "DBSaveMessageRequest",
    "DBSaveMessageResponse",
    "DBGetMessagesRequest",
    "DBGetMessagesResponse",
    # Orchestrator
    "OrchestratorProcessRequest",
    "OrchestratorResponse",
    # Gateway
    "GatewayModule",
    "GatewayMethods",
    "MethodInfo",
    "ServiceAnnouncement",
    "ServiceDeparture",
    "ServiceHeartbeat",
    "GetRegistryResponse",
    "ServiceInfo",
    "GetServicesResponse",
    "GetServiceHealthRequest",
    "GetServiceHealthResponse",
]
