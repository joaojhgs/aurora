"""RAG Service for Aurora's database service.

This module provides RAG (Retrieval-Augmented Generation) functionality
using SQLiteVec for vector storage and semantic search of memories and tools.
"""

import json
import os
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from langchain_community.vectorstores import SQLiteVec
from langgraph.store.base import BaseStore, Item

from app.helpers.aurora_logger import log_debug, log_error, log_info, log_warning
from app.shared.config.interface import ConfigAPI
from app.shared.config.keys import ConfigKeys
from app.shared.config.models import Db, Embeddings

config_api = ConfigAPI()


async def _async_wait_for_config_service(max_retries: int = 45, retry_delay: float = 1.0) -> bool:
    """Async version: Wait for the config service to be ready.

    Args:
        max_retries: Maximum number of retries before giving up
        retry_delay: Delay in seconds between retries

    Returns:
        bool: True if config service is ready, False otherwise
    """
    import asyncio

    for attempt in range(max_retries):
        # First check if ConfigService contracts are registered
        if not config_api._is_config_service_ready():
            if attempt < max_retries - 1:
                log_debug(
                    f"ConfigService contracts not registered, retrying in {retry_delay}s "
                    f"(attempt {attempt + 1}/{max_retries})"
                )
                await asyncio.sleep(retry_delay)
            continue

        # Probe with raw access (no model) — if ConfigService is not responding,
        # aget returns the default (None), distinguishing from a real response.
        result = await config_api.aget(ConfigKeys.services.db.embeddings.use_local, default=None)
        if result is not None:
            log_debug(f"Config service ready after {attempt + 1} attempt(s)")
            return True

        if attempt < max_retries - 1:
            log_debug(
                f"Config service not responding, retrying in {retry_delay}s "
                f"(attempt {attempt + 1}/{max_retries})"
            )
            await asyncio.sleep(retry_delay)

    log_error(
        f"Config service not ready after {max_retries} attempts. "
        "Ensure ConfigService is running and accessible via the message bus."
    )
    return False


async def async_get_embeddings():
    """Async version: Get embeddings based on use_local configuration setting.

    Waits for config service to be ready in distributed mode.
    Should be called during service initialization (on_start).
    """
    # Wait for config service to be available
    if not await _async_wait_for_config_service():
        raise RuntimeError(
            "Cannot initialize embeddings: Config service is not available. "
            "Ensure ConfigService is running before starting DBService."
        )

    # Get config value using async API
    db_cfg = await config_api.aget(ConfigKeys.services.db, Db)
    if isinstance(db_cfg, dict):
        db_cfg = Db.model_validate(db_cfg)
    embeddings_cfg = db_cfg.embeddings or Embeddings()
    use_local = embeddings_cfg.use_local if embeddings_cfg.use_local is not None else True

    if use_local:
        try:
            from langchain_huggingface import HuggingFaceEmbeddings
        except ImportError:
            log_error(
                "langchain-huggingface is required for local embeddings but not installed. "
                "Install with: pip install -e .[service-db-local-embeddings] "
                "Or build Docker image with: DB_EMBEDDINGS_MODE=local docker-compose build db-service"
            )
            raise ImportError(
                "langchain-huggingface is required for local embeddings. "
                "Install with: pip install -e .[service-db-local-embeddings]"
            ) from None

        # Use local HuggingFace embeddings
        embeddings = HuggingFaceEmbeddings(model_name="all-MiniLM-L6-v2")
        model_info = {"type": "huggingface", "model_name": "all-MiniLM-L6-v2", "version": "local"}
        log_info("Using local HuggingFace embeddings (all-MiniLM-L6-v2)")
    else:
        from langchain.embeddings import init_embeddings

        # Use OpenAI embeddings
        embeddings = init_embeddings("openai:text-embedding-3-small")
        model_info = {"type": "openai", "model_name": "text-embedding-3-small", "version": "openai"}
        log_info("Using OpenAI embeddings (text-embedding-3-small)")

    return embeddings, model_info


def get_embedding_model_signature(model_info: dict[str, str]) -> str:
    """Generate a unique signature for the embedding model configuration"""
    return f"{model_info['type']}:{model_info['model_name']}:{model_info['version']}"


