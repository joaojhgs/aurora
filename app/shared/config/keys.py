from __future__ import annotations


class ConfigPath(str):
    """String-compatible typed config path."""

    def __new__(cls, path: str) -> ConfigPath:
        return str.__new__(cls, path)

    @property
    def path(self) -> str:
        """Return the dot-delimited config path."""
        return str(self)


class _ServicesOrchestratorLlmLocalHuggingfacePipelineOptionsConfigPath(ConfigPath):
    device: ConfigPath
    max_tokens: ConfigPath
    model: ConfigPath
    model_kwargs: ConfigPath
    pipeline_kwargs: ConfigPath
    temperature: ConfigPath
    torch_dtype: ConfigPath

    def __new__(cls) -> _ServicesOrchestratorLlmLocalHuggingfacePipelineOptionsConfigPath:
        self = super().__new__(cls, "services.orchestrator.llm.local.huggingface_pipeline.options")
        self.device = ConfigPath(
            "services.orchestrator.llm.local.huggingface_pipeline.options.device"
        )
        self.max_tokens = ConfigPath(
            "services.orchestrator.llm.local.huggingface_pipeline.options.max_tokens"
        )
        self.model = ConfigPath(
            "services.orchestrator.llm.local.huggingface_pipeline.options.model"
        )
        self.model_kwargs = ConfigPath(
            "services.orchestrator.llm.local.huggingface_pipeline.options.model_kwargs"
        )
        self.pipeline_kwargs = ConfigPath(
            "services.orchestrator.llm.local.huggingface_pipeline.options.pipeline_kwargs"
        )
        self.temperature = ConfigPath(
            "services.orchestrator.llm.local.huggingface_pipeline.options.temperature"
        )
        self.torch_dtype = ConfigPath(
            "services.orchestrator.llm.local.huggingface_pipeline.options.torch_dtype"
        )
        return self


class _ServicesOrchestratorLlmLocalLlamaCppOptionsConfigPath(ConfigPath):
    chat_format: ConfigPath
    max_tokens: ConfigPath
    min_p: ConfigPath
    model_path: ConfigPath
    n_batch: ConfigPath
    n_ctx: ConfigPath
    n_gpu_layers: ConfigPath
    repeat_penalty: ConfigPath
    temperature: ConfigPath
    top_k: ConfigPath
    top_p: ConfigPath

    def __new__(cls) -> _ServicesOrchestratorLlmLocalLlamaCppOptionsConfigPath:
        self = super().__new__(cls, "services.orchestrator.llm.local.llama_cpp.options")
        self.chat_format = ConfigPath(
            "services.orchestrator.llm.local.llama_cpp.options.chat_format"
        )
        self.max_tokens = ConfigPath("services.orchestrator.llm.local.llama_cpp.options.max_tokens")
        self.min_p = ConfigPath("services.orchestrator.llm.local.llama_cpp.options.min_p")
        self.model_path = ConfigPath("services.orchestrator.llm.local.llama_cpp.options.model_path")
        self.n_batch = ConfigPath("services.orchestrator.llm.local.llama_cpp.options.n_batch")
        self.n_ctx = ConfigPath("services.orchestrator.llm.local.llama_cpp.options.n_ctx")
        self.n_gpu_layers = ConfigPath(
            "services.orchestrator.llm.local.llama_cpp.options.n_gpu_layers"
        )
        self.repeat_penalty = ConfigPath(
            "services.orchestrator.llm.local.llama_cpp.options.repeat_penalty"
        )
        self.temperature = ConfigPath(
            "services.orchestrator.llm.local.llama_cpp.options.temperature"
        )
        self.top_k = ConfigPath("services.orchestrator.llm.local.llama_cpp.options.top_k")
        self.top_p = ConfigPath("services.orchestrator.llm.local.llama_cpp.options.top_p")
        return self


class _ServicesOrchestratorLlmThirdPartyHuggingfaceEndpointOptionsConfigPath(ConfigPath):
    access_token: ConfigPath
    endpoint_url: ConfigPath
    max_tokens: ConfigPath
    model: ConfigPath
    temperature: ConfigPath

    def __new__(cls) -> _ServicesOrchestratorLlmThirdPartyHuggingfaceEndpointOptionsConfigPath:
        self = super().__new__(
            cls, "services.orchestrator.llm.third_party.huggingface_endpoint.options"
        )
        self.access_token = ConfigPath(
            "services.orchestrator.llm.third_party.huggingface_endpoint.options.access_token"
        )
        self.endpoint_url = ConfigPath(
            "services.orchestrator.llm.third_party.huggingface_endpoint.options.endpoint_url"
        )
        self.max_tokens = ConfigPath(
            "services.orchestrator.llm.third_party.huggingface_endpoint.options.max_tokens"
        )
        self.model = ConfigPath(
            "services.orchestrator.llm.third_party.huggingface_endpoint.options.model"
        )
        self.temperature = ConfigPath(
            "services.orchestrator.llm.third_party.huggingface_endpoint.options.temperature"
        )
        return self


class _ServicesOrchestratorLlmThirdPartyOpenaiOptionsConfigPath(ConfigPath):
    api_key: ConfigPath
    max_tokens: ConfigPath
    model: ConfigPath
    temperature: ConfigPath

    def __new__(cls) -> _ServicesOrchestratorLlmThirdPartyOpenaiOptionsConfigPath:
        self = super().__new__(cls, "services.orchestrator.llm.third_party.openai.options")
        self.api_key = ConfigPath("services.orchestrator.llm.third_party.openai.options.api_key")
        self.max_tokens = ConfigPath(
            "services.orchestrator.llm.third_party.openai.options.max_tokens"
        )
        self.model = ConfigPath("services.orchestrator.llm.third_party.openai.options.model")
        self.temperature = ConfigPath(
            "services.orchestrator.llm.third_party.openai.options.temperature"
        )
        return self


