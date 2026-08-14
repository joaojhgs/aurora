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


class _ServicesOrchestratorLlmMeshPeerConfigPath(ConfigPath):
    peer_id: ConfigPath
    provider_id: ConfigPath
    resource_namespace: ConfigPath
    service_instance_id: ConfigPath
    timeout_s: ConfigPath

    def __new__(cls) -> _ServicesOrchestratorLlmMeshPeerConfigPath:
        self = super().__new__(cls, "services.orchestrator.llm.mesh_peer")
        self.peer_id = ConfigPath("services.orchestrator.llm.mesh_peer.peer_id")
        self.provider_id = ConfigPath("services.orchestrator.llm.mesh_peer.provider_id")
        self.resource_namespace = ConfigPath(
            "services.orchestrator.llm.mesh_peer.resource_namespace"
        )
        self.service_instance_id = ConfigPath(
            "services.orchestrator.llm.mesh_peer.service_instance_id"
        )
        self.timeout_s = ConfigPath("services.orchestrator.llm.mesh_peer.timeout_s")
        return self


class _ServicesOrchestratorLlmRemotePeerConfigPath(ConfigPath):
    peer_id: ConfigPath
    provider_id: ConfigPath
    resource_namespace: ConfigPath
    service_instance_id: ConfigPath
    timeout_s: ConfigPath

    def __new__(cls) -> _ServicesOrchestratorLlmRemotePeerConfigPath:
        self = super().__new__(cls, "services.orchestrator.llm.remote_peer")
        self.peer_id = ConfigPath("services.orchestrator.llm.remote_peer.peer_id")
        self.provider_id = ConfigPath("services.orchestrator.llm.remote_peer.provider_id")
        self.resource_namespace = ConfigPath(
            "services.orchestrator.llm.remote_peer.resource_namespace"
        )
        self.service_instance_id = ConfigPath(
            "services.orchestrator.llm.remote_peer.service_instance_id"
        )
        self.timeout_s = ConfigPath("services.orchestrator.llm.remote_peer.timeout_s")
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


class _ServicesOrchestratorRoutingDispatchDefaultConfigPath(ConfigPath):
    enabled: ConfigPath
    peer_id: ConfigPath
    provider_id: ConfigPath
    resource_namespace: ConfigPath
    service_instance_id: ConfigPath
    timeout_s: ConfigPath

    def __new__(cls) -> _ServicesOrchestratorRoutingDispatchDefaultConfigPath:
        self = super().__new__(cls, "services.orchestrator.routing.dispatch_default")
        self.enabled = ConfigPath("services.orchestrator.routing.dispatch_default.enabled")
        self.peer_id = ConfigPath("services.orchestrator.routing.dispatch_default.peer_id")
        self.provider_id = ConfigPath("services.orchestrator.routing.dispatch_default.provider_id")
        self.resource_namespace = ConfigPath(
            "services.orchestrator.routing.dispatch_default.resource_namespace"
        )
        self.service_instance_id = ConfigPath(
            "services.orchestrator.routing.dispatch_default.service_instance_id"
        )
        self.timeout_s = ConfigPath("services.orchestrator.routing.dispatch_default.timeout_s")
        return self


class _ServicesOrchestratorRoutingInferenceDefaultConfigPath(ConfigPath):
    model_id: ConfigPath
    peer_id: ConfigPath
    provider: ConfigPath
    provider_id: ConfigPath
    resource_namespace: ConfigPath
    service_instance_id: ConfigPath
    timeout_s: ConfigPath

    def __new__(cls) -> _ServicesOrchestratorRoutingInferenceDefaultConfigPath:
        self = super().__new__(cls, "services.orchestrator.routing.inference_default")
        self.model_id = ConfigPath("services.orchestrator.routing.inference_default.model_id")
        self.peer_id = ConfigPath("services.orchestrator.routing.inference_default.peer_id")
        self.provider = ConfigPath("services.orchestrator.routing.inference_default.provider")
        self.provider_id = ConfigPath("services.orchestrator.routing.inference_default.provider_id")
        self.resource_namespace = ConfigPath(
            "services.orchestrator.routing.inference_default.resource_namespace"
        )
        self.service_instance_id = ConfigPath(
            "services.orchestrator.routing.inference_default.service_instance_id"
        )
        self.timeout_s = ConfigPath("services.orchestrator.routing.inference_default.timeout_s")
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


class _ServicesSttCoordinatorMeshRoutingConfigPath(ConfigPath):
    allowed_provider_peer_ids: ConfigPath
    fallback: ConfigPath
    min_version: ConfigPath
    prefer: ConfigPath
    require_explicit_selector: ConfigPath
    required_provider_capability_tags: ConfigPath
    required_provider_feature_ids: ConfigPath

    def __new__(cls) -> _ServicesSttCoordinatorMeshRoutingConfigPath:
        self = super().__new__(cls, "services.stt.coordinator.mesh_routing")
        self.allowed_provider_peer_ids = ConfigPath(
            "services.stt.coordinator.mesh_routing.allowed_provider_peer_ids"
        )
        self.fallback = ConfigPath("services.stt.coordinator.mesh_routing.fallback")
        self.min_version = ConfigPath("services.stt.coordinator.mesh_routing.min_version")
        self.prefer = ConfigPath("services.stt.coordinator.mesh_routing.prefer")
        self.require_explicit_selector = ConfigPath(
            "services.stt.coordinator.mesh_routing.require_explicit_selector"
        )
        self.required_provider_capability_tags = ConfigPath(
            "services.stt.coordinator.mesh_routing.required_provider_capability_tags"
        )
        self.required_provider_feature_ids = ConfigPath(
            "services.stt.coordinator.mesh_routing.required_provider_feature_ids"
        )
        return self