def check_and_update_embedding_model(
    store: "SQLiteVecStore", current_model_info: dict[str, str], embeddings=None
) -> bool:
    """Check if the embedding model has changed and re-embed all data if necessary.

    When the stored model signature differs from *current_model_info*, the
    function drops the existing vector table and re-embeds every row using
    *embeddings*.

    Args:
        store: The SQLiteVec store instance.
        current_model_info: Current model information dict.
        embeddings: Pre-created embeddings instance used for re-embedding.
            Required when a model change is detected.  Callers should obtain
            an instance via ``async_get_embeddings()`` and pass it here.

    Returns:
        True if re-embedding was performed, False otherwise.
    """
    current_signature = get_embedding_model_signature(current_model_info)

    # Create a temporary connection to check model signature
    temp_connection = SQLiteVec.create_connection(db_file=store.db_file)

    # Create metadata table if it doesn't exist
    temp_connection.execute(
        """
        CREATE TABLE IF NOT EXISTS embedding_metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """
    )
    temp_connection.commit()

    # Check stored model signature
    cursor = temp_connection.execute(
        "SELECT value FROM embedding_metadata WHERE key = 'model_signature'"
    )
    result = cursor.fetchone()
    stored_signature = result[0] if result else None

    if stored_signature != current_signature:
        log_info("Embedding model change detected!")
        log_info(f"  Previous: {stored_signature or 'None'}")
        log_info(f"  Current:  {current_signature}")
        log_info(f"  Re-embedding all data in {store.table} table...")

        # Check if the table exists
        cursor = temp_connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?", (store.table,)
        )
        table_exists = cursor.fetchone() is not None

        if not table_exists:
            log_debug(f"  Table {store.table} doesn't exist yet, skipping re-embedding")
            temp_connection.close()

            # Update model signature for empty database
            update_connection = SQLiteVec.create_connection(db_file=store.db_file)
            update_connection.execute(
                """
                CREATE TABLE IF NOT EXISTS embedding_metadata (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """
            )
            update_connection.execute(
                "INSERT OR REPLACE INTO embedding_metadata (key, value) VALUES (?, ?)",
                ("model_signature", current_signature),
            )
            update_connection.commit()
            update_connection.close()
            return True

        # Read existing data
        cursor = temp_connection.execute(
            f"""
            SELECT rowid, text, metadata
            FROM {store.table}
            ORDER BY rowid
        """
        )
        existing_data = cursor.fetchall()

        # Close the temporary connection
        temp_connection.close()

        if existing_data:
            log_info(f"  Found {len(existing_data)} items to re-embed")

            # Extract texts and metadatas for re-embedding
            texts = []
            metadatas = []
            for row in existing_data:
                texts.append(row[1])  # text
                metadatas.append(json.loads(row[2]) if row[2] else {})  # metadata

            # Embeddings are required for re-embedding
            if embeddings is None:
                raise ValueError(
                    "embeddings must be provided when re-embedding is required. "
                    "Call async_get_embeddings() first and pass the result."
                )

            # Delete the old database file and recreate it
            db_path = store.db_file
            table_name = store.table

            if os.path.exists(db_path):
                log_info(f"  Recreating database {db_path} for new embedding dimensions...")
                os.remove(db_path)

            # Re-embed all texts with the new model
            log_info(f"  Re-embedding {len(texts)} items with new model...")
            SQLiteVec.from_texts(
                texts=texts,
                metadatas=metadatas,
                embedding=embeddings,
                table=table_name,
                db_file=db_path,
            )

            log_info(f"  Successfully re-embedded {len(existing_data)} items with new dimensions")

        else:
            log_debug(f"  No existing data found in {store.table}")

            # Still need to recreate database for dimension consistency
            db_path = store.db_file
            if os.path.exists(db_path):
                os.remove(db_path)

        # Update the stored model signature in the new database
        # Create a fresh connection for metadata operations
        metadata_connection = SQLiteVec.create_connection(db_file=store.db_file)

        # Recreate metadata table in new database
        metadata_connection.execute(
            """
            CREATE TABLE IF NOT EXISTS embedding_metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """
        )

        metadata_connection.execute(
            "INSERT OR REPLACE INTO embedding_metadata (key, value) VALUES (?, ?)",
            ("model_signature", current_signature),
        )
        metadata_connection.commit()
        metadata_connection.close()

        return True
    else:
        temp_connection.close()
        return False


