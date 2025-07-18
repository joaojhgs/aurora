"""
Ambient transcription service for Aurora.
Handles storage, retrieval, and vector similarity search for ambient transcriptions.
"""

import asyncio
from typing import Any, Callable, Optional

from app.config.config_manager import ConfigManager
from app.helpers.aurora_logger import log_debug, log_error, log_info
from app.langgraph.memory_store import get_combined_store

from .database_manager import DatabaseManager
from .models import AmbientTranscription


class AmbientTranscriptionService:
    """Service for managing ambient transcriptions with database storage and vector search"""

    def __init__(self, db_manager: DatabaseManager, config_manager: ConfigManager = None):
        self.db_manager = db_manager
        self.config_manager = config_manager or ConfigManager()
        self.vector_store = None

    async def initialize(self):
        """Initialize the service and vector store if needed"""
        try:
            # Check if vector similarity is enabled
            if self._is_vector_search_enabled():
                await self._initialize_vector_store()
            log_info("Ambient transcription service initialized")
        except Exception as e:
            log_error(f"Error initializing ambient transcription service: {e}")

    def _is_vector_search_enabled(self) -> bool:
        """Check if vector similarity search is enabled in configuration"""
        try:
            return self.config_manager.get("general.speech_to_text.ambient_transcription.enable_vector_search", False)
        except Exception:
            return False

    async def _initialize_vector_store(self):
        """Initialize the vector store using existing SQLiteVec infrastructure"""
        try:
            # Use the existing memory store infrastructure for vector search
            self.vector_store = get_combined_store()
            log_info("Vector store initialized for ambient transcriptions")
        except Exception as e:
            log_error(f"Error initializing vector store: {e}")
            self.vector_store = None

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
        """Store an ambient transcription with optional vector storage"""
        try:
            # Create transcription object
            transcription = AmbientTranscription.create(
                text=text,
                chunk_id=chunk_id,
                duration=duration,
                confidence=confidence,
                embedding=None,  # Vector store handles embedding generation
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

            # If vector search is enabled and database storage succeeded, also store in vector store
            if success and generate_embedding and self._is_vector_search_enabled() and self.vector_store:
                try:
                    # Store in vector store using ambient transcription namespace
                    namespace = ("ambient", "transcriptions")

                    # Prepare value for vector storage
                    value = {
                        "text": text,
                        "chunk_id": chunk_id,
                        "timestamp": timestamp,
                        "duration": duration,
                        "confidence": confidence,
                        "session_id": session_id,
                        "metadata": metadata or {},
                    }

                    # Store in vector store for similarity search
                    self.vector_store.put(namespace, chunk_id, value)
                    log_debug(f"Stored ambient transcription in vector store: {chunk_id}")

                except Exception as e:
                    log_error(f"Error storing in vector store: {e}")
                    # Don't fail the entire operation if vector store fails

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
        """Search ambient transcriptions by semantic similarity using SQLiteVec"""
        try:
            if not self._is_vector_search_enabled() or not self.vector_store:
                log_debug("Vector search not enabled, falling back to text search")
                return await self.search_by_text(query, limit)

            # Use the existing vector store for similarity search
            namespace = ("ambient", "transcriptions")
            results = self.vector_store.search(namespace, query=query, limit=limit)

            # Convert vector store results to AmbientTranscription objects
            transcriptions = []
            for item in results:
                try:
                    # Filter by similarity score if available
                    if hasattr(item, "value") and isinstance(item.value, dict):
                        score = item.value.get("_search_score", 1.0)
                        if score < similarity_threshold:
                            continue

                    # Try to get the full transcription from database by chunk_id
                    chunk_id = item.value.get("chunk_id") if hasattr(item, "value") else item.key
                    db_results = await self.db_manager.get_ambient_transcription_by_chunk_id(chunk_id)

                    if db_results:
                        transcriptions.extend(db_results)
                    else:
                        # Fallback: create from vector store data
                        if hasattr(item, "value") and isinstance(item.value, dict):
                            transcription = AmbientTranscription.create(
                                text=item.value.get("text", ""),
                                chunk_id=chunk_id,
                                duration=item.value.get("duration", 0.0),
                                confidence=item.value.get("confidence"),
                                metadata=item.value.get("metadata"),
                                session_id=item.value.get("session_id"),
                                source_info={"from_vector_store": True},
                            )
                            transcriptions.append(transcription)

                except Exception as e:
                    log_debug(f"Error processing search result: {e}")
                    continue

            return transcriptions[:limit]

        except Exception as e:
            log_error(f"Error searching ambient transcriptions by similarity: {e}")
            # Fallback to text search
            return await self.search_by_text(query, limit)

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