class _ServicesSttCoordinatorMeshSharingConfigPath(ConfigPath):
    allowed_peers: ConfigPath
    fallback: ConfigPath
    max_concurrent: ConfigPath
    min_version: ConfigPath
    prefer: ConfigPath
    require_explicit_selector: ConfigPath
    required_capabilities: ConfigPath
    share: ConfigPath
    unshared_feature_ids: ConfigPath
    unshared_method_ids: ConfigPath

    def __new__(cls) -> _ServicesSttCoordinatorMeshSharingConfigPath:
        self = super().__new__(cls, "services.stt.coordinator.mesh_sharing")
        self.allowed_peers = ConfigPath("services.stt.coordinator.mesh_sharing.allowed_peers")
        self.fallback = ConfigPath("services.stt.coordinator.mesh_sharing.fallback")
        self.max_concurrent = ConfigPath("services.stt.coordinator.mesh_sharing.max_concurrent")
        self.min_version = ConfigPath("services.stt.coordinator.mesh_sharing.min_version")
        self.prefer = ConfigPath("services.stt.coordinator.mesh_sharing.prefer")
        self.require_explicit_selector = ConfigPath(
            "services.stt.coordinator.mesh_sharing.require_explicit_selector"
        )
        self.required_capabilities = ConfigPath(
            "services.stt.coordinator.mesh_sharing.required_capabilities"
        )
        self.share = ConfigPath("services.stt.coordinator.mesh_sharing.share")
        self.unshared_feature_ids = ConfigPath(
            "services.stt.coordinator.mesh_sharing.unshared_feature_ids"
        )
        self.unshared_method_ids = ConfigPath(
            "services.stt.coordinator.mesh_sharing.unshared_method_ids"
        )
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


class _ServicesSttTranscriptionMeshRoutingConfigPath(ConfigPath):
    allowed_provider_peer_ids: ConfigPath
    fallback: ConfigPath
    min_version: ConfigPath
    prefer: ConfigPath
    require_explicit_selector: ConfigPath
    required_provider_capability_tags: ConfigPath
    required_provider_feature_ids: ConfigPath

    def __new__(cls) -> _ServicesSttTranscriptionMeshRoutingConfigPath:
        self = super().__new__(cls, "services.stt.transcription.mesh_routing")
        self.allowed_provider_peer_ids = ConfigPath(
            "services.stt.transcription.mesh_routing.allowed_provider_peer_ids"
        )
        self.fallback = ConfigPath("services.stt.transcription.mesh_routing.fallback")
        self.min_version = ConfigPath("services.stt.transcription.mesh_routing.min_version")
        self.prefer = ConfigPath("services.stt.transcription.mesh_routing.prefer")
        self.require_explicit_selector = ConfigPath(
            "services.stt.transcription.mesh_routing.require_explicit_selector"
        )
        self.required_provider_capability_tags = ConfigPath(
            "services.stt.transcription.mesh_routing.required_provider_capability_tags"
        )
        self.required_provider_feature_ids = ConfigPath(
            "services.stt.transcription.mesh_routing.required_provider_feature_ids"
        )
        return self


class _ServicesSttTranscriptionMeshSharingConfigPath(ConfigPath):
    allowed_peers: ConfigPath
    fallback: ConfigPath
    max_concurrent: ConfigPath
    min_version: ConfigPath
    prefer: ConfigPath
    require_explicit_selector: ConfigPath
    required_capabilities: ConfigPath
    share: ConfigPath
    unshared_feature_ids: ConfigPath
    unshared_method_ids: ConfigPath

    def __new__(cls) -> _ServicesSttTranscriptionMeshSharingConfigPath:
        self = super().__new__(cls, "services.stt.transcription.mesh_sharing")
        self.allowed_peers = ConfigPath("services.stt.transcription.mesh_sharing.allowed_peers")
        self.fallback = ConfigPath("services.stt.transcription.mesh_sharing.fallback")
        self.max_concurrent = ConfigPath("services.stt.transcription.mesh_sharing.max_concurrent")
        self.min_version = ConfigPath("services.stt.transcription.mesh_sharing.min_version")
        self.prefer = ConfigPath("services.stt.transcription.mesh_sharing.prefer")
        self.require_explicit_selector = ConfigPath(
            "services.stt.transcription.mesh_sharing.require_explicit_selector"
        )
        self.required_capabilities = ConfigPath(
            "services.stt.transcription.mesh_sharing.required_capabilities"
        )
        self.share = ConfigPath("services.stt.transcription.mesh_sharing.share")
        self.unshared_feature_ids = ConfigPath(
            "services.stt.transcription.mesh_sharing.unshared_feature_ids"
        )
        self.unshared_method_ids = ConfigPath(
            "services.stt.transcription.mesh_sharing.unshared_method_ids"
        )
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


class _ServicesSttWakewordMeshRoutingConfigPath(ConfigPath):
    allowed_provider_peer_ids: ConfigPath
    fallback: ConfigPath
    min_version: ConfigPath
    prefer: ConfigPath
    require_explicit_selector: ConfigPath
    required_provider_capability_tags: ConfigPath
    required_provider_feature_ids: ConfigPath

    def __new__(cls) -> _ServicesSttWakewordMeshRoutingConfigPath:
        self = super().__new__(cls, "services.stt.wakeword.mesh_routing")
        self.allowed_provider_peer_ids = ConfigPath(
            "services.stt.wakeword.mesh_routing.allowed_provider_peer_ids"
        )
        self.fallback = ConfigPath("services.stt.wakeword.mesh_routing.fallback")
        self.min_version = ConfigPath("services.stt.wakeword.mesh_routing.min_version")
        self.prefer = ConfigPath("services.stt.wakeword.mesh_routing.prefer")
        self.require_explicit_selector = ConfigPath(
            "services.stt.wakeword.mesh_routing.require_explicit_selector"
        )
        self.required_provider_capability_tags = ConfigPath(
            "services.stt.wakeword.mesh_routing.required_provider_capability_tags"
        )
        self.required_provider_feature_ids = ConfigPath(
            "services.stt.wakeword.mesh_routing.required_provider_feature_ids"
        )
        return self