class SQLiteVecStore(BaseStore):
    """
    A BaseStore implementation that uses SQLiteVec as the underlying storage.
    This adapter bridges SQLiteVec (vector store) with LangGraph's BaseStore interface.
    """

    def __init__(self, db_file: str, table: str, embeddings):
        """
        Initialize the SQLiteVec store.

        Args:
            db_file: Path to the SQLite database file
            table: Table name for the vector store
            embeddings: Embeddings instance to use
        """
        self.db_file = db_file
        self.table = table
        self.embeddings = embeddings

        # Ensure the data directory exists
        Path(db_file).parent.mkdir(parents=True, exist_ok=True)

        # Don't store the connection - create on-demand to handle threading
        # Just initialize the database schema by creating a temporary connection
        temp_connection = SQLiteVec.create_connection(db_file=db_file)
        SQLiteVec(table=table, embedding=embeddings, connection=temp_connection)
        # Close the temporary connection
        temp_connection.close()

        log_info(f"Initialized SQLiteVec store: {db_file} (table: {table})")

    def _get_vector_store(self):
        """Create a new SQLiteVec instance for the current thread."""
        # Always create a fresh connection to avoid threading issues
        connection = SQLiteVec.create_connection(db_file=self.db_file)
        return SQLiteVec(table=self.table, embedding=self.embeddings, connection=connection)

    # Implement the missing abstract methods
    async def aput(
        self,
        namespace: tuple[str, ...],
        key: str,
        value: dict[str, Any],
        index: list[str] | None = None,
    ) -> None:
        """Async version of put - just calls the sync version."""
        return self.put(namespace, key, value, index)

    async def aget(
        self,
        namespace: tuple[str, ...],
        key: str,
    ) -> Item | None:
        """Async version of get - just calls the sync version."""
        return self.get(namespace, key)

    async def adelete(
        self,
        namespace: tuple[str, ...],
        key: str,
    ) -> None:
        """Async version of delete - just calls the sync version."""
        return self.delete(namespace, key)

    async def alist(
        self,
        namespace: tuple[str, ...],
        *,
        limit: int = 10,
        offset: int = 0,
    ) -> list[Item]:
        """Async version of list - just calls the sync version."""
        return self.list_items_in_namespace(namespace, limit=limit, offset=offset)

    async def asearch(
        self,
        namespace: tuple[str, ...],
        *,
        query: str,
        limit: int = 10,
        offset: int = 0,
    ) -> list[Item]:
        """Async version of search - just calls the sync version."""
        return self.search(namespace, query=query, limit=limit, offset=offset)

    def batch(self, ops) -> list[Any]:
        """Batch operations - not implemented for simplicity."""
        raise NotImplementedError("Batch operations not implemented")

    async def abatch(self, ops) -> list[Any]:
        """Async batch operations - not implemented for simplicity."""
        raise NotImplementedError("Async batch operations not implemented")

    def put(
        self,
        namespace: tuple[str, ...],
        key: str,
        value: dict[str, Any],
        index: list[str] | None = None,
    ) -> None:
        """
        Store a key-value pair in the vector store.

        Args:
            namespace: Namespace tuple (e.g., ("main", "memories") or ("tools",))
            key: Unique key for the item
            value: Dictionary value to store
            index: Optional list of fields to index (not used in vector store)
        """
        # Create a text representation for vector search
        # For memories, use the 'text' field; for tools, use name and description
        if "text" in value:
            text_content = value["text"]
        elif "name" in value and "description" in value:
            text_content = f"{value['name']}: {value['description']}"
        else:
            # Fallback: use JSON representation
            text_content = json.dumps(value, ensure_ascii=False)

        # Create metadata that includes the namespace, key, and original value
        metadata = {
            "namespace": "|".join(namespace),
            "key": key,
            "value": json.dumps(value, ensure_ascii=False),
        }

        # Store in vector database
        vector_store = self._get_vector_store()
        vector_store.add_texts(
            texts=[text_content], metadatas=[metadata], ids=[f"{metadata['namespace']}_{key}"]
        )

    def get(
        self,
        namespace: tuple[str, ...],
        key: str,
    ) -> Item | None:
        """
        Get an item by namespace and key.

        Args:
            namespace: Namespace tuple
            key: Key to retrieve

        Returns:
            Item if found, None otherwise
        """
        namespace_str = "|".join(namespace)

        # SQLiteVec doesn't have a direct get by ID method,
        # so we'll search with a high similarity threshold
        try:
            # Use the key as search query and filter by exact metadata match
            vector_store = self._get_vector_store()
            results = vector_store.similarity_search_with_score(
                query=key, k=50
            )  # Get more results to find exact match

            for item in results:
                # Handle both (doc, score) tuples and doc objects
                doc = item[0] if isinstance(item, tuple) else item
                if not hasattr(doc, "metadata"):
                    continue
                if (
                    doc.metadata.get("namespace") == namespace_str
                    and doc.metadata.get("key") == key
                ):
                    # Parse the stored value
                    value = json.loads(doc.metadata["value"])
                    return Item(
                        value=value,
                        key=key,
                        namespace=namespace,
                        created_at=datetime.now(),  # Use current time as fallback
                        updated_at=datetime.now(),  # Use current time as fallback
                    )

            return None

        except Exception as e:
            log_error(f"Error getting item {namespace}/{key}: {e}")
            return None

    def delete(
        self,
        namespace: tuple[str, ...],
        key: str,
    ) -> None:
        """
        Delete an item by namespace and key.

        Args:
            namespace: Namespace tuple
            key: Key to delete
        """
        namespace_str = "|".join(namespace)
        doc_id = f"{namespace_str}_{key}"

        try:
            # Use direct SQLite connection to delete from the vector table
            vector_store = self._get_vector_store()
            connection = vector_store._connection

            # SQLiteVec stores documents in a table with the name specified during initialization
            # We need to delete from both the embedding table and any metadata tables
            cursor = connection.cursor()

            # Delete from the main vector table using the document ID
            # The exact table structure may vary, but typically it's stored with a
            # rowid or id column
            cursor.execute(f"DELETE FROM {self.table} WHERE id = ?", (doc_id,))
            connection.commit()

            log_info(f"Deleted item {namespace}/{key} from database")

        except Exception as e:
            log_error(f"Error deleting item {namespace}/{key}: {e}")
            # Try alternative approach - delete by metadata matching
            try:
                # If direct delete fails, we can try to find and delete by metadata
                cursor.execute(
                    f"""
                    DELETE FROM {self.table}
                    WHERE json_extract(metadata, '$.namespace') = ?
                    AND json_extract(metadata, '$.key') = ?
                """,
                    (namespace_str, key),
                )
                connection.commit()
                log_info(f"Deleted item {namespace}/{key} using metadata matching")
            except Exception as e2:
                log_error(f"Alternative delete method also failed for {namespace}/{key}: {e2}")
                pass

    def list_items_in_namespace(
        self,
        namespace: tuple[str, ...],
        *,
        limit: int = 10,
        offset: int = 0,
    ) -> list[Item]:
        """
        List items in a namespace.

        Args:
            namespace: Namespace tuple
            limit: Maximum number of items to return
            offset: Number of items to skip

        Returns:
            List of items
        """
        namespace_str = "|".join(namespace)

        try:
            # Search for all items in this namespace
            # Use a broad search query to get items
            vector_store = self._get_vector_store()
            results = vector_store.similarity_search_with_score(
                query="",  # Empty query to get all
                k=limit + offset + 50,  # Get extra to handle filtering
            )

            # Filter by namespace and apply offset/limit
            items = []
            count = 0
            for result in results:
                # Handle both tuple (doc, score) and doc formats
                if isinstance(result, tuple):
                    doc, score = result
                else:
                    doc = result

                # Check if doc has metadata attribute
                if not hasattr(doc, "metadata"):
                    log_debug(f"Skipping result without metadata: {result}")
                    continue

                if (
                    doc.metadata.get("namespace") == namespace_str
                    and count >= offset
                    and len(items) < limit
                ):
                    try:
                        value = json.loads(doc.metadata["value"])
                        items.append(
                            Item(
                                value=value,
                                key=doc.metadata["key"],
                                namespace=namespace,
                                created_at=datetime.now(),
                                updated_at=datetime.now(),
                            )
                        )
                    except (json.JSONDecodeError, KeyError) as e:
                        log_debug(f"Skipping malformed item: {e}")
                        continue
                count += 1

            return items

        except Exception as e:
            log_error(f"Error listing items in {namespace}: {e}")
            return []

    def search(
        self,
        namespace: tuple[str, ...],
        *,
        query: str,
        limit: int = 10,
        offset: int = 0,
    ) -> list[Item]:
        """
        Search for items in a namespace using vector similarity.

        Args:
            namespace: Namespace tuple
            query: Search query
            limit: Maximum number of items to return
            offset: Number of items to skip

        Returns:
            List of items with similarity scores
        """
        namespace_str = "|".join(namespace)

        try:
            # Perform vector similarity search
            vector_store = self._get_vector_store()
            results = vector_store.similarity_search_with_score(
                query=query, k=limit + offset + 20
            )  # Get extra to handle filtering

            # Filter by namespace and apply offset/limit
            items = []
            for count, (doc, score) in enumerate(results):
                if (
                    doc.metadata.get("namespace") == namespace_str
                    and count >= offset
                    and len(items) < limit
                ):
                    value = json.loads(doc.metadata["value"])
                    item = Item(
                        value=value,
                        key=doc.metadata["key"],
                        namespace=namespace,
                        created_at=datetime.now(),
                        updated_at=datetime.now(),
                    )
                    # Store score in the value if needed
                    if isinstance(item.value, dict):
                        item.value["_search_score"] = float(score)
                    items.append(item)

            return items

        except Exception as e:
            log_error(f"Error searching in {namespace} with query '{query}': {e}")
            return []