class _ServicesOrchestratorLlmLocalHuggingfacePipelineConfigPath(ConfigPath):
    options: _ServicesOrchestratorLlmLocalHuggingfacePipelineOptionsConfigPath

    def __new__(cls) -> _ServicesOrchestratorLlmLocalHuggingfacePipelineConfigPath:
        self = super().__new__(cls, "services.orchestrator.llm.local.huggingface_pipeline")
        self.options = _ServicesOrchestratorLlmLocalHuggingfacePipelineOptionsConfigPath()
        return self


class _ServicesOrchestratorLlmLocalLlamaCppConfigPath(ConfigPath):
    options: _ServicesOrchestratorLlmLocalLlamaCppOptionsConfigPath

    def __new__(cls) -> _ServicesOrchestratorLlmLocalLlamaCppConfigPath:
        self = super().__new__(cls, "services.orchestrator.llm.local.llama_cpp")
        self.options = _ServicesOrchestratorLlmLocalLlamaCppOptionsConfigPath()
        return self


class _ServicesOrchestratorLlmThirdPartyHuggingfaceEndpointConfigPath(ConfigPath):
    options: _ServicesOrchestratorLlmThirdPartyHuggingfaceEndpointOptionsConfigPath

    def __new__(cls) -> _ServicesOrchestratorLlmThirdPartyHuggingfaceEndpointConfigPath:
        self = super().__new__(cls, "services.orchestrator.llm.third_party.huggingface_endpoint")
        self.options = _ServicesOrchestratorLlmThirdPartyHuggingfaceEndpointOptionsConfigPath()
        return self


class _ServicesOrchestratorLlmThirdPartyOpenaiConfigPath(ConfigPath):
    options: _ServicesOrchestratorLlmThirdPartyOpenaiOptionsConfigPath

    def __new__(cls) -> _ServicesOrchestratorLlmThirdPartyOpenaiConfigPath:
        self = super().__new__(cls, "services.orchestrator.llm.third_party.openai")
        self.options = _ServicesOrchestratorLlmThirdPartyOpenaiOptionsConfigPath()
        return self


class _ServicesGatewayApiCorsConfigPath(ConfigPath):
    allow_credentials: ConfigPath
    origins: ConfigPath

    def __new__(cls) -> _ServicesGatewayApiCorsConfigPath:
        self = super().__new__(cls, "services.gateway.api.cors")
        self.allow_credentials = ConfigPath("services.gateway.api.cors.allow_credentials")
        self.origins = ConfigPath("services.gateway.api.cors.origins")
        return self


class _ServicesOrchestratorLlmLocalConfigPath(ConfigPath):
    huggingface_pipeline: _ServicesOrchestratorLlmLocalHuggingfacePipelineConfigPath
    llama_cpp: _ServicesOrchestratorLlmLocalLlamaCppConfigPath

    def __new__(cls) -> _ServicesOrchestratorLlmLocalConfigPath:
        self = super().__new__(cls, "services.orchestrator.llm.local")
        self.huggingface_pipeline = _ServicesOrchestratorLlmLocalHuggingfacePipelineConfigPath()
        self.llama_cpp = _ServicesOrchestratorLlmLocalLlamaCppConfigPath()
        return self


class _ServicesOrchestratorLlmThirdPartyConfigPath(ConfigPath):
    huggingface_endpoint: _ServicesOrchestratorLlmThirdPartyHuggingfaceEndpointConfigPath
    openai: _ServicesOrchestratorLlmThirdPartyOpenaiConfigPath

    def __new__(cls) -> _ServicesOrchestratorLlmThirdPartyConfigPath:
        self = super().__new__(cls, "services.orchestrator.llm.third_party")
        self.huggingface_endpoint = (
            _ServicesOrchestratorLlmThirdPartyHuggingfaceEndpointConfigPath()
        )
        self.openai = _ServicesOrchestratorLlmThirdPartyOpenaiConfigPath()
        return self


class _ServicesSttCoordinatorAmbientTranscriptionConfigPath(ConfigPath):
    chunk_duration: ConfigPath
    enable: ConfigPath
    filter_short_transcriptions: ConfigPath
    min_transcription_length: ConfigPath
    storage_path: ConfigPath

    def __new__(cls) -> _ServicesSttCoordinatorAmbientTranscriptionConfigPath:
        self = super().__new__(cls, "services.stt.coordinator.ambient_transcription")
        self.chunk_duration = ConfigPath(
            "services.stt.coordinator.ambient_transcription.chunk_duration"
        )
        self.enable = ConfigPath("services.stt.coordinator.ambient_transcription.enable")
        self.filter_short_transcriptions = ConfigPath(
            "services.stt.coordinator.ambient_transcription.filter_short_transcriptions"
        )
        self.min_transcription_length = ConfigPath(
            "services.stt.coordinator.ambient_transcription.min_transcription_length"
        )
        self.storage_path = ConfigPath(
            "services.stt.coordinator.ambient_transcription.storage_path"
        )
        return self


class _ServicesSttCoordinatorAudioInputConfigPath(ConfigPath):
    channels: ConfigPath
    chunk_size: ConfigPath
    device_index: ConfigPath
    format: ConfigPath
    sample_rate: ConfigPath

    def __new__(cls) -> _ServicesSttCoordinatorAudioInputConfigPath:
        self = super().__new__(cls, "services.stt.coordinator.audio_input")
        self.channels = ConfigPath("services.stt.coordinator.audio_input.channels")
        self.chunk_size = ConfigPath("services.stt.coordinator.audio_input.chunk_size")
        self.device_index = ConfigPath("services.stt.coordinator.audio_input.device_index")
        self.format = ConfigPath("services.stt.coordinator.audio_input.format")
        self.sample_rate = ConfigPath("services.stt.coordinator.audio_input.sample_rate")
        return self


