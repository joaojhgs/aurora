"""
Ambient transcription service for Aurora.
Handles storage, retrieval, and vector similarity search for ambient transcriptions.
"""

import asyncio
from typing import Any, Callable, Optional

from app.config.config_manager import ConfigManager
from app.helpers.aurora_logger import log_debug, log_error, log_info

from .database_manager import DatabaseManager
from .models import AmbientTranscription


class AmbientTranscriptionService:
    """Service for managing ambient transcriptions with database storage and vector search"""

    def __init__(self, db_manager: DatabaseManager, config_manager: ConfigManager = None):
        self.db_manager = db_manager
        self.config_manager = config_manager or ConfigManager()
        self.embeddings_model = None
        self._embeddings_lock = asyncio.Lock()

    async def initialize(self):
        """Initialize the service and embeddings model if needed"""
        try:
            # Check if vector similarity is enabled
            if self._is_vector_search_enabled():
                await self._initialize_embeddings_model()
            log_info("Ambient transcription service initialized")
        except Exception as e:
            log_error(f"Error initializing ambient transcription service: {e}")

    def _is_vector_search_enabled(self) -> bool:
        """Check if vector similarity search is enabled in configuration"""
        try:
            return self.config_manager.get("general.speech_to_text.ambient_transcription.enable_vector_search", False)
        except Exception:
            return False

    async def _initialize_embeddings_model(self):
        """Initialize the embeddings model for vector similarity search"""
        try:
            async with self._embeddings_lock:
                if self.embeddings_model is None:
                    # Import embeddings model based on configuration
                    embeddings_provider = self.config_manager.get("general.embeddings.provider", "sentence-transformers")

                    if embeddings_provider == "sentence-transformers":
                        from sentence_transformers import SentenceTransformer

                        model_name = self.config_manager.get("general.embeddings.sentence_transformers.model", "all-MiniLM-L6-v2")
                        self.embeddings_model = SentenceTransformer(model_name)
                        log_info(f"Initialized embeddings model: {model_name}")

                    elif embeddings_provider == "openai":
                        # For OpenAI embeddings, we'll need to implement API calls
                        log_info("OpenAI embeddings provider configured")
                        # TODO: Implement OpenAI embeddings integration

                    else:
                        log_error(f"Unsupported embeddings provider: {embeddings_provider}")

        except Exception as e:
            log_error(f"Error initializing embeddings model: {e}")

    async def generate_embedding(self, text: str) -> Optional[list[float]]:
        """Generate embedding vector for the given text"""
        try:
            if not self._is_vector_search_enabled() or not self.embeddings_model:
                return None

            # Use sentence transformers
            if hasattr(self.embeddings_model, "encode"):
                embedding = self.embeddings_model.encode([text])[0]
                return embedding.tolist()

            return None
        except Exception as e:
            log_error(f"Error generating embedding: {e}")
            return None

    async def store_transcription(
        self,
        text: str,
        timestamp: float,
        chunk_id: str,
        duration: float = 0.0,
        confidence: Optional[float] = None,
        session_id: Optional[str] = None,
        metadata: Optional[dict[str, Any]] = None,
        generate_embedding: bool = True,
    ) -> bool:
        """Store an ambient transcription with optional embedding generation"""
        try:
            # Generate embedding if enabled and requested
            embedding = None
            if generate_embedding and self._is_vector_search_enabled():
                embedding = await self.generate_embedding(text)

            # Create transcription object
            transcription = AmbientTranscription.create(
                text=text,
                chunk_id=chunk_id,
                duration=duration,
                confidence=confidence,
                embedding=embedding,
                metadata=metadata,
                session_id=session_id,
                source_info={
                    "timestamp": timestamp,
                    "embedding_enabled": generate_embedding,
                    "vector_search_enabled": self._is_vector_search_enabled(),
                },
            )

            # Store in database
            success = await self.db_manager.store_ambient_transcription(transcription)

            if success:
                log_debug(f"Stored ambient transcription: {chunk_id}")
            else:
                log_error(f"Failed to store ambient transcription: {chunk_id}")

            return success

        except Exception as e:
            log_error(f"Error storing ambient transcription: {e}")
            return False

    async def search_by_text(self, query: str, limit: int = 20) -> list[AmbientTranscription]:
        """Search ambient transcriptions by text content"""
        try:
            return await self.db_manager.search_ambient_transcriptions_by_text(query, limit)
        except Exception as e:
            log_error(f"Error searching ambient transcriptions by text: {e}")
            return []

    async def search_by_similarity(self, query: str, limit: int = 20, similarity_threshold: float = 0.7) -> list[AmbientTranscription]:
        """Search ambient transcriptions by semantic similarity"""
        try:
            if not self._is_vector_search_enabled():
                log_debug("Vector search not enabled, falling back to text search")
                return await self.search_by_text(query, limit)

            # Generate embedding for query
            query_embedding = await self.generate_embedding(query)
            if not query_embedding:
                log_error("Failed to generate embedding for query")
                return await self.search_by_text(query, limit)

            # Search by similarity
            return await self.db_manager.search_ambient_transcriptions_by_similarity(query_embedding, limit, similarity_threshold)

        except Exception as e:
            log_error(f"Error searching ambient transcriptions by similarity: {e}")
            return []

    async def get_transcriptions_for_date(self, target_date=None) -> list[AmbientTranscription]:
        """Get all ambient transcriptions for a specific date"""
        try:
            return await self.db_manager.get_ambient_transcriptions_for_date(target_date)
        except Exception as e:
            log_error(f"Error getting ambient transcriptions for date: {e}")
            return []

    async def get_recent_transcriptions(self, limit: int = 50) -> list[AmbientTranscription]:
        """Get the most recent ambient transcriptions"""
        try:
            return await self.db_manager.get_recent_ambient_transcriptions(limit)
        except Exception as e:
            log_error(f"Error getting recent ambient transcriptions: {e}")
            return []

    def create_storage_callback(self, session_id: Optional[str] = None) -> Callable:
        """Create a callback function for storing ambient transcriptions"""

        def callback(text: str, timestamp: float, chunk_id: str, duration: float = 0.0):
            """Callback to store ambient transcription in database"""
            try:
                # Create a task to store the transcription asynchronously
                loop = asyncio.get_event_loop()
                if loop.is_running():
                    # If we're already in an async context, schedule the coroutine
                    asyncio.create_task(
                        self.store_transcription(
                            text=text,
                            timestamp=timestamp,
                            chunk_id=chunk_id,
                            duration=duration,
                            session_id=session_id,
                        )
                    )
                else:
                    # If not in async context, run the coroutine
                    loop.run_until_complete(
                        self.store_transcription(
                            text=text,
                            timestamp=timestamp,
                            chunk_id=chunk_id,
                            duration=duration,
                            session_id=session_id,
                        )
                    )
            except Exception as e:
                log_error(f"Error in ambient transcription callback: {e}")

        return callback

    async def cleanup_old_transcriptions(self, days_to_keep: int = 30) -> int:
        """Remove ambient transcriptions older than specified days"""
        try:
            return await self.db_manager.cleanup_old_ambient_transcriptions(days_to_keep)
        except Exception as e:
            log_error(f"Error cleaning up old ambient transcriptions: {e}")
            return 0