# Combined store that routes operations to the appropriate store based on namespace
class CombinedSQLiteVecStore(BaseStore):
    """
    A combined store that routes operations to separate stores based on namespace.
    This allows using separate databases for memories and tools while maintaining
    a single store interface for backward compatibility.
    """

    def __init__(self, memories_store: SQLiteVecStore, tools_store: SQLiteVecStore):
        self.memories_store = memories_store
        self.tools_store = tools_store

    def _get_store(self, namespace: tuple[str, ...]) -> SQLiteVecStore:
        """Route to the appropriate store based on namespace."""
        if len(namespace) >= 2 and namespace[1] == "memories":
            return self.memories_store
        elif len(namespace) >= 1 and namespace[0] == "tools":
            return self.tools_store
        else:
            # Default to memories store for backward compatibility
            return self.memories_store

    def put(
        self,
        namespace: tuple[str, ...],
        key: str,
        value: dict[str, Any],
        index: list[str] | None = None,
    ) -> None:
        return self._get_store(namespace).put(namespace, key, value, index)

    def get(self, namespace: tuple[str, ...], key: str) -> Item | None:
        return self._get_store(namespace).get(namespace, key)

    def delete(self, namespace: tuple[str, ...], key: str) -> None:
        return self._get_store(namespace).delete(namespace, key)

    def retrieve_items(
        self, namespace: tuple[str, ...], *, limit: int = 10, offset: int = 0
    ) -> list[Item]:
        return self._get_store(namespace).list_items_in_namespace(
            namespace, limit=limit, offset=offset
        )

    def search(
        self, namespace: tuple[str, ...], *, query: str, limit: int = 10, offset: int = 0
    ) -> list[Item]:
        return self._get_store(namespace).search(namespace, query=query, limit=limit, offset=offset)

    # Implement the missing abstract methods by delegating to the appropriate store
    async def aput(
        self,
        namespace: tuple[str, ...],
        key: str,
        value: dict[str, Any],
        index: list[str] | None = None,
    ) -> None:
        return await self._get_store(namespace).aput(namespace, key, value, index)

    async def aget(self, namespace: tuple[str, ...], key: str) -> Item | None:
        return await self._get_store(namespace).aget(namespace, key)

    async def adelete(self, namespace: tuple[str, ...], key: str) -> None:
        return await self._get_store(namespace).adelete(namespace, key)

    async def alist(
        self, namespace: tuple[str, ...], *, limit: int = 10, offset: int = 0
    ) -> list[Item]:
        return await self._get_store(namespace).alist(namespace, limit=limit, offset=offset)

    async def asearch(
        self, namespace: tuple[str, ...], *, query: str, limit: int = 10, offset: int = 0
    ) -> list[Item]:
        return await self._get_store(namespace).asearch(
            namespace, query=query, limit=limit, offset=offset
        )

    def batch(self, ops) -> list[Any]:
        raise NotImplementedError("Batch operations not implemented")

    async def abatch(self, ops) -> list[Any]:
        raise NotImplementedError("Async batch operations not implemented")