class _ServicesSttCoordinatorMeshSharingConfigPath(ConfigPath):
    allowed_peers: ConfigPath
    fallback: ConfigPath
    max_concurrent: ConfigPath
    min_version: ConfigPath
    prefer: ConfigPath
    required_capabilities: ConfigPath
    share: ConfigPath

    def __new__(cls) -> _ServicesSttCoordinatorMeshSharingConfigPath:
        self = super().__new__(cls, "services.stt.coordinator.mesh_sharing")
        self.allowed_peers = ConfigPath("services.stt.coordinator.mesh_sharing.allowed_peers")
        self.fallback = ConfigPath("services.stt.coordinator.mesh_sharing.fallback")
        self.max_concurrent = ConfigPath("services.stt.coordinator.mesh_sharing.max_concurrent")
        self.min_version = ConfigPath("services.stt.coordinator.mesh_sharing.min_version")
        self.prefer = ConfigPath("services.stt.coordinator.mesh_sharing.prefer")
        self.required_capabilities = ConfigPath(
            "services.stt.coordinator.mesh_sharing.required_capabilities"
        )
        self.share = ConfigPath("services.stt.coordinator.mesh_sharing.share")
        return self


class _ServicesSttTranscriptionAccurateModelConfigPath(ConfigPath):
    compute_type: ConfigPath
    device: ConfigPath
    enabled: ConfigPath
    model_size: ConfigPath

    def __new__(cls) -> _ServicesSttTranscriptionAccurateModelConfigPath:
        self = super().__new__(cls, "services.stt.transcription.accurate_model")
        self.compute_type = ConfigPath("services.stt.transcription.accurate_model.compute_type")
        self.device = ConfigPath("services.stt.transcription.accurate_model.device")
        self.enabled = ConfigPath("services.stt.transcription.accurate_model.enabled")
        self.model_size = ConfigPath("services.stt.transcription.accurate_model.model_size")
        return self


class _ServicesSttTranscriptionMeshSharingConfigPath(ConfigPath):
    allowed_peers: ConfigPath
    fallback: ConfigPath
    max_concurrent: ConfigPath
    min_version: ConfigPath
    prefer: ConfigPath
    required_capabilities: ConfigPath
    share: ConfigPath

    def __new__(cls) -> _ServicesSttTranscriptionMeshSharingConfigPath:
        self = super().__new__(cls, "services.stt.transcription.mesh_sharing")
        self.allowed_peers = ConfigPath("services.stt.transcription.mesh_sharing.allowed_peers")
        self.fallback = ConfigPath("services.stt.transcription.mesh_sharing.fallback")
        self.max_concurrent = ConfigPath("services.stt.transcription.mesh_sharing.max_concurrent")
        self.min_version = ConfigPath("services.stt.transcription.mesh_sharing.min_version")
        self.prefer = ConfigPath("services.stt.transcription.mesh_sharing.prefer")
        self.required_capabilities = ConfigPath(
            "services.stt.transcription.mesh_sharing.required_capabilities"
        )
        self.share = ConfigPath("services.stt.transcription.mesh_sharing.share")
        return self


class _ServicesSttTranscriptionRealtimeModelConfigPath(ConfigPath):
    compute_type: ConfigPath
    device: ConfigPath
    enabled: ConfigPath
    model_size: ConfigPath

    def __new__(cls) -> _ServicesSttTranscriptionRealtimeModelConfigPath:
        self = super().__new__(cls, "services.stt.transcription.realtime_model")
        self.compute_type = ConfigPath("services.stt.transcription.realtime_model.compute_type")
        self.device = ConfigPath("services.stt.transcription.realtime_model.device")
        self.enabled = ConfigPath("services.stt.transcription.realtime_model.enabled")
        self.model_size = ConfigPath("services.stt.transcription.realtime_model.model_size")
        return self


class _ServicesSttWakewordMeshSharingConfigPath(ConfigPath):
    allowed_peers: ConfigPath
    fallback: ConfigPath
    max_concurrent: ConfigPath
    min_version: ConfigPath
    prefer: ConfigPath
    required_capabilities: ConfigPath
    share: ConfigPath

    def __new__(cls) -> _ServicesSttWakewordMeshSharingConfigPath:
        self = super().__new__(cls, "services.stt.wakeword.mesh_sharing")
        self.allowed_peers = ConfigPath("services.stt.wakeword.mesh_sharing.allowed_peers")
        self.fallback = ConfigPath("services.stt.wakeword.mesh_sharing.fallback")
        self.max_concurrent = ConfigPath("services.stt.wakeword.mesh_sharing.max_concurrent")
        self.min_version = ConfigPath("services.stt.wakeword.mesh_sharing.min_version")
        self.prefer = ConfigPath("services.stt.wakeword.mesh_sharing.prefer")
        self.required_capabilities = ConfigPath(
            "services.stt.wakeword.mesh_sharing.required_capabilities"
        )
        self.share = ConfigPath("services.stt.wakeword.mesh_sharing.share")
        return self


class _ServicesToolingPluginsBraveSearchConfigPath(ConfigPath):
    activate: ConfigPath
    api_key: ConfigPath

    def __new__(cls) -> _ServicesToolingPluginsBraveSearchConfigPath:
        self = super().__new__(cls, "services.tooling.plugins.brave_search")
        self.activate = ConfigPath("services.tooling.plugins.brave_search.activate")
        self.api_key = ConfigPath("services.tooling.plugins.brave_search.api_key")
        return self


class _ServicesToolingPluginsGcalendarConfigPath(ConfigPath):
    activate: ConfigPath

    def __new__(cls) -> _ServicesToolingPluginsGcalendarConfigPath:
        self = super().__new__(cls, "services.tooling.plugins.gcalendar")
        self.activate = ConfigPath("services.tooling.plugins.gcalendar.activate")
        return self


class _ServicesToolingPluginsGithubConfigPath(ConfigPath):
    activate: ConfigPath
    app_id: ConfigPath
    app_private_key: ConfigPath
    repository: ConfigPath

    def __new__(cls) -> _ServicesToolingPluginsGithubConfigPath:
        self = super().__new__(cls, "services.tooling.plugins.github")
        self.activate = ConfigPath("services.tooling.plugins.github.activate")
        self.app_id = ConfigPath("services.tooling.plugins.github.app_id")
        self.app_private_key = ConfigPath("services.tooling.plugins.github.app_private_key")
        self.repository = ConfigPath("services.tooling.plugins.github.repository")
        return self