class _ServicesSttWakewordMeshSharingConfigPath(ConfigPath):
    allowed_peers: ConfigPath
    fallback: ConfigPath
    max_concurrent: ConfigPath
    min_version: ConfigPath
    prefer: ConfigPath
    require_explicit_selector: ConfigPath
    required_capabilities: ConfigPath
    share: ConfigPath
    unshared_feature_ids: ConfigPath
    unshared_method_ids: ConfigPath

    def __new__(cls) -> _ServicesSttWakewordMeshSharingConfigPath:
        self = super().__new__(cls, "services.stt.wakeword.mesh_sharing")
        self.allowed_peers = ConfigPath("services.stt.wakeword.mesh_sharing.allowed_peers")
        self.fallback = ConfigPath("services.stt.wakeword.mesh_sharing.fallback")
        self.max_concurrent = ConfigPath("services.stt.wakeword.mesh_sharing.max_concurrent")
        self.min_version = ConfigPath("services.stt.wakeword.mesh_sharing.min_version")
        self.prefer = ConfigPath("services.stt.wakeword.mesh_sharing.prefer")
        self.require_explicit_selector = ConfigPath(
            "services.stt.wakeword.mesh_sharing.require_explicit_selector"
        )
        self.required_capabilities = ConfigPath(
            "services.stt.wakeword.mesh_sharing.required_capabilities"
        )
        self.share = ConfigPath("services.stt.wakeword.mesh_sharing.share")
        self.unshared_feature_ids = ConfigPath(
            "services.stt.wakeword.mesh_sharing.unshared_feature_ids"
        )
        self.unshared_method_ids = ConfigPath(
            "services.stt.wakeword.mesh_sharing.unshared_method_ids"
        )
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


class _ServicesTtsProvidersPiperConfigPath(ConfigPath):
    executable_path: ConfigPath
    model_config_file_path: ConfigPath
    model_file_path: ConfigPath
    model_sample_rate: ConfigPath

    def __new__(cls) -> _ServicesTtsProvidersPiperConfigPath:
        self = super().__new__(cls, "services.tts.providers.piper")
        self.executable_path = ConfigPath("services.tts.providers.piper.executable_path")
        self.model_config_file_path = ConfigPath(
            "services.tts.providers.piper.model_config_file_path"
        )
        self.model_file_path = ConfigPath("services.tts.providers.piper.model_file_path")
        self.model_sample_rate = ConfigPath("services.tts.providers.piper.model_sample_rate")
        return self


class _ServicesTtsProvidersPocketttsConfigPath(ConfigPath):
    cache_dir: ConfigPath
    custom_config_path: ConfigPath
    device: ConfigPath
    eos_threshold: ConfigPath
    initialization_timeout_s: ConfigPath
    lsd_decode_steps: ConfigPath
    max_concurrent_requests: ConfigPath
    noise_clamp: ConfigPath
    preload_model: ConfigPath
    preload_voice_ids: ConfigPath
    quality_tier: ConfigPath
    quantize: ConfigPath
    request_timeout_s: ConfigPath
    temperature: ConfigPath
    voice_state_dir: ConfigPath

    def __new__(cls) -> _ServicesTtsProvidersPocketttsConfigPath:
        self = super().__new__(cls, "services.tts.providers.pockettts")
        self.cache_dir = ConfigPath("services.tts.providers.pockettts.cache_dir")
        self.custom_config_path = ConfigPath("services.tts.providers.pockettts.custom_config_path")
        self.device = ConfigPath("services.tts.providers.pockettts.device")
        self.eos_threshold = ConfigPath("services.tts.providers.pockettts.eos_threshold")
        self.initialization_timeout_s = ConfigPath(
            "services.tts.providers.pockettts.initialization_timeout_s"
        )
        self.lsd_decode_steps = ConfigPath("services.tts.providers.pockettts.lsd_decode_steps")
        self.max_concurrent_requests = ConfigPath(
            "services.tts.providers.pockettts.max_concurrent_requests"
        )
        self.noise_clamp = ConfigPath("services.tts.providers.pockettts.noise_clamp")
        self.preload_model = ConfigPath("services.tts.providers.pockettts.preload_model")
        self.preload_voice_ids = ConfigPath("services.tts.providers.pockettts.preload_voice_ids")
        self.quality_tier = ConfigPath("services.tts.providers.pockettts.quality_tier")
        self.quantize = ConfigPath("services.tts.providers.pockettts.quantize")
        self.request_timeout_s = ConfigPath("services.tts.providers.pockettts.request_timeout_s")
        self.temperature = ConfigPath("services.tts.providers.pockettts.temperature")
        self.voice_state_dir = ConfigPath("services.tts.providers.pockettts.voice_state_dir")
        return self


class _ServicesDbEmbeddingsConfigPath(ConfigPath):
    use_local: ConfigPath

    def __new__(cls) -> _ServicesDbEmbeddingsConfigPath:
        self = super().__new__(cls, "services.db.embeddings")
        self.use_local = ConfigPath("services.db.embeddings.use_local")
        return self


class _ServicesDbMeshRoutingConfigPath(ConfigPath):
    allowed_provider_peer_ids: ConfigPath
    fallback: ConfigPath
    min_version: ConfigPath
    prefer: ConfigPath
    require_explicit_selector: ConfigPath
    required_provider_capability_tags: ConfigPath
    required_provider_feature_ids: ConfigPath

    def __new__(cls) -> _ServicesDbMeshRoutingConfigPath:
        self = super().__new__(cls, "services.db.mesh_routing")
        self.allowed_provider_peer_ids = ConfigPath(
            "services.db.mesh_routing.allowed_provider_peer_ids"
        )
        self.fallback = ConfigPath("services.db.mesh_routing.fallback")
        self.min_version = ConfigPath("services.db.mesh_routing.min_version")
        self.prefer = ConfigPath("services.db.mesh_routing.prefer")
        self.require_explicit_selector = ConfigPath(
            "services.db.mesh_routing.require_explicit_selector"
        )
        self.required_provider_capability_tags = ConfigPath(
            "services.db.mesh_routing.required_provider_capability_tags"
        )
        self.required_provider_feature_ids = ConfigPath(
            "services.db.mesh_routing.required_provider_feature_ids"
        )
        return self