class RAGService:
    """RAG Service for managing memories and tools vector stores."""

    def __init__(self):
        """Initialize the RAG service."""
        self._memories_store = None
        self._tools_store = None
        self._combined_store = None
        self._initialized = False
        self._initializing = False
        import threading

        self._lock = threading.Lock()

    @property
    def is_initialized(self) -> bool:
        """Check if RAG stores are initialized."""
        return self._initialized

    async def async_initialize(self):
        """Async initialization of RAG stores. Call this during service on_start().

        This properly waits for the config service using async/await,
        avoiding event loop blocking issues.
        """
        if self._initialized:
            return

        with self._lock:
            if self._initialized:
                return

            if self._initializing:
                # Another coroutine is already initializing
                return

            self._initializing = True

        try:
            log_info("Initializing RAG stores for memories and tools (async)...")

            # Create embeddings instance using async version. RAG is optional for DB startup:
            # missing local packages or API credentials should disable vector search, not
            # take down core persistence/auth/scheduler storage.
            try:
                embeddings, model_info = await async_get_embeddings()
            except Exception as exc:
                log_warning(f"RAG stores disabled: embeddings unavailable ({exc})")
                return

            from app.shared.path_utils import get_data_dir

            data_dir = get_data_dir()
            self._memories_store = SQLiteVecStore(
                db_file=str(data_dir / "memories.db"), table="memories", embeddings=embeddings
            )
            self._tools_store = SQLiteVecStore(
                db_file=str(data_dir / "tools.db"), table="tools", embeddings=embeddings
            )

            # Check if embedding model changed and re-embed if necessary
            log_info("Checking for embedding model changes...")
            memories_reembedded = check_and_update_embedding_model(
                self._memories_store, model_info, embeddings
            )
            tools_reembedded = check_and_update_embedding_model(
                self._tools_store, model_info, embeddings
            )

            if memories_reembedded or tools_reembedded:
                log_info("Embedding model update completed!")
                if memories_reembedded:
                    log_debug("Memories re-embedded successfully")
                if tools_reembedded:
                    log_debug("Tools re-embedded successfully")
            else:
                log_info("Embedding model unchanged - no re-embedding needed")

            # Create combined store
            self._combined_store = CombinedSQLiteVecStore(self._memories_store, self._tools_store)

            self._initialized = True
            log_info("RAG stores initialized successfully")
        finally:
            self._initializing = False

    def _ensure_initialized(self):
        """Check if stores are initialized, raise if not."""
        if not self._initialized:
            raise RuntimeError(
                "RAG stores not yet initialized. Service is still starting up, please retry."
            )

    @property
    def memories_store(self):
        """Get the memories store."""
        self._ensure_initialized()
        return self._memories_store

    @property
    def tools_store(self):
        """Get the tools store."""
        self._ensure_initialized()
        return self._tools_store

    @property
    def combined_store(self):
        """Get the combined store."""
        self._ensure_initialized()
        return self._combined_store