class _ServicesToolingPluginsGmailConfigPath(ConfigPath):
    activate: ConfigPath

    def __new__(cls) -> _ServicesToolingPluginsGmailConfigPath:
        self = super().__new__(cls, "services.tooling.plugins.gmail")
        self.activate = ConfigPath("services.tooling.plugins.gmail.activate")
        return self


class _ServicesToolingPluginsGoogleConfigPath(ConfigPath):
    credentials_file: ConfigPath

    def __new__(cls) -> _ServicesToolingPluginsGoogleConfigPath:
        self = super().__new__(cls, "services.tooling.plugins.google")
        self.credentials_file = ConfigPath("services.tooling.plugins.google.credentials_file")
        return self


class _ServicesToolingPluginsJiraConfigPath(ConfigPath):
    activate: ConfigPath
    api_token: ConfigPath
    instance_url: ConfigPath
    username: ConfigPath

    def __new__(cls) -> _ServicesToolingPluginsJiraConfigPath:
        self = super().__new__(cls, "services.tooling.plugins.jira")
        self.activate = ConfigPath("services.tooling.plugins.jira.activate")
        self.api_token = ConfigPath("services.tooling.plugins.jira.api_token")
        self.instance_url = ConfigPath("services.tooling.plugins.jira.instance_url")
        self.username = ConfigPath("services.tooling.plugins.jira.username")
        return self


class _ServicesToolingPluginsOpenrecallConfigPath(ConfigPath):
    activate: ConfigPath

    def __new__(cls) -> _ServicesToolingPluginsOpenrecallConfigPath:
        self = super().__new__(cls, "services.tooling.plugins.openrecall")
        self.activate = ConfigPath("services.tooling.plugins.openrecall.activate")
        return self


class _ServicesToolingPluginsSlackConfigPath(ConfigPath):
    activate: ConfigPath
    user_token: ConfigPath

    def __new__(cls) -> _ServicesToolingPluginsSlackConfigPath:
        self = super().__new__(cls, "services.tooling.plugins.slack")
        self.activate = ConfigPath("services.tooling.plugins.slack.activate")
        self.user_token = ConfigPath("services.tooling.plugins.slack.user_token")
        return self


class _ServicesAuthMeshSharingConfigPath(ConfigPath):
    allowed_peers: ConfigPath
    fallback: ConfigPath
    max_concurrent: ConfigPath
    min_version: ConfigPath
    prefer: ConfigPath
    required_capabilities: ConfigPath
    share: ConfigPath

    def __new__(cls) -> _ServicesAuthMeshSharingConfigPath:
        self = super().__new__(cls, "services.auth.mesh_sharing")
        self.allowed_peers = ConfigPath("services.auth.mesh_sharing.allowed_peers")
        self.fallback = ConfigPath("services.auth.mesh_sharing.fallback")
        self.max_concurrent = ConfigPath("services.auth.mesh_sharing.max_concurrent")
        self.min_version = ConfigPath("services.auth.mesh_sharing.min_version")
        self.prefer = ConfigPath("services.auth.mesh_sharing.prefer")
        self.required_capabilities = ConfigPath("services.auth.mesh_sharing.required_capabilities")
        self.share = ConfigPath("services.auth.mesh_sharing.share")
        return self


class _ServicesConfigMeshSharingConfigPath(ConfigPath):
    allowed_peers: ConfigPath
    fallback: ConfigPath
    max_concurrent: ConfigPath
    min_version: ConfigPath
    prefer: ConfigPath
    required_capabilities: ConfigPath
    share: ConfigPath

    def __new__(cls) -> _ServicesConfigMeshSharingConfigPath:
        self = super().__new__(cls, "services.config.mesh_sharing")
        self.allowed_peers = ConfigPath("services.config.mesh_sharing.allowed_peers")
        self.fallback = ConfigPath("services.config.mesh_sharing.fallback")
        self.max_concurrent = ConfigPath("services.config.mesh_sharing.max_concurrent")
        self.min_version = ConfigPath("services.config.mesh_sharing.min_version")
        self.prefer = ConfigPath("services.config.mesh_sharing.prefer")
        self.required_capabilities = ConfigPath(
            "services.config.mesh_sharing.required_capabilities"
        )
        self.share = ConfigPath("services.config.mesh_sharing.share")
        return self


class _ServicesDbEmbeddingsConfigPath(ConfigPath):
    use_local: ConfigPath

    def __new__(cls) -> _ServicesDbEmbeddingsConfigPath:
        self = super().__new__(cls, "services.db.embeddings")
        self.use_local = ConfigPath("services.db.embeddings.use_local")
        return self


class _ServicesDbMeshSharingConfigPath(ConfigPath):
    allowed_peers: ConfigPath
    fallback: ConfigPath
    max_concurrent: ConfigPath
    min_version: ConfigPath
    prefer: ConfigPath
    required_capabilities: ConfigPath
    share: ConfigPath

    def __new__(cls) -> _ServicesDbMeshSharingConfigPath:
        self = super().__new__(cls, "services.db.mesh_sharing")
        self.allowed_peers = ConfigPath("services.db.mesh_sharing.allowed_peers")
        self.fallback = ConfigPath("services.db.mesh_sharing.fallback")
        self.max_concurrent = ConfigPath("services.db.mesh_sharing.max_concurrent")
        self.min_version = ConfigPath("services.db.mesh_sharing.min_version")
        self.prefer = ConfigPath("services.db.mesh_sharing.prefer")
        self.required_capabilities = ConfigPath("services.db.mesh_sharing.required_capabilities")
        self.share = ConfigPath("services.db.mesh_sharing.share")
        return self