class _ServicesDbMeshSharingConfigPath(ConfigPath):
    allowed_peers: ConfigPath
    fallback: ConfigPath
    max_concurrent: ConfigPath
    min_version: ConfigPath
    prefer: ConfigPath
    require_explicit_selector: ConfigPath
    required_capabilities: ConfigPath
    share: ConfigPath
    unshared_feature_ids: ConfigPath
    unshared_method_ids: ConfigPath

    def __new__(cls) -> _ServicesDbMeshSharingConfigPath:
        self = super().__new__(cls, "services.db.mesh_sharing")
        self.allowed_peers = ConfigPath("services.db.mesh_sharing.allowed_peers")
        self.fallback = ConfigPath("services.db.mesh_sharing.fallback")
        self.max_concurrent = ConfigPath("services.db.mesh_sharing.max_concurrent")
        self.min_version = ConfigPath("services.db.mesh_sharing.min_version")
        self.prefer = ConfigPath("services.db.mesh_sharing.prefer")
        self.require_explicit_selector = ConfigPath(
            "services.db.mesh_sharing.require_explicit_selector"
        )
        self.required_capabilities = ConfigPath("services.db.mesh_sharing.required_capabilities")
        self.share = ConfigPath("services.db.mesh_sharing.share")
        self.unshared_feature_ids = ConfigPath("services.db.mesh_sharing.unshared_feature_ids")
        self.unshared_method_ids = ConfigPath("services.db.mesh_sharing.unshared_method_ids")
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
    legacy_event_broadcast: ConfigPath
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
        self.legacy_event_broadcast = ConfigPath("services.gateway.webrtc.legacy_event_broadcast")
        self.password = ConfigPath("services.gateway.webrtc.password")
        self.room = ConfigPath("services.gateway.webrtc.room")
        self.strategy = ConfigPath("services.gateway.webrtc.strategy")
        self.stun_servers = ConfigPath("services.gateway.webrtc.stun_servers")
        self.turn_servers = ConfigPath("services.gateway.webrtc.turn_servers")
        return self


class _ServicesOrchestratorLlmConfigPath(ConfigPath):
    local: _ServicesOrchestratorLlmLocalConfigPath
    mesh_peer: _ServicesOrchestratorLlmMeshPeerConfigPath
    provider: ConfigPath
    remote_peer: _ServicesOrchestratorLlmRemotePeerConfigPath
    third_party: _ServicesOrchestratorLlmThirdPartyConfigPath

    def __new__(cls) -> _ServicesOrchestratorLlmConfigPath:
        self = super().__new__(cls, "services.orchestrator.llm")
        self.local = _ServicesOrchestratorLlmLocalConfigPath()
        self.mesh_peer = _ServicesOrchestratorLlmMeshPeerConfigPath()
        self.provider = ConfigPath("services.orchestrator.llm.provider")
        self.remote_peer = _ServicesOrchestratorLlmRemotePeerConfigPath()
        self.third_party = _ServicesOrchestratorLlmThirdPartyConfigPath()
        return self


class _ServicesOrchestratorMeshRoutingConfigPath(ConfigPath):
    allowed_provider_peer_ids: ConfigPath
    fallback: ConfigPath
    min_version: ConfigPath
    prefer: ConfigPath
    require_explicit_selector: ConfigPath
    required_provider_capability_tags: ConfigPath
    required_provider_feature_ids: ConfigPath

    def __new__(cls) -> _ServicesOrchestratorMeshRoutingConfigPath:
        self = super().__new__(cls, "services.orchestrator.mesh_routing")
        self.allowed_provider_peer_ids = ConfigPath(
            "services.orchestrator.mesh_routing.allowed_provider_peer_ids"
        )
        self.fallback = ConfigPath("services.orchestrator.mesh_routing.fallback")
        self.min_version = ConfigPath("services.orchestrator.mesh_routing.min_version")
        self.prefer = ConfigPath("services.orchestrator.mesh_routing.prefer")
        self.require_explicit_selector = ConfigPath(
            "services.orchestrator.mesh_routing.require_explicit_selector"
        )
        self.required_provider_capability_tags = ConfigPath(
            "services.orchestrator.mesh_routing.required_provider_capability_tags"
        )
        self.required_provider_feature_ids = ConfigPath(
            "services.orchestrator.mesh_routing.required_provider_feature_ids"
        )
        return self


class _ServicesOrchestratorMeshSharingConfigPath(ConfigPath):
    allowed_peers: ConfigPath
    fallback: ConfigPath
    max_concurrent: ConfigPath
    min_version: ConfigPath
    prefer: ConfigPath
    require_explicit_selector: ConfigPath
    required_capabilities: ConfigPath
    share: ConfigPath
    unshared_feature_ids: ConfigPath
    unshared_method_ids: ConfigPath

    def __new__(cls) -> _ServicesOrchestratorMeshSharingConfigPath:
        self = super().__new__(cls, "services.orchestrator.mesh_sharing")
        self.allowed_peers = ConfigPath("services.orchestrator.mesh_sharing.allowed_peers")
        self.fallback = ConfigPath("services.orchestrator.mesh_sharing.fallback")
        self.max_concurrent = ConfigPath("services.orchestrator.mesh_sharing.max_concurrent")
        self.min_version = ConfigPath("services.orchestrator.mesh_sharing.min_version")
        self.prefer = ConfigPath("services.orchestrator.mesh_sharing.prefer")
        self.require_explicit_selector = ConfigPath(
            "services.orchestrator.mesh_sharing.require_explicit_selector"
        )
        self.required_capabilities = ConfigPath(
            "services.orchestrator.mesh_sharing.required_capabilities"
        )
        self.share = ConfigPath("services.orchestrator.mesh_sharing.share")
        self.unshared_feature_ids = ConfigPath(
            "services.orchestrator.mesh_sharing.unshared_feature_ids"
        )
        self.unshared_method_ids = ConfigPath(
            "services.orchestrator.mesh_sharing.unshared_method_ids"
        )
        return self


