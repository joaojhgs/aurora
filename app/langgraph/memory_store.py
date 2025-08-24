import json
import threading
from datetime import datetime
from pathlib import Path
from typing import Any, Optional, Union

try:
    from langchain_chroma import Chroma
    CHROMA_AVAILABLE = True
except ImportError:
    CHROMA_AVAILABLE = False
    Chroma = None

from langgraph.store.base import BaseStore, Item

from app.config.config_manager import config_manager
from app.helpers.aurora_logger import log_debug, log_error, log_info, log_warning


def get_embeddings():
    """Get embeddings based on configuration"""
    use_local = config_manager.get("general.embeddings.use_local", False)

    if use_local:
        from langchain_huggingface import HuggingFaceEmbeddings

        # Use local HuggingFace embeddings
        embeddings = HuggingFaceEmbeddings(model_name="all-MiniLM-L6-v2")
        log_info("Using local HuggingFace embeddings (all-MiniLM-L6-v2)")
    else:
        from langchain.embeddings import init_embeddings

        # Use OpenAI embeddings
        embeddings = init_embeddings("openai:text-embedding-3-small")
        log_info("Using OpenAI embeddings (text-embedding-3-small)")

    return embeddings


class ChromaVectorStore:
    """
    Singleton Chroma vector store manager that provides access to different collections.
    Uses Chroma's native langchain interface for simplified memory management.
    """
    
    _instance = None
    _lock = threading.Lock()
    
    def __new__(cls):
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
                    cls._instance._initialized = False
        return cls._instance
    
    def __init__(self):
        if self._initialized:
            return
            
        if not CHROMA_AVAILABLE:
            raise ImportError(
                "Chroma is not available. Please install the required packages:\n"
                "pip install langchain-chroma chromadb"
            )
            
        self._embeddings = None
        self._chroma_config = None
        self._collections = {}
        self._initialized = True
    
    def _ensure_initialized(self):
        """Ensure the store is initialized with embeddings and config."""
        if self._embeddings is None:
            self._embeddings = get_embeddings()
            self._chroma_config = config_manager.get("general.memory_store.chroma", {
                "type": "local",
                "local": {"persist_directory": "./data/chroma"},
                "server": {"host": "localhost", "port": 8000}
            })
            log_info("ChromaVectorStore initialized")
    
    def get_collection(self, collection_name: str) -> Chroma:
        """Get or create a Chroma collection."""
        self._ensure_initialized()
        
        if collection_name not in self._collections:
            with self._lock:
                if collection_name not in self._collections:
                    self._collections[collection_name] = self._create_chroma_collection(collection_name)
        
        return self._collections[collection_name]
    
    def _create_chroma_collection(self, collection_name: str) -> Chroma:
        """Create a new Chroma collection."""
        if self._chroma_config.get("type") == "server":
            # Server-based Chroma
            host = self._chroma_config.get("server", {}).get("host", "localhost")
            port = self._chroma_config.get("server", {}).get("port", 8000)
            
            import chromadb
            from chromadb.config import Settings
            
            chroma_client = chromadb.HttpClient(
                host=host,
                port=port,
                settings=Settings(allow_reset=True)
            )
            
            collection = Chroma(
                client=chroma_client,
                collection_name=collection_name,
                embedding_function=self._embeddings
            )
            log_info(f"Created Chroma collection '{collection_name}' on server {host}:{port}")
        else:
            # Local file-based Chroma (default)
            persist_dir = self._chroma_config.get("local", {}).get("persist_directory", "./data/chroma")
            
            # Ensure the data directory exists
            Path(persist_dir).mkdir(parents=True, exist_ok=True)
            
            collection = Chroma(
                collection_name=collection_name,
                embedding_function=self._embeddings,
                persist_directory=persist_dir
            )
            log_info(f"Created Chroma collection '{collection_name}' at {persist_dir}")
        
        return collection
    
    def reset(self):
        """Reset the store (useful for testing)."""
        with self._lock:
            self._collections.clear()
            self._embeddings = None
            self._chroma_config = None