class _ServicesGatewayApiConfigPath(ConfigPath):
    cors: _ServicesGatewayApiCorsConfigPath
    host: ConfigPath
    port: ConfigPath
    request_timeout_s: ConfigPath
    token_secret: ConfigPath

    def __new__(cls) -> _ServicesGatewayApiConfigPath:
        self = super().__new__(cls, "services.gateway.api")
        self.cors = _ServicesGatewayApiCorsConfigPath()
        self.host = ConfigPath("services.gateway.api.host")
        self.port = ConfigPath("services.gateway.api.port")
        self.request_timeout_s = ConfigPath("services.gateway.api.request_timeout_s")
        self.token_secret = ConfigPath("services.gateway.api.token_secret")
        return self


class _ServicesGatewayMeshNetworkConfigPath(ConfigPath):
    enabled: ConfigPath
    node_name: ConfigPath
    peer_selection: ConfigPath
    ping_interval_s: ConfigPath
    registry_announce_interval_s: ConfigPath
    remote_timeout_s: ConfigPath
    stale_peer_timeout_s: ConfigPath
    version_policy: ConfigPath

    def __new__(cls) -> _ServicesGatewayMeshNetworkConfigPath:
        self = super().__new__(cls, "services.gateway.mesh_network")
        self.enabled = ConfigPath("services.gateway.mesh_network.enabled")
        self.node_name = ConfigPath("services.gateway.mesh_network.node_name")
        self.peer_selection = ConfigPath("services.gateway.mesh_network.peer_selection")
        self.ping_interval_s = ConfigPath("services.gateway.mesh_network.ping_interval_s")
        self.registry_announce_interval_s = ConfigPath(
            "services.gateway.mesh_network.registry_announce_interval_s"
        )
        self.remote_timeout_s = ConfigPath("services.gateway.mesh_network.remote_timeout_s")
        self.stale_peer_timeout_s = ConfigPath("services.gateway.mesh_network.stale_peer_timeout_s")
        self.version_policy = ConfigPath("services.gateway.mesh_network.version_policy")
        return self


class _ServicesGatewaySignalingMqttConfigPath(ConfigPath):
    brokers: ConfigPath
    topic_root: ConfigPath

    def __new__(cls) -> _ServicesGatewaySignalingMqttConfigPath:
        self = super().__new__(cls, "services.gateway.signaling_mqtt")
        self.brokers = ConfigPath("services.gateway.signaling_mqtt.brokers")
        self.topic_root = ConfigPath("services.gateway.signaling_mqtt.topic_root")
        return self


class _ServicesGatewayWebrtcConfigPath(ConfigPath):
    app_id: ConfigPath
    enable_app_layer_e2ee: ConfigPath
    enabled: ConfigPath
    encrypt_signaling: ConfigPath
    password: ConfigPath
    room: ConfigPath
    strategy: ConfigPath
    stun_servers: ConfigPath
    turn_servers: ConfigPath

    def __new__(cls) -> _ServicesGatewayWebrtcConfigPath:
        self = super().__new__(cls, "services.gateway.webrtc")
        self.app_id = ConfigPath("services.gateway.webrtc.app_id")
        self.enable_app_layer_e2ee = ConfigPath("services.gateway.webrtc.enable_app_layer_e2ee")
        self.enabled = ConfigPath("services.gateway.webrtc.enabled")
        self.encrypt_signaling = ConfigPath("services.gateway.webrtc.encrypt_signaling")
        self.password = ConfigPath("services.gateway.webrtc.password")
        self.room = ConfigPath("services.gateway.webrtc.room")
        self.strategy = ConfigPath("services.gateway.webrtc.strategy")
        self.stun_servers = ConfigPath("services.gateway.webrtc.stun_servers")
        self.turn_servers = ConfigPath("services.gateway.webrtc.turn_servers")
        return self


class _ServicesOrchestratorLlmConfigPath(ConfigPath):
    local: _ServicesOrchestratorLlmLocalConfigPath
    provider: ConfigPath
    third_party: _ServicesOrchestratorLlmThirdPartyConfigPath

    def __new__(cls) -> _ServicesOrchestratorLlmConfigPath:
        self = super().__new__(cls, "services.orchestrator.llm")
        self.local = _ServicesOrchestratorLlmLocalConfigPath()
        self.provider = ConfigPath("services.orchestrator.llm.provider")
        self.third_party = _ServicesOrchestratorLlmThirdPartyConfigPath()
        return self


class _ServicesOrchestratorMeshSharingConfigPath(ConfigPath):
    allowed_peers: ConfigPath
    fallback: ConfigPath
    max_concurrent: ConfigPath
    min_version: ConfigPath
    prefer: ConfigPath
    required_capabilities: ConfigPath
    share: ConfigPath

    def __new__(cls) -> _ServicesOrchestratorMeshSharingConfigPath:
        self = super().__new__(cls, "services.orchestrator.mesh_sharing")
        self.allowed_peers = ConfigPath("services.orchestrator.mesh_sharing.allowed_peers")
        self.fallback = ConfigPath("services.orchestrator.mesh_sharing.fallback")
        self.max_concurrent = ConfigPath("services.orchestrator.mesh_sharing.max_concurrent")
        self.min_version = ConfigPath("services.orchestrator.mesh_sharing.min_version")
        self.prefer = ConfigPath("services.orchestrator.mesh_sharing.prefer")
        self.required_capabilities = ConfigPath(
            "services.orchestrator.mesh_sharing.required_capabilities"
        )
        self.share = ConfigPath("services.orchestrator.mesh_sharing.share")
        return self


class _ServicesSchedulerMeshSharingConfigPath(ConfigPath):
    allowed_peers: ConfigPath
    fallback: ConfigPath
    max_concurrent: ConfigPath
    min_version: ConfigPath
    prefer: ConfigPath
    required_capabilities: ConfigPath
    share: ConfigPath

    def __new__(cls) -> _ServicesSchedulerMeshSharingConfigPath:
        self = super().__new__(cls, "services.scheduler.mesh_sharing")
        self.allowed_peers = ConfigPath("services.scheduler.mesh_sharing.allowed_peers")
        self.fallback = ConfigPath("services.scheduler.mesh_sharing.fallback")
        self.max_concurrent = ConfigPath("services.scheduler.mesh_sharing.max_concurrent")
        self.min_version = ConfigPath("services.scheduler.mesh_sharing.min_version")
        self.prefer = ConfigPath("services.scheduler.mesh_sharing.prefer")
        self.required_capabilities = ConfigPath(
            "services.scheduler.mesh_sharing.required_capabilities"
        )
        self.share = ConfigPath("services.scheduler.mesh_sharing.share")
        return self