class _ServicesOrchestratorRoutingConfigPath(ConfigPath):
    dispatch_default: _ServicesOrchestratorRoutingDispatchDefaultConfigPath
    inference_default: _ServicesOrchestratorRoutingInferenceDefaultConfigPath

    def __new__(cls) -> _ServicesOrchestratorRoutingConfigPath:
        self = super().__new__(cls, "services.orchestrator.routing")
        self.dispatch_default = _ServicesOrchestratorRoutingDispatchDefaultConfigPath()
        self.inference_default = _ServicesOrchestratorRoutingInferenceDefaultConfigPath()
        return self


class _ServicesSchedulerMeshRoutingConfigPath(ConfigPath):
    allowed_provider_peer_ids: ConfigPath
    fallback: ConfigPath
    min_version: ConfigPath
    prefer: ConfigPath
    require_explicit_selector: ConfigPath
    required_provider_capability_tags: ConfigPath
    required_provider_feature_ids: ConfigPath

    def __new__(cls) -> _ServicesSchedulerMeshRoutingConfigPath:
        self = super().__new__(cls, "services.scheduler.mesh_routing")
        self.allowed_provider_peer_ids = ConfigPath(
            "services.scheduler.mesh_routing.allowed_provider_peer_ids"
        )
        self.fallback = ConfigPath("services.scheduler.mesh_routing.fallback")
        self.min_version = ConfigPath("services.scheduler.mesh_routing.min_version")
        self.prefer = ConfigPath("services.scheduler.mesh_routing.prefer")
        self.require_explicit_selector = ConfigPath(
            "services.scheduler.mesh_routing.require_explicit_selector"
        )
        self.required_provider_capability_tags = ConfigPath(
            "services.scheduler.mesh_routing.required_provider_capability_tags"
        )
        self.required_provider_feature_ids = ConfigPath(
            "services.scheduler.mesh_routing.required_provider_feature_ids"
        )
        return self


class _ServicesSchedulerMeshSharingConfigPath(ConfigPath):
    allowed_peers: ConfigPath
    fallback: ConfigPath
    max_concurrent: ConfigPath
    min_version: ConfigPath
    prefer: ConfigPath
    require_explicit_selector: ConfigPath
    required_capabilities: ConfigPath
    share: ConfigPath
    unshared_feature_ids: ConfigPath
    unshared_method_ids: ConfigPath

    def __new__(cls) -> _ServicesSchedulerMeshSharingConfigPath:
        self = super().__new__(cls, "services.scheduler.mesh_sharing")
        self.allowed_peers = ConfigPath("services.scheduler.mesh_sharing.allowed_peers")
        self.fallback = ConfigPath("services.scheduler.mesh_sharing.fallback")
        self.max_concurrent = ConfigPath("services.scheduler.mesh_sharing.max_concurrent")
        self.min_version = ConfigPath("services.scheduler.mesh_sharing.min_version")
        self.prefer = ConfigPath("services.scheduler.mesh_sharing.prefer")
        self.require_explicit_selector = ConfigPath(
            "services.scheduler.mesh_sharing.require_explicit_selector"
        )
        self.required_capabilities = ConfigPath(
            "services.scheduler.mesh_sharing.required_capabilities"
        )
        self.share = ConfigPath("services.scheduler.mesh_sharing.share")
        self.unshared_feature_ids = ConfigPath(
            "services.scheduler.mesh_sharing.unshared_feature_ids"
        )
        self.unshared_method_ids = ConfigPath("services.scheduler.mesh_sharing.unshared_method_ids")
        return self


class _ServicesSttCoordinatorConfigPath(ConfigPath):
    ambient_transcription: _ServicesSttCoordinatorAmbientTranscriptionConfigPath
    audio_input: _ServicesSttCoordinatorAudioInputConfigPath
    enabled: ConfigPath
    mesh_routing: _ServicesSttCoordinatorMeshRoutingConfigPath
    mesh_sharing: _ServicesSttCoordinatorMeshSharingConfigPath
    multi_turn_enabled: ConfigPath
    pause_tts_on_listen: ConfigPath
    session_timeout_s: ConfigPath

    def __new__(cls) -> _ServicesSttCoordinatorConfigPath:
        self = super().__new__(cls, "services.stt.coordinator")
        self.ambient_transcription = _ServicesSttCoordinatorAmbientTranscriptionConfigPath()
        self.audio_input = _ServicesSttCoordinatorAudioInputConfigPath()
        self.enabled = ConfigPath("services.stt.coordinator.enabled")
        self.mesh_routing = _ServicesSttCoordinatorMeshRoutingConfigPath()
        self.mesh_sharing = _ServicesSttCoordinatorMeshSharingConfigPath()
        self.multi_turn_enabled = ConfigPath("services.stt.coordinator.multi_turn_enabled")
        self.pause_tts_on_listen = ConfigPath("services.stt.coordinator.pause_tts_on_listen")
        self.session_timeout_s = ConfigPath("services.stt.coordinator.session_timeout_s")
        return self