class ChromaMemoryStoreAdapter(BaseStore):
    """
    A BaseStore adapter that uses Chroma collections based directly on workspace names.
    Each workspace string is used directly as the collection name.
    """

    def __init__(self):
        self.chroma_store = ChromaVectorStore()

    def _format_text_content(self, value: dict[str, Any]) -> str:
        """Create a text representation for vector search."""
        if "text" in value:
            return value["text"]
        elif "name" in value and "description" in value:
            return f"{value['name']}: {value['description']}"
        else:
            # Fallback: use JSON representation
            return json.dumps(value, ensure_ascii=False)

    def _create_metadata(self, workspace: str, key: str, value: dict[str, Any]) -> dict:
        """Create metadata that includes the workspace, key, and original value."""
        return {
            "workspace": workspace,
            "key": key,
            "value": json.dumps(value, ensure_ascii=False),
        }

    # Implement the missing abstract methods
    async def aput(
        self,
        namespace: tuple[str, ...],
        key: str,
        value: dict[str, Any],
        index: Optional[list[str]] = None,
    ) -> None:
        """Async version of put - just calls the sync version."""
        # Convert namespace tuple to workspace string for backward compatibility
        workspace = "_".join(namespace) if len(namespace) > 1 else namespace[0]
        return self.put_workspace(workspace, key, value, index)

    async def aget(
        self,
        namespace: tuple[str, ...],
        key: str,
    ) -> Optional[Item]:
        """Async version of get - just calls the sync version."""
        # Convert namespace tuple to workspace string for backward compatibility
        workspace = "_".join(namespace) if len(namespace) > 1 else namespace[0]
        return self.get_workspace(workspace, key)

    async def adelete(
        self,
        namespace: tuple[str, ...],
        key: str,
    ) -> None:
        """Async version of delete - just calls the sync version."""
        # Convert namespace tuple to workspace string for backward compatibility
        workspace = "_".join(namespace) if len(namespace) > 1 else namespace[0]
        return self.delete_workspace(workspace, key)

    async def alist(
        self,
        namespace: tuple[str, ...],
        *,
        limit: int = 10,
        offset: int = 0,
    ) -> list[Item]:
        """Async version of list - just calls the sync version."""
        # Convert namespace tuple to workspace string for backward compatibility
        workspace = "_".join(namespace) if len(namespace) > 1 else namespace[0]
        return self.retrieve_items_workspace(workspace, limit=limit, offset=offset)

    async def asearch(
        self,
        namespace: tuple[str, ...],
        *,
        query: str,
        limit: int = 10,
        offset: int = 0,
    ) -> list[Item]:
        """Async version of search - just calls the sync version."""
        # Convert namespace tuple to workspace string for backward compatibility
        workspace = "_".join(namespace) if len(namespace) > 1 else namespace[0]
        return self.search_workspace(workspace, query=query, limit=limit, offset=offset)

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
        Store a key-value pair in the appropriate Chroma collection.
        Backward compatibility method that converts namespace to workspace.

        Args:
            namespace: Namespace tuple - converted to workspace string
            key: Unique key for the item
            value: Dictionary value to store
            index: Optional list of fields to index (not used in vector store)
        """
        # Convert namespace tuple to workspace string for backward compatibility
        workspace = "_".join(namespace) if len(namespace) > 1 else namespace[0]
        return self.put_workspace(workspace, key, value, index)

    def put_workspace(
        self,
        workspace: str,
        key: str,
        value: dict[str, Any],
        index: Optional[list[str]] = None,
    ) -> None:
        """
        Store a key-value pair in the appropriate Chroma collection.

        Args:
            workspace: Workspace name - used directly as collection name
            key: Unique key for the item
            value: Dictionary value to store
            index: Optional list of fields to index (not used in vector store)
        """
        try:
            collection = self.chroma_store.get_collection(workspace)

            # First, check if item already exists and delete it to update
            existing = self.get_workspace(workspace, key)
            if existing:
                self.delete_workspace(workspace, key)

            # Create text content and metadata
            text_content = self._format_text_content(value)
            metadata = self._create_metadata(workspace, key, value)
            
            # Create unique ID for the document
            doc_id = f"{workspace}_{key}"
            
            # Store in vector database
            collection.add_texts(
                texts=[text_content], 
                metadatas=[metadata], 
                ids=[doc_id]
            )
            
        except Exception as e:
            log_error(f"Error storing item {workspace}/{key}: {e}")
            raise

    def get(
        self,
        namespace: tuple[str, ...],
        key: str,
    ) -> Optional[Item]:
        """
        Get an item by namespace and key.
        Backward compatibility method that converts namespace to workspace.

        Args:
            namespace: Namespace tuple
            key: Key to retrieve

        Returns:
            Item if found, None otherwise
        """
        # Convert namespace tuple to workspace string for backward compatibility
        workspace = "_".join(namespace) if len(namespace) > 1 else namespace[0]
        return self.get_workspace(workspace, key)

    def get_workspace(
        self,
        workspace: str,
        key: str,
    ) -> Optional[Item]:
        """
        Get an item by workspace and key.

        Args:
            workspace: Workspace name
            key: Key to retrieve

        Returns:
            Item if found, None otherwise
        """
        try:
            collection = self.chroma_store.get_collection(workspace)
            
            doc_id = f"{workspace}_{key}"
            
            # Try to get by ID first (most efficient)
            try:
                docs = collection.get(ids=[doc_id])
                if docs and docs.get('documents') and len(docs['documents']) > 0:
                    metadata = docs['metadatas'][0]
                    if metadata.get("workspace") == workspace and metadata.get("key") == key:
                        value = json.loads(metadata["value"])
                        return Item(
                            value=value,
                            key=key,
                            namespace=(workspace,),  # Convert back to tuple for compatibility
                            created_at=datetime.now(),
                            updated_at=datetime.now(),
                        )
            except Exception:
                # Fallback to similarity search if direct get fails
                pass
            
            # Fallback: search with metadata filter
            results = collection.similarity_search(
                query=key, 
                k=50,
                filter={"$and": [{"workspace": {"$eq": workspace}}, {"key": {"$eq": key}}]}
            )
            
            for doc in results:
                if (hasattr(doc, 'metadata') and 
                    doc.metadata.get("workspace") == workspace and 
                    doc.metadata.get("key") == key):
                    value = json.loads(doc.metadata["value"])
                    return Item(
                        value=value,
                        key=key,
                        namespace=(workspace,),  # Convert back to tuple for compatibility
                        created_at=datetime.now(),
                        updated_at=datetime.now(),
                    )

            return None

        except Exception as e:
            log_error(f"Error getting item {workspace}/{key}: {e}")
            return None

    def delete(
        self,
        namespace: tuple[str, ...],
        key: str,
    ) -> None:
        """
        Delete an item by namespace and key.
        Backward compatibility method that converts namespace to workspace.

        Args:
            namespace: Namespace tuple
            key: Key to delete
        """
        # Convert namespace tuple to workspace string for backward compatibility
        workspace = "_".join(namespace) if len(namespace) > 1 else namespace[0]
        return self.delete_workspace(workspace, key)

    def delete_workspace(
        self,
        workspace: str,
        key: str,
    ) -> None:
        """
        Delete an item by workspace and key.

        Args:
            workspace: Workspace name
            key: Key to delete
        """
        try:
            collection = self.chroma_store.get_collection(workspace)
            
            doc_id = f"{workspace}_{key}"
            
            # Delete by ID
            collection.delete(ids=[doc_id])
            log_debug(f"Deleted item {workspace}/{key} from Chroma collection {workspace}")
            
        except Exception as e:
            log_error(f"Error deleting item {workspace}/{key}: {e}")

    def retrieve_items(
        self,
        namespace: tuple[str, ...],
        *,
        limit: int = 10,
        offset: int = 0,
    ) -> list[Item]:
        """
        List items in a namespace.
        Backward compatibility method that converts namespace to workspace.

        Args:
            namespace: Namespace tuple
            limit: Maximum number of items to return
            offset: Number of items to skip

        Returns:
            List of items
        """
        # Convert namespace tuple to workspace string for backward compatibility
        workspace = "_".join(namespace) if len(namespace) > 1 else namespace[0]
        return self.retrieve_items_workspace(workspace, limit=limit, offset=offset)

    def retrieve_items_workspace(
        self,
        workspace: str,
        *,
        limit: int = 10,
        offset: int = 0,
    ) -> list[Item]:
        """
        List items in a workspace.

        Args:
            workspace: Workspace name
            limit: Maximum number of items to return
            offset: Number of items to skip

        Returns:
            List of items
        """
        try:
            collection = self.chroma_store.get_collection(workspace)
            
            # Use similarity search with metadata filter to get items in workspace
            # We search with empty query to get all items, filtered by workspace
            results = collection.similarity_search(
                query="",  # Empty query to get all
                k=limit + offset + 50,  # Get extra to handle filtering
                filter={"workspace": {"$eq": workspace}}
            )
            
            # Extract items and apply offset/limit
            items = []
            count = 0
            for doc in results:
                if (hasattr(doc, 'metadata') and 
                    doc.metadata.get("workspace") == workspace):
                    if count >= offset and len(items) < limit:
                        try:
                            value = json.loads(doc.metadata["value"])
                            items.append(
                                Item(
                                    value=value,
                                    key=doc.metadata["key"],
                                    namespace=(workspace,),  # Convert back to tuple for compatibility
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
            log_error(f"Error listing items in {workspace}: {e}")
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
        Backward compatibility method that converts namespace to workspace.

        Args:
            namespace: Namespace tuple
            query: Search query
            limit: Maximum number of items to return
            offset: Number of items to skip

        Returns:
            List of items with similarity scores
        """
        # Convert namespace tuple to workspace string for backward compatibility
        workspace = "_".join(namespace) if len(namespace) > 1 else namespace[0]
        return self.search_workspace(workspace, query=query, limit=limit, offset=offset)

    def search_workspace(
        self,
        workspace: str,
        *,
        query: str,
        limit: int = 10,
        offset: int = 0,
    ) -> list[Item]:
        """
        Search for items in a workspace using vector similarity.

        Args:
            workspace: Workspace name
            query: Search query
            limit: Maximum number of items to return
            offset: Number of items to skip

        Returns:
            List of items with similarity scores
        """
        try:
            collection = self.chroma_store.get_collection(workspace)
            
            # Perform vector similarity search with workspace filter
            results = collection.similarity_search_with_score(
                query=query, 
                k=limit + offset + 20,  # Get extra to handle filtering
                filter={"workspace": {"$eq": workspace}}
            )
            
            # Filter by workspace and apply offset/limit
            items = []
            count = 0
            for doc, score in results:
                if (hasattr(doc, 'metadata') and 
                    doc.metadata.get("workspace") == workspace):
                    if count >= offset and len(items) < limit:
                        try:
                            value = json.loads(doc.metadata["value"])
                            item = Item(
                                value=value,
                                key=doc.metadata["key"],
                                namespace=(workspace,),  # Convert back to tuple for compatibility
                                created_at=datetime.now(),
                                updated_at=datetime.now(),
                            )
                            # Store score in the value if needed
                            if isinstance(item.value, dict):
                                item.value["_search_score"] = float(score)
                            items.append(item)
                        except (json.JSONDecodeError, KeyError) as e:
                            log_debug(f"Skipping malformed item: {e}")
                            continue
                    count += 1

            return items

        except Exception as e:
            log_error(f"Error searching in {workspace} with query '{query}': {e}")
            return []