class _ServicesSttCoordinatorConfigPath(ConfigPath):
    ambient_transcription: _ServicesSttCoordinatorAmbientTranscriptionConfigPath
    audio_input: _ServicesSttCoordinatorAudioInputConfigPath
    enabled: ConfigPath
    mesh_sharing: _ServicesSttCoordinatorMeshSharingConfigPath
    multi_turn_enabled: ConfigPath
    pause_tts_on_listen: ConfigPath
    session_timeout_s: ConfigPath

    def __new__(cls) -> _ServicesSttCoordinatorConfigPath:
        self = super().__new__(cls, "services.stt.coordinator")
        self.ambient_transcription = _ServicesSttCoordinatorAmbientTranscriptionConfigPath()
        self.audio_input = _ServicesSttCoordinatorAudioInputConfigPath()
        self.enabled = ConfigPath("services.stt.coordinator.enabled")
        self.mesh_sharing = _ServicesSttCoordinatorMeshSharingConfigPath()
        self.multi_turn_enabled = ConfigPath("services.stt.coordinator.multi_turn_enabled")
        self.pause_tts_on_listen = ConfigPath("services.stt.coordinator.pause_tts_on_listen")
        self.session_timeout_s = ConfigPath("services.stt.coordinator.session_timeout_s")
        return self


class _ServicesSttTranscriptionConfigPath(ConfigPath):
    accurate_model: _ServicesSttTranscriptionAccurateModelConfigPath
    enabled: ConfigPath
    max_speech_duration_s: ConfigPath
    mesh_sharing: _ServicesSttTranscriptionMeshSharingConfigPath
    realtime_model: _ServicesSttTranscriptionRealtimeModelConfigPath
    silence_duration_ms: ConfigPath
    vad_enabled: ConfigPath
    vad_threshold: ConfigPath

    def __new__(cls) -> _ServicesSttTranscriptionConfigPath:
        self = super().__new__(cls, "services.stt.transcription")
        self.accurate_model = _ServicesSttTranscriptionAccurateModelConfigPath()
        self.enabled = ConfigPath("services.stt.transcription.enabled")
        self.max_speech_duration_s = ConfigPath("services.stt.transcription.max_speech_duration_s")
        self.mesh_sharing = _ServicesSttTranscriptionMeshSharingConfigPath()
        self.realtime_model = _ServicesSttTranscriptionRealtimeModelConfigPath()
        self.silence_duration_ms = ConfigPath("services.stt.transcription.silence_duration_ms")
        self.vad_enabled = ConfigPath("services.stt.transcription.vad_enabled")
        self.vad_threshold = ConfigPath("services.stt.transcription.vad_threshold")
        return self


class _ServicesSttWakewordConfigPath(ConfigPath):
    backend: ConfigPath
    enabled: ConfigPath
    inference_framework: ConfigPath
    mesh_sharing: _ServicesSttWakewordMeshSharingConfigPath
    model_path: ConfigPath
    threshold: ConfigPath

    def __new__(cls) -> _ServicesSttWakewordConfigPath:
        self = super().__new__(cls, "services.stt.wakeword")
        self.backend = ConfigPath("services.stt.wakeword.backend")
        self.enabled = ConfigPath("services.stt.wakeword.enabled")
        self.inference_framework = ConfigPath("services.stt.wakeword.inference_framework")
        self.mesh_sharing = _ServicesSttWakewordMeshSharingConfigPath()
        self.model_path = ConfigPath("services.stt.wakeword.model_path")
        self.threshold = ConfigPath("services.stt.wakeword.threshold")
        return self


class _ServicesToolingHardwareAccelerationConfigPath(ConfigPath):
    ocr_bg: ConfigPath
    ocr_curr: ConfigPath

    def __new__(cls) -> _ServicesToolingHardwareAccelerationConfigPath:
        self = super().__new__(cls, "services.tooling.hardware_acceleration")
        self.ocr_bg = ConfigPath("services.tooling.hardware_acceleration.ocr_bg")
        self.ocr_curr = ConfigPath("services.tooling.hardware_acceleration.ocr_curr")
        return self


class _ServicesToolingMcpConfigPath(ConfigPath):
    enabled: ConfigPath
    servers: ConfigPath

    def __new__(cls) -> _ServicesToolingMcpConfigPath:
        self = super().__new__(cls, "services.tooling.mcp")
        self.enabled = ConfigPath("services.tooling.mcp.enabled")
        self.servers = ConfigPath("services.tooling.mcp.servers")
        return self


class _ServicesToolingMeshSharingConfigPath(ConfigPath):
    allowed_peers: ConfigPath
    fallback: ConfigPath
    max_concurrent: ConfigPath
    min_version: ConfigPath
    prefer: ConfigPath
    required_capabilities: ConfigPath
    share: ConfigPath

    def __new__(cls) -> _ServicesToolingMeshSharingConfigPath:
        self = super().__new__(cls, "services.tooling.mesh_sharing")
        self.allowed_peers = ConfigPath("services.tooling.mesh_sharing.allowed_peers")
        self.fallback = ConfigPath("services.tooling.mesh_sharing.fallback")
        self.max_concurrent = ConfigPath("services.tooling.mesh_sharing.max_concurrent")
        self.min_version = ConfigPath("services.tooling.mesh_sharing.min_version")
        self.prefer = ConfigPath("services.tooling.mesh_sharing.prefer")
        self.required_capabilities = ConfigPath(
            "services.tooling.mesh_sharing.required_capabilities"
        )
        self.share = ConfigPath("services.tooling.mesh_sharing.share")
        return self


