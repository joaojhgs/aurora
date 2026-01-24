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

from .common import (
    EmptyInput,
    EmptyOutput,
    ErrorOutput,
)
from .config import (
    ConfigGetRequest,
    ConfigGetResponse,
    ConfigSetRequest,
    ConfigSetResponse,
)
from .db import (
    DBGetMessagesRequest,
    DBGetMessagesResponse,
    DBSaveMessageRequest,
    DBSaveMessageResponse,
)
from .gateway import (
    GatewayMethods,
    GatewayModule,
    GetRegistryResponse,
    GetServiceHealthRequest,
    GetServiceHealthResponse,
    GetServicesResponse,
    MethodInfo,
    ServiceAnnouncement,
    ServiceDeparture,
    ServiceHeartbeat,
    ServiceInfo,
)
from .orchestrator import (
    OrchestratorProcessRequest,
    OrchestratorResponse,
)
from .stt import (
    STTControl,
    STTError,
    STTTranscriptionRequest,
    STTTranscriptionResult,
)
from .tts import (
    TTSControl,
    TTSError,
    TTSRequest,
    TTSStatus,
)

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