class _ServicesSttTranscriptionConfigPath(ConfigPath):
    accurate_model: _ServicesSttTranscriptionAccurateModelConfigPath
    enabled: ConfigPath
    max_speech_duration_s: ConfigPath
    mesh_routing: _ServicesSttTranscriptionMeshRoutingConfigPath
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
        self.mesh_routing = _ServicesSttTranscriptionMeshRoutingConfigPath()
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
    mesh_routing: _ServicesSttWakewordMeshRoutingConfigPath
    mesh_sharing: _ServicesSttWakewordMeshSharingConfigPath
    model_path: ConfigPath
    threshold: ConfigPath

    def __new__(cls) -> _ServicesSttWakewordConfigPath:
        self = super().__new__(cls, "services.stt.wakeword")
        self.backend = ConfigPath("services.stt.wakeword.backend")
        self.enabled = ConfigPath("services.stt.wakeword.enabled")
        self.inference_framework = ConfigPath("services.stt.wakeword.inference_framework")
        self.mesh_routing = _ServicesSttWakewordMeshRoutingConfigPath()
        self.mesh_sharing = _ServicesSttWakewordMeshSharingConfigPath()
        self.model_path = ConfigPath("services.stt.wakeword.model_path")
        self.threshold = ConfigPath("services.stt.wakeword.threshold")
        return self


class _ServicesToolingApprovalPolicyConfigPath(ConfigPath):
    default_approval_mode: ConfigPath
    default_share: ConfigPath
    default_token_ttl_seconds: ConfigPath
    policy_mode: ConfigPath
    rules: ConfigPath

    def __new__(cls) -> _ServicesToolingApprovalPolicyConfigPath:
        self = super().__new__(cls, "services.tooling.approval_policy")
        self.default_approval_mode = ConfigPath(
            "services.tooling.approval_policy.default_approval_mode"
        )
        self.default_share = ConfigPath("services.tooling.approval_policy.default_share")
        self.default_token_ttl_seconds = ConfigPath(
            "services.tooling.approval_policy.default_token_ttl_seconds"
        )
        self.policy_mode = ConfigPath("services.tooling.approval_policy.policy_mode")
        self.rules = ConfigPath("services.tooling.approval_policy.rules")
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


class _ServicesToolingMeshRoutingConfigPath(ConfigPath):
    allowed_provider_peer_ids: ConfigPath
    fallback: ConfigPath
    min_version: ConfigPath
    prefer: ConfigPath
    require_explicit_selector: ConfigPath
    required_provider_capability_tags: ConfigPath
    required_provider_feature_ids: ConfigPath

    def __new__(cls) -> _ServicesToolingMeshRoutingConfigPath:
        self = super().__new__(cls, "services.tooling.mesh_routing")
        self.allowed_provider_peer_ids = ConfigPath(
            "services.tooling.mesh_routing.allowed_provider_peer_ids"
        )
        self.fallback = ConfigPath("services.tooling.mesh_routing.fallback")
        self.min_version = ConfigPath("services.tooling.mesh_routing.min_version")
        self.prefer = ConfigPath("services.tooling.mesh_routing.prefer")
        self.require_explicit_selector = ConfigPath(
            "services.tooling.mesh_routing.require_explicit_selector"
        )
        self.required_provider_capability_tags = ConfigPath(
            "services.tooling.mesh_routing.required_provider_capability_tags"
        )
        self.required_provider_feature_ids = ConfigPath(
            "services.tooling.mesh_routing.required_provider_feature_ids"
        )
        return self


class _ServicesToolingMeshSharingConfigPath(ConfigPath):
    allowed_peers: ConfigPath
    fallback: ConfigPath
    max_concurrent: ConfigPath
    min_version: ConfigPath
    prefer: ConfigPath
    require_explicit_selector: ConfigPath
    required_capabilities: ConfigPath
    share: ConfigPath
    unshared_feature_ids: ConfigPath
    unshared_method_ids: ConfigPath

    def __new__(cls) -> _ServicesToolingMeshSharingConfigPath:
        self = super().__new__(cls, "services.tooling.mesh_sharing")
        self.allowed_peers = ConfigPath("services.tooling.mesh_sharing.allowed_peers")
        self.fallback = ConfigPath("services.tooling.mesh_sharing.fallback")
        self.max_concurrent = ConfigPath("services.tooling.mesh_sharing.max_concurrent")
        self.min_version = ConfigPath("services.tooling.mesh_sharing.min_version")
        self.prefer = ConfigPath("services.tooling.mesh_sharing.prefer")
        self.require_explicit_selector = ConfigPath(
            "services.tooling.mesh_sharing.require_explicit_selector"
        )
        self.required_capabilities = ConfigPath(
            "services.tooling.mesh_sharing.required_capabilities"
        )
        self.share = ConfigPath("services.tooling.mesh_sharing.share")
        self.unshared_feature_ids = ConfigPath("services.tooling.mesh_sharing.unshared_feature_ids")
        self.unshared_method_ids = ConfigPath("services.tooling.mesh_sharing.unshared_method_ids")
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


class _ServicesTtsMeshRoutingConfigPath(ConfigPath):
    allowed_provider_peer_ids: ConfigPath
    fallback: ConfigPath
    min_version: ConfigPath
    prefer: ConfigPath
    require_explicit_selector: ConfigPath
    required_provider_capability_tags: ConfigPath
    required_provider_feature_ids: ConfigPath

    def __new__(cls) -> _ServicesTtsMeshRoutingConfigPath:
        self = super().__new__(cls, "services.tts.mesh_routing")
        self.allowed_provider_peer_ids = ConfigPath(
            "services.tts.mesh_routing.allowed_provider_peer_ids"
        )
        self.fallback = ConfigPath("services.tts.mesh_routing.fallback")
        self.min_version = ConfigPath("services.tts.mesh_routing.min_version")
        self.prefer = ConfigPath("services.tts.mesh_routing.prefer")
        self.require_explicit_selector = ConfigPath(
            "services.tts.mesh_routing.require_explicit_selector"
        )
        self.required_provider_capability_tags = ConfigPath(
            "services.tts.mesh_routing.required_provider_capability_tags"
        )
        self.required_provider_feature_ids = ConfigPath(
            "services.tts.mesh_routing.required_provider_feature_ids"
        )
        return self