class _ServicesToolingPluginsConfigPath(ConfigPath):
    brave_search: _ServicesToolingPluginsBraveSearchConfigPath
    gcalendar: _ServicesToolingPluginsGcalendarConfigPath
    github: _ServicesToolingPluginsGithubConfigPath
    gmail: _ServicesToolingPluginsGmailConfigPath
    google: _ServicesToolingPluginsGoogleConfigPath
    jira: _ServicesToolingPluginsJiraConfigPath
    openrecall: _ServicesToolingPluginsOpenrecallConfigPath
    slack: _ServicesToolingPluginsSlackConfigPath

    def __new__(cls) -> _ServicesToolingPluginsConfigPath:
        self = super().__new__(cls, "services.tooling.plugins")
        self.brave_search = _ServicesToolingPluginsBraveSearchConfigPath()
        self.gcalendar = _ServicesToolingPluginsGcalendarConfigPath()
        self.github = _ServicesToolingPluginsGithubConfigPath()
        self.gmail = _ServicesToolingPluginsGmailConfigPath()
        self.google = _ServicesToolingPluginsGoogleConfigPath()
        self.jira = _ServicesToolingPluginsJiraConfigPath()
        self.openrecall = _ServicesToolingPluginsOpenrecallConfigPath()
        self.slack = _ServicesToolingPluginsSlackConfigPath()
        return self


class _ServicesTtsMeshSharingConfigPath(ConfigPath):
    allowed_peers: ConfigPath
    fallback: ConfigPath
    max_concurrent: ConfigPath
    min_version: ConfigPath
    prefer: ConfigPath
    required_capabilities: ConfigPath
    share: ConfigPath

    def __new__(cls) -> _ServicesTtsMeshSharingConfigPath:
        self = super().__new__(cls, "services.tts.mesh_sharing")
        self.allowed_peers = ConfigPath("services.tts.mesh_sharing.allowed_peers")
        self.fallback = ConfigPath("services.tts.mesh_sharing.fallback")
        self.max_concurrent = ConfigPath("services.tts.mesh_sharing.max_concurrent")
        self.min_version = ConfigPath("services.tts.mesh_sharing.min_version")
        self.prefer = ConfigPath("services.tts.mesh_sharing.prefer")
        self.required_capabilities = ConfigPath("services.tts.mesh_sharing.required_capabilities")
        self.share = ConfigPath("services.tts.mesh_sharing.share")
        return self


class _ServicesAuthConfigPath(ConfigPath):
    api_keys: ConfigPath
    audit_enabled: ConfigPath
    audit_retention_days: ConfigPath
    default_pairing_permissions: ConfigPath
    enabled: ConfigPath
    mesh_sharing: _ServicesAuthMeshSharingConfigPath
    pairing_code_expiry_minutes: ConfigPath
    pairing_max_attempts_per_ip: ConfigPath
    session_token_expiry_hours: ConfigPath
    token_expiry_days: ConfigPath
    webrtc_auth_timeout_seconds: ConfigPath
    webrtc_pairing_timeout_seconds: ConfigPath

    def __new__(cls) -> _ServicesAuthConfigPath:
        self = super().__new__(cls, "services.auth")
        self.api_keys = ConfigPath("services.auth.api_keys")
        self.audit_enabled = ConfigPath("services.auth.audit_enabled")
        self.audit_retention_days = ConfigPath("services.auth.audit_retention_days")
        self.default_pairing_permissions = ConfigPath("services.auth.default_pairing_permissions")
        self.enabled = ConfigPath("services.auth.enabled")
        self.mesh_sharing = _ServicesAuthMeshSharingConfigPath()
        self.pairing_code_expiry_minutes = ConfigPath("services.auth.pairing_code_expiry_minutes")
        self.pairing_max_attempts_per_ip = ConfigPath("services.auth.pairing_max_attempts_per_ip")
        self.session_token_expiry_hours = ConfigPath("services.auth.session_token_expiry_hours")
        self.token_expiry_days = ConfigPath("services.auth.token_expiry_days")
        self.webrtc_auth_timeout_seconds = ConfigPath("services.auth.webrtc_auth_timeout_seconds")
        self.webrtc_pairing_timeout_seconds = ConfigPath(
            "services.auth.webrtc_pairing_timeout_seconds"
        )
        return self


class _ServicesConfigConfigPath(ConfigPath):
    enabled: ConfigPath
    mesh_sharing: _ServicesConfigMeshSharingConfigPath

    def __new__(cls) -> _ServicesConfigConfigPath:
        self = super().__new__(cls, "services.config")
        self.enabled = ConfigPath("services.config.enabled")
        self.mesh_sharing = _ServicesConfigMeshSharingConfigPath()
        return self


class _ServicesDbConfigPath(ConfigPath):
    embeddings: _ServicesDbEmbeddingsConfigPath
    enabled: ConfigPath
    mesh_sharing: _ServicesDbMeshSharingConfigPath

    def __new__(cls) -> _ServicesDbConfigPath:
        self = super().__new__(cls, "services.db")
        self.embeddings = _ServicesDbEmbeddingsConfigPath()
        self.enabled = ConfigPath("services.db.enabled")
        self.mesh_sharing = _ServicesDbMeshSharingConfigPath()
        return self


class _ServicesGatewayConfigPath(ConfigPath):
    api: _ServicesGatewayApiConfigPath
    enabled: ConfigPath
    mesh_network: _ServicesGatewayMeshNetworkConfigPath
    signaling_mqtt: _ServicesGatewaySignalingMqttConfigPath
    webrtc: _ServicesGatewayWebrtcConfigPath

    def __new__(cls) -> _ServicesGatewayConfigPath:
        self = super().__new__(cls, "services.gateway")
        self.api = _ServicesGatewayApiConfigPath()
        self.enabled = ConfigPath("services.gateway.enabled")
        self.mesh_network = _ServicesGatewayMeshNetworkConfigPath()
        self.signaling_mqtt = _ServicesGatewaySignalingMqttConfigPath()
        self.webrtc = _ServicesGatewayWebrtcConfigPath()
        return self