# Singleton instance for the adapter
_memory_store_adapter = None
_adapter_lock = threading.Lock()


def get_combined_store() -> ChromaMemoryStoreAdapter:
    """Get the singleton memory store adapter."""
    global _memory_store_adapter
    if _memory_store_adapter is None:
        with _adapter_lock:
            if _memory_store_adapter is None:
                _memory_store_adapter = ChromaMemoryStoreAdapter()
    return _memory_store_adapter


def get_memory_store():
    """Get the memories store instance (returns the combined store for backward compatibility)."""
    return get_combined_store()


def get_tools_store():
    """Get the tools store instance (returns the combined store for backward compatibility).""" 
    return get_combined_store()


# New workspace-based convenience functions
def put_memory(key: str, value: dict[str, Any]) -> None:
    """Store a memory in the 'memories' workspace."""
    store = get_combined_store()
    store.put_workspace("memories", key, value)


def get_memory(key: str) -> Optional[Item]:
    """Get a memory from the 'memories' workspace."""
    store = get_combined_store()
    return store.get_workspace("memories", key)


def search_memories(query: str, limit: int = 10) -> list[Item]:
    """Search memories in the 'memories' workspace."""
    store = get_combined_store()
    return store.search_workspace("memories", query=query, limit=limit)


def put_tool(key: str, value: dict[str, Any]) -> None:
    """Store a tool in the 'tools' workspace."""
    store = get_combined_store()
    store.put_workspace("tools", key, value)


def search_tools(query: str, limit: int = 10) -> list[Item]:
    """Search tools in the 'tools' workspace."""
    store = get_combined_store()
    return store.search_workspace("tools", query=query, limit=limit)


# Backward compatibility - expose the store as module-level variable
# This will be lazily initialized when first accessed
class _LazyStore:
    """Lazy proxy for the store to maintain backward compatibility."""

    def __getattr__(self, name):
        return getattr(get_combined_store(), name)

    def __call__(self, *args, **kwargs):
        return get_combined_store()(*args, **kwargs)


store = _LazyStore()
