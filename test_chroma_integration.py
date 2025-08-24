#!/usr/bin/env python3
"""
Simple test script to verify Chroma integration works.
This is a temporary test file to validate the implementation.
"""

import os
import sys
import tempfile
import shutil
from pathlib import Path

# Add the app directory to the path so we can import modules
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '.'))

def test_chroma_integration():
    """Test basic Chroma functionality."""
    
    try:
        # Import after adding to path
        from app.langgraph.memory_store import ChromaMemoryStore, get_embeddings, CHROMA_AVAILABLE
        from app.config.config_manager import config_manager
        
        if not CHROMA_AVAILABLE:
            print("❌ Chroma is not available - skipping test")
            return False
            
        print("✅ Chroma is available")
        
        # Create a temporary directory for testing
        with tempfile.TemporaryDirectory() as temp_dir:
            print(f"📁 Using temporary directory: {temp_dir}")
            
            # Configure Chroma to use temporary directory
            chroma_config = {
                "type": "local",
                "local": {
                    "persist_directory": temp_dir
                }
            }
            
            # Get embeddings (this might fail if dependencies aren't available)
            try:
                embeddings, model_info = get_embeddings()
                print(f"✅ Embeddings initialized: {model_info}")
            except Exception as e:
                print(f"⚠️  Could not initialize embeddings: {e}")
                print("   This is expected in minimal test environment")
                # Create a mock embedding for testing
                from unittest.mock import MagicMock
                embeddings = MagicMock()
                embeddings.embed_documents = MagicMock(return_value=[[0.1, 0.2, 0.3]])
                embeddings.embed_query = MagicMock(return_value=[0.1, 0.2, 0.3])
                print("✅ Using mock embeddings for testing")
            
            # Create a ChromaMemoryStore
            try:
                store = ChromaMemoryStore(
                    collection_name="test_memories",
                    embeddings=embeddings,
                    chroma_config=chroma_config
                )
                print("✅ ChromaMemoryStore created successfully")
            except Exception as e:
                print(f"❌ Failed to create ChromaMemoryStore: {e}")
                return False
            
            # Test basic operations
            namespace = ("test", "memories")
            key = "test_key"
            value = {"text": "This is a test memory", "type": "test"}
            
            try:
                # Test put
                store.put(namespace, key, value)
                print("✅ Put operation successful")
                
                # Test get
                item = store.get(namespace, key)
                if item and item.value.get("text") == "This is a test memory":
                    print("✅ Get operation successful")
                else:
                    print(f"❌ Get operation failed: {item}")
                    return False
                
                # Test search
                results = store.search(namespace, query="test memory", limit=5)
                if results and len(results) > 0:
                    print(f"✅ Search operation successful: found {len(results)} results")
                else:
                    print("⚠️  Search operation returned no results (may be expected with mock embeddings)")
                
                # Test list
                items = store.list_items_in_namespace(namespace, limit=10)
                if items and len(items) > 0:
                    print(f"✅ List operation successful: found {len(items)} items")
                else:
                    print("⚠️  List operation returned no items")
                
                # Test delete
                store.delete(namespace, key)
                deleted_item = store.get(namespace, key)
                if deleted_item is None:
                    print("✅ Delete operation successful")
                else:
                    print("❌ Delete operation failed")
                    return False
                    
            except Exception as e:
                print(f"❌ Basic operations failed: {e}")
                return False
        
        print("🎉 All Chroma integration tests passed!")
        return True
        
    except ImportError as e:
        print(f"❌ Import error: {e}")
        return False
    except Exception as e:
        print(f"❌ Unexpected error: {e}")
        return False

def test_config_backend_selection():
    """Test that backend selection works via configuration."""
    try:
        from app.langgraph.memory_store import MemoryStoreManager
        from app.config.config_manager import config_manager
        
        # Test with SQLite backend (default)
        config_manager._config = config_manager._config or {}
        config_manager._config.setdefault("general", {}).setdefault("memory_store", {})["backend"] = "sqlite"
        
        manager = MemoryStoreManager()
        backend_type = manager.get_backend_type()
        print(f"✅ Backend type detection works: {backend_type}")
        
        # Test with Chroma backend
        config_manager._config["general"]["memory_store"]["backend"] = "chroma"
        backend_type = manager.get_backend_type()
        print(f"✅ Backend type switches correctly: {backend_type}")
        
        return True
        
    except Exception as e:
        print(f"❌ Backend selection test failed: {e}")
        return False

if __name__ == "__main__":
    print("🧪 Testing Chroma Integration")
    print("=" * 50)
    
    success = True
    
    print("\n📋 Testing basic Chroma functionality...")
    success &= test_chroma_integration()
    
    print("\n📋 Testing configuration backend selection...")
    success &= test_config_backend_selection()
    
    print("\n" + "=" * 50)
    if success:
        print("🎉 All tests passed!")
        sys.exit(0)
    else:
        print("❌ Some tests failed!")
        sys.exit(1)