class _ServicesTtsMeshSharingConfigPath(ConfigPath):
    allowed_peers: ConfigPath
    fallback: ConfigPath
    max_concurrent: ConfigPath
    min_version: ConfigPath
    prefer: ConfigPath
    require_explicit_selector: ConfigPath
    required_capabilities: ConfigPath
    share: ConfigPath
    unshared_feature_ids: ConfigPath
    unshared_method_ids: ConfigPath

    def __new__(cls) -> _ServicesTtsMeshSharingConfigPath:
        self = super().__new__(cls, "services.tts.mesh_sharing")
        self.allowed_peers = ConfigPath("services.tts.mesh_sharing.allowed_peers")
        self.fallback = ConfigPath("services.tts.mesh_sharing.fallback")
        self.max_concurrent = ConfigPath("services.tts.mesh_sharing.max_concurrent")
        self.min_version = ConfigPath("services.tts.mesh_sharing.min_version")
        self.prefer = ConfigPath("services.tts.mesh_sharing.prefer")
        self.require_explicit_selector = ConfigPath(
            "services.tts.mesh_sharing.require_explicit_selector"
        )
        self.required_capabilities = ConfigPath("services.tts.mesh_sharing.required_capabilities")
        self.share = ConfigPath("services.tts.mesh_sharing.share")
        self.unshared_feature_ids = ConfigPath("services.tts.mesh_sharing.unshared_feature_ids")
        self.unshared_method_ids = ConfigPath("services.tts.mesh_sharing.unshared_method_ids")
        return self


class _ServicesTtsProvidersConfigPath(ConfigPath):
    piper: _ServicesTtsProvidersPiperConfigPath
    pockettts: _ServicesTtsProvidersPocketttsConfigPath

    def __new__(cls) -> _ServicesTtsProvidersConfigPath:
        self = super().__new__(cls, "services.tts.providers")
        self.piper = _ServicesTtsProvidersPiperConfigPath()
        self.pockettts = _ServicesTtsProvidersPocketttsConfigPath()
        return self


class _ServicesTtsVoiceRegistryConfigPath(ConfigPath):
    accepted_import_formats: ConfigPath
    asset_base_url: ConfigPath
    cache_dir: ConfigPath
    clone_max_duration_s: ConfigPath
    clone_max_source_bytes: ConfigPath
    clone_max_wire_bytes: ConfigPath
    clone_min_duration_s: ConfigPath
    cloning_enabled: ConfigPath
    manifest_path: ConfigPath
    retain_clone_source: ConfigPath
    standard_pack_enabled: ConfigPath
    trusted_manifest_public_keys: ConfigPath
    trusted_manifest_sha256: ConfigPath
    trusted_manifest_signature: ConfigPath
    verify_sha256: ConfigPath

    def __new__(cls) -> _ServicesTtsVoiceRegistryConfigPath:
        self = super().__new__(cls, "services.tts.voice_registry")
        self.accepted_import_formats = ConfigPath(
            "services.tts.voice_registry.accepted_import_formats"
        )
        self.asset_base_url = ConfigPath("services.tts.voice_registry.asset_base_url")
        self.cache_dir = ConfigPath("services.tts.voice_registry.cache_dir")
        self.clone_max_duration_s = ConfigPath("services.tts.voice_registry.clone_max_duration_s")
        self.clone_max_source_bytes = ConfigPath(
            "services.tts.voice_registry.clone_max_source_bytes"
        )
        self.clone_max_wire_bytes = ConfigPath("services.tts.voice_registry.clone_max_wire_bytes")
        self.clone_min_duration_s = ConfigPath("services.tts.voice_registry.clone_min_duration_s")
        self.cloning_enabled = ConfigPath("services.tts.voice_registry.cloning_enabled")
        self.manifest_path = ConfigPath("services.tts.voice_registry.manifest_path")
        self.retain_clone_source = ConfigPath("services.tts.voice_registry.retain_clone_source")
        self.standard_pack_enabled = ConfigPath("services.tts.voice_registry.standard_pack_enabled")
        self.trusted_manifest_public_keys = ConfigPath(
            "services.tts.voice_registry.trusted_manifest_public_keys"
        )
        self.trusted_manifest_sha256 = ConfigPath(
            "services.tts.voice_registry.trusted_manifest_sha256"
        )
        self.trusted_manifest_signature = ConfigPath(
            "services.tts.voice_registry.trusted_manifest_signature"
        )
        self.verify_sha256 = ConfigPath("services.tts.voice_registry.verify_sha256")
        return self


class _ServicesAuthConfigPath(ConfigPath):
    api_keys: ConfigPath
    audit_enabled: ConfigPath
    audit_retention_days: ConfigPath
    default_pairing_permissions: ConfigPath
    enabled: ConfigPath
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

    def __new__(cls) -> _ServicesConfigConfigPath:
        self = super().__new__(cls, "services.config")
        self.enabled = ConfigPath("services.config.enabled")
        return self


class _ServicesDbConfigPath(ConfigPath):
    embeddings: _ServicesDbEmbeddingsConfigPath
    enabled: ConfigPath
    mesh_routing: _ServicesDbMeshRoutingConfigPath
    mesh_sharing: _ServicesDbMeshSharingConfigPath

    def __new__(cls) -> _ServicesDbConfigPath:
        self = super().__new__(cls, "services.db")
        self.embeddings = _ServicesDbEmbeddingsConfigPath()
        self.enabled = ConfigPath("services.db.enabled")
        self.mesh_routing = _ServicesDbMeshRoutingConfigPath()
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
    mesh_routing: _ServicesOrchestratorMeshRoutingConfigPath
    mesh_sharing: _ServicesOrchestratorMeshSharingConfigPath
    routing: _ServicesOrchestratorRoutingConfigPath

    def __new__(cls) -> _ServicesOrchestratorConfigPath:
        self = super().__new__(cls, "services.orchestrator")
        self.enabled = ConfigPath("services.orchestrator.enabled")
        self.hardware_acceleration = ConfigPath("services.orchestrator.hardware_acceleration")
        self.llm = _ServicesOrchestratorLlmConfigPath()
        self.mesh_routing = _ServicesOrchestratorMeshRoutingConfigPath()
        self.mesh_sharing = _ServicesOrchestratorMeshSharingConfigPath()
        self.routing = _ServicesOrchestratorRoutingConfigPath()
        return self


