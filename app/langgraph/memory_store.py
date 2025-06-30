import json
import os
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from langchain_community.vectorstores import SQLiteVec
from langgraph.store.base import BaseStore, Item

from app.config.config_manager import config_manager
from app.helpers.aurora_logger import log_debug, log_error, log_info


def get_embeddings():
    """Get embeddings based on USE_LOCAL_EMBEDDINGS environment variable"""
    use_local = config_manager.get("embeddings.use_local", False)

    if use_local:
        from langchain_huggingface import HuggingFaceEmbeddings

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
    store: "SQLiteVecStore", current_model_info: dict[str, str]
) -> bool:
    """
    Check if the embedding model has changed and re-embed all data if necessary.

    Args:
        store: The SQLiteVec store instance
        current_model_info: Current model information

    Returns:
        bool: True if re-embedding was performed, False otherwise
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
        log_info(f"Embedding model change detected!")
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

            # Get current embeddings to determine new dimensions
            embeddings, _ = get_embeddings()

            # Delete the old database file and recreate it
            db_path = store.db_file
            table_name = store.table

            if os.path.exists(db_path):
                log_info(f"  Recreating database {db_path} for new embedding dimensions...")
                os.remove(db_path)

            # Create a new vector store with the current embeddings using real data
            log_info(f"  Re-embedding {len(texts)} items with new model...")
            new_vector_store = SQLiteVec.from_texts(
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
        temp_store = SQLiteVec(table=table, embedding=embeddings, connection=temp_connection)
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
        index: Optional[list[str]] = None,
    ) -> None:
        """Async version of put - just calls the sync version."""
        return self.put(namespace, key, value, index)

    async def aget(
        self,
        namespace: tuple[str, ...],
        key: str,
    ) -> Optional[Item]:
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
        return self.list(namespace, limit=limit, offset=offset)

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
        index: Optional[list[str]] = None,
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
    ) -> Optional[Item]:
        """
        Get an item by namespace and key.

        Args:
            namespace: Namespace tuple
            key: Key to retrieve

        Returns:
            Item if found, None otherwise
        """
        namespace_str = "|".join(namespace)
        doc_id = f"{namespace_str}_{key}"

        # SQLiteVec doesn't have a direct get by ID method,
        # so we'll search with a high similarity threshold
        try:
            # Use the key as search query and filter by exact metadata match
            vector_store = self._get_vector_store()
            results = vector_store.similarity_search_with_score(
                query=key, k=50  # Get more results to find exact match
            )

            for doc, score in results:
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

            log_info(f"Deleted tool {namespace}/{key} from database")

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
                log_info(f"Deleted tool {namespace}/{key} using metadata matching")
            except Exception as e2:
                log_error(f"Alternative delete method also failed for {namespace}/{key}: {e2}")
                pass

    def list(
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
            for doc, score in results:
                if doc.metadata.get("namespace") == namespace_str:
                    if count >= offset:
                        if len(items) < limit:
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
                query=query, k=limit + offset + 20  # Get extra to handle filtering
            )

            # Filter by namespace and apply offset/limit
            items = []
            count = 0
            for doc, score in results:
                if doc.metadata.get("namespace") == namespace_str:
                    if count >= offset:
                        if len(items) < limit:
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
                    count += 1

            return items

        except Exception as e:
            log_error(f"Error searching in {namespace} with query '{query}': {e}")
            return []


# Create embeddings instance
embeddings, model_info = get_embeddings()

# Create separate SQLite vector stores for memories and tools in the data folder
memories_store = SQLiteVecStore(
    db_file="./data/memories.db", table="memories", embeddings=embeddings
)

tools_store = SQLiteVecStore(db_file="./data/tools.db", table="tools", embeddings=embeddings)

# Check if embedding model changed and re-embed if necessary
log_info("Checking for embedding model changes...")
memories_reembedded = check_and_update_embedding_model(memories_store, model_info)
tools_reembedded = check_and_update_embedding_model(tools_store, model_info)

if memories_reembedded or tools_reembedded:
    log_info("Embedding model update completed!")
    if memories_reembedded:
        log_info("  ✅ Memories re-embedded successfully")
    if tools_reembedded:
        log_info("  ✅ Tools re-embedded successfully")
else:
    log_info("Embedding model unchanged - no re-embedding needed")


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
        index: Optional[list[str]] = None,
    ) -> None:
        return self._get_store(namespace).put(namespace, key, value, index)

    def get(self, namespace: tuple[str, ...], key: str) -> Optional[Item]:
        return self._get_store(namespace).get(namespace, key)

    def delete(self, namespace: tuple[str, ...], key: str) -> None:
        return self._get_store(namespace).delete(namespace, key)

    def list(self, namespace: tuple[str, ...], *, limit: int = 10, offset: int = 0) -> list[Item]:
        return self._get_store(namespace).list(namespace, limit=limit, offset=offset)

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
        index: Optional[list[str]] = None,
    ) -> None:
        return await self._get_store(namespace).aput(namespace, key, value, index)

    async def aget(self, namespace: tuple[str, ...], key: str) -> Optional[Item]:
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


# Create the combined store for backward compatibility
store = CombinedSQLiteVecStore(memories_store, tools_store)

log_info("SQLiteVec-based memory and tools storage initialized successfully")