class _ServicesOrchestratorConfigPath(ConfigPath):
    enabled: ConfigPath
    hardware_acceleration: ConfigPath
    llm: _ServicesOrchestratorLlmConfigPath
    mesh_sharing: _ServicesOrchestratorMeshSharingConfigPath

    def __new__(cls) -> _ServicesOrchestratorConfigPath:
        self = super().__new__(cls, "services.orchestrator")
        self.enabled = ConfigPath("services.orchestrator.enabled")
        self.hardware_acceleration = ConfigPath("services.orchestrator.hardware_acceleration")
        self.llm = _ServicesOrchestratorLlmConfigPath()
        self.mesh_sharing = _ServicesOrchestratorMeshSharingConfigPath()
        return self


class _ServicesSchedulerConfigPath(ConfigPath):
    enabled: ConfigPath
    mesh_sharing: _ServicesSchedulerMeshSharingConfigPath

    def __new__(cls) -> _ServicesSchedulerConfigPath:
        self = super().__new__(cls, "services.scheduler")
        self.enabled = ConfigPath("services.scheduler.enabled")
        self.mesh_sharing = _ServicesSchedulerMeshSharingConfigPath()
        return self


class _ServicesSttConfigPath(ConfigPath):
    coordinator: _ServicesSttCoordinatorConfigPath
    hardware_acceleration: ConfigPath
    language: ConfigPath
    transcription: _ServicesSttTranscriptionConfigPath
    wakeword: _ServicesSttWakewordConfigPath

    def __new__(cls) -> _ServicesSttConfigPath:
        self = super().__new__(cls, "services.stt")
        self.coordinator = _ServicesSttCoordinatorConfigPath()
        self.hardware_acceleration = ConfigPath("services.stt.hardware_acceleration")
        self.language = ConfigPath("services.stt.language")
        self.transcription = _ServicesSttTranscriptionConfigPath()
        self.wakeword = _ServicesSttWakewordConfigPath()
        return self


class _ServicesToolingConfigPath(ConfigPath):
    enabled: ConfigPath
    hardware_acceleration: _ServicesToolingHardwareAccelerationConfigPath
    mcp: _ServicesToolingMcpConfigPath
    mesh_sharing: _ServicesToolingMeshSharingConfigPath
    plugins: _ServicesToolingPluginsConfigPath

    def __new__(cls) -> _ServicesToolingConfigPath:
        self = super().__new__(cls, "services.tooling")
        self.enabled = ConfigPath("services.tooling.enabled")
        self.hardware_acceleration = _ServicesToolingHardwareAccelerationConfigPath()
        self.mcp = _ServicesToolingMcpConfigPath()
        self.mesh_sharing = _ServicesToolingMeshSharingConfigPath()
        self.plugins = _ServicesToolingPluginsConfigPath()
        return self


class _ServicesTtsConfigPath(ConfigPath):
    enabled: ConfigPath
    hardware_acceleration: ConfigPath
    mesh_sharing: _ServicesTtsMeshSharingConfigPath
    model_config_file_path: ConfigPath
    model_file_path: ConfigPath
    model_sample_rate: ConfigPath
    piper_path: ConfigPath

    def __new__(cls) -> _ServicesTtsConfigPath:
        self = super().__new__(cls, "services.tts")
        self.enabled = ConfigPath("services.tts.enabled")
        self.hardware_acceleration = ConfigPath("services.tts.hardware_acceleration")
        self.mesh_sharing = _ServicesTtsMeshSharingConfigPath()
        self.model_config_file_path = ConfigPath("services.tts.model_config_file_path")
        self.model_file_path = ConfigPath("services.tts.model_file_path")
        self.model_sample_rate = ConfigPath("services.tts.model_sample_rate")
        self.piper_path = ConfigPath("services.tts.piper_path")
        return self


class _ServicesConfigPath(ConfigPath):
    auth: _ServicesAuthConfigPath
    config: _ServicesConfigConfigPath
    db: _ServicesDbConfigPath
    gateway: _ServicesGatewayConfigPath
    orchestrator: _ServicesOrchestratorConfigPath
    scheduler: _ServicesSchedulerConfigPath
    stt: _ServicesSttConfigPath
    tooling: _ServicesToolingConfigPath
    tts: _ServicesTtsConfigPath

    def __new__(cls) -> _ServicesConfigPath:
        self = super().__new__(cls, "services")
        self.auth = _ServicesAuthConfigPath()
        self.config = _ServicesConfigConfigPath()
        self.db = _ServicesDbConfigPath()
        self.gateway = _ServicesGatewayConfigPath()
        self.orchestrator = _ServicesOrchestratorConfigPath()
        self.scheduler = _ServicesSchedulerConfigPath()
        self.stt = _ServicesSttConfigPath()
        self.tooling = _ServicesToolingConfigPath()
        self.tts = _ServicesTtsConfigPath()
        return self


class _SystemConfigPath(ConfigPath):
    models_dir: ConfigPath

    def __new__(cls) -> _SystemConfigPath:
        self = super().__new__(cls, "system")
        self.models_dir = ConfigPath("system.models_dir")
        return self


class _UiConfigPath(ConfigPath):
    activate: ConfigPath
    dark_mode: ConfigPath
    debug: ConfigPath

    def __new__(cls) -> _UiConfigPath:
        self = super().__new__(cls, "ui")
        self.activate = ConfigPath("ui.activate")
        self.dark_mode = ConfigPath("ui.dark_mode")
        self.debug = ConfigPath("ui.debug")
        return self


class _ConfigKeys:
    """Auto-generated from config_schema.json. Do not edit; run `make generate-config`."""

    services: _ServicesConfigPath
    system: _SystemConfigPath
    ui: _UiConfigPath

    def __init__(self) -> None:
        self.services = _ServicesConfigPath()
        self.system = _SystemConfigPath()
        self.ui = _UiConfigPath()


ConfigKeys = _ConfigKeys()