class _ServicesSchedulerConfigPath(ConfigPath):
    enabled: ConfigPath
    mesh_routing: _ServicesSchedulerMeshRoutingConfigPath
    mesh_sharing: _ServicesSchedulerMeshSharingConfigPath

    def __new__(cls) -> _ServicesSchedulerConfigPath:
        self = super().__new__(cls, "services.scheduler")
        self.enabled = ConfigPath("services.scheduler.enabled")
        self.mesh_routing = _ServicesSchedulerMeshRoutingConfigPath()
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
    approval_policy: _ServicesToolingApprovalPolicyConfigPath
    enabled: ConfigPath
    hardware_acceleration: _ServicesToolingHardwareAccelerationConfigPath
    mcp: _ServicesToolingMcpConfigPath
    mesh_routing: _ServicesToolingMeshRoutingConfigPath
    mesh_sharing: _ServicesToolingMeshSharingConfigPath
    plugins: _ServicesToolingPluginsConfigPath

    def __new__(cls) -> _ServicesToolingConfigPath:
        self = super().__new__(cls, "services.tooling")
        self.approval_policy = _ServicesToolingApprovalPolicyConfigPath()
        self.enabled = ConfigPath("services.tooling.enabled")
        self.hardware_acceleration = _ServicesToolingHardwareAccelerationConfigPath()
        self.mcp = _ServicesToolingMcpConfigPath()
        self.mesh_routing = _ServicesToolingMeshRoutingConfigPath()
        self.mesh_sharing = _ServicesToolingMeshSharingConfigPath()
        self.plugins = _ServicesToolingPluginsConfigPath()
        return self


class _ServicesTtsConfigPath(ConfigPath):
    default_voice_id: ConfigPath
    enabled: ConfigPath
    fallback_provider: ConfigPath
    hardware_acceleration: ConfigPath
    mesh_routing: _ServicesTtsMeshRoutingConfigPath
    mesh_sharing: _ServicesTtsMeshSharingConfigPath
    model_config_file_path: ConfigPath
    model_file_path: ConfigPath
    model_sample_rate: ConfigPath
    piper_path: ConfigPath
    provider: ConfigPath
    providers: _ServicesTtsProvidersConfigPath
    voice_registry: _ServicesTtsVoiceRegistryConfigPath

    def __new__(cls) -> _ServicesTtsConfigPath:
        self = super().__new__(cls, "services.tts")
        self.default_voice_id = ConfigPath("services.tts.default_voice_id")
        self.enabled = ConfigPath("services.tts.enabled")
        self.fallback_provider = ConfigPath("services.tts.fallback_provider")
        self.hardware_acceleration = ConfigPath("services.tts.hardware_acceleration")
        self.mesh_routing = _ServicesTtsMeshRoutingConfigPath()
        self.mesh_sharing = _ServicesTtsMeshSharingConfigPath()
        self.model_config_file_path = ConfigPath("services.tts.model_config_file_path")
        self.model_file_path = ConfigPath("services.tts.model_file_path")
        self.model_sample_rate = ConfigPath("services.tts.model_sample_rate")
        self.piper_path = ConfigPath("services.tts.piper_path")
        self.provider = ConfigPath("services.tts.provider")
        self.providers = _ServicesTtsProvidersConfigPath()
        self.voice_registry = _ServicesTtsVoiceRegistryConfigPath()
        return self


class _UiAssistantConfigPath(ConfigPath):
    automatic_tts_readback: ConfigPath

    def __new__(cls) -> _UiAssistantConfigPath:
        self = super().__new__(cls, "ui.assistant")
        self.automatic_tts_readback = ConfigPath("ui.assistant.automatic_tts_readback")
        return self


class _UiDesktopOverlayConfigPath(ConfigPath):
    auto_close_delay_ms: ConfigPath
    close_behavior: ConfigPath
    enabled: ConfigPath
    persist_positions: ConfigPath
    text_hotkey: ConfigPath
    visible_on_all_workspaces: ConfigPath
    voice_overlay_enabled: ConfigPath

    def __new__(cls) -> _UiDesktopOverlayConfigPath:
        self = super().__new__(cls, "ui.desktop_overlay")
        self.auto_close_delay_ms = ConfigPath("ui.desktop_overlay.auto_close_delay_ms")
        self.close_behavior = ConfigPath("ui.desktop_overlay.close_behavior")
        self.enabled = ConfigPath("ui.desktop_overlay.enabled")
        self.persist_positions = ConfigPath("ui.desktop_overlay.persist_positions")
        self.text_hotkey = ConfigPath("ui.desktop_overlay.text_hotkey")
        self.visible_on_all_workspaces = ConfigPath("ui.desktop_overlay.visible_on_all_workspaces")
        self.voice_overlay_enabled = ConfigPath("ui.desktop_overlay.voice_overlay_enabled")
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
    primary_language: ConfigPath
    voice_language: ConfigPath

    def __new__(cls) -> _SystemConfigPath:
        self = super().__new__(cls, "system")
        self.models_dir = ConfigPath("system.models_dir")
        self.primary_language = ConfigPath("system.primary_language")
        self.voice_language = ConfigPath("system.voice_language")
        return self


class _UiConfigPath(ConfigPath):
    activate: ConfigPath
    assistant: _UiAssistantConfigPath
    dark_mode: ConfigPath
    debug: ConfigPath
    desktop_overlay: _UiDesktopOverlayConfigPath

    def __new__(cls) -> _UiConfigPath:
        self = super().__new__(cls, "ui")
        self.activate = ConfigPath("ui.activate")
        self.assistant = _UiAssistantConfigPath()
        self.dark_mode = ConfigPath("ui.dark_mode")
        self.debug = ConfigPath("ui.debug")
        self.desktop_overlay = _UiDesktopOverlayConfigPath()
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
