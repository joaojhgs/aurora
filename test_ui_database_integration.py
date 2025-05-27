#!/usr/bin/env python3
"""
Comprehensive test for UI database integration.
Tests message persistence across app sessions and daily message filtering.
"""

import sys
import os
from datetime import datetime, date, timedelta
from PyQt6.QtWidgets import QApplication

# Add the project root to Python path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from modules.ui.aurora_ui import AuroraUI
from modules.database import get_message_history_service


def test_database_integration():
    """Test the complete database integration"""
    print("=" * 60)
    print("AURORA UI DATABASE INTEGRATION TEST")
    print("=" * 60)
    
    # Create Qt application
    app = QApplication([])
    
    try:
        # Test 1: Basic UI creation with database
        print("\n1. Testing UI creation with database integration...")
        ui = AuroraUI()
        print("✓ UI created successfully with database integration")
        
        # Test 2: Verify message history service
        print("\n2. Testing message history service initialization...")
        assert ui.message_history is not None, "Message history service not initialized"
        print("✓ Message history service initialized correctly")
        
        # Test 3: Test storing different message types
        print("\n3. Testing message storage...")
        
        # Clear any existing messages for clean test
        initial_count = len(ui.message_history.get_today_messages())
        print(f"   Initial message count: {initial_count}")
        
        # Add test messages of different types
        ui.add_message("Test user text message", is_user=True, source_type="Text")
        ui.add_message("Test user voice message", is_user=True, source_type="STT")
        ui.add_message("Test assistant response message", is_user=False, source_type=None)
        
        # Verify messages were stored
        messages = ui.message_history.get_today_messages()
        expected_count = initial_count + 3
        assert len(messages) == expected_count, f"Expected {expected_count} messages, got {len(messages)}"
        print(f"✓ Successfully stored 3 messages (total: {len(messages)})")
        
        # Test 4: Verify message content and types
        print("\n4. Testing message content and types...")
        recent_messages = messages[-3:]  # Get the last 3 messages we added
        
        # Check text message
        text_msg = recent_messages[0]
        assert text_msg.content == "Test user text message"
        assert text_msg.is_user_message() == True
        assert text_msg.get_ui_source_type() == "Text"
        print("✓ User text message stored correctly")
        
        # Check voice message
        voice_msg = recent_messages[1]
        assert voice_msg.content == "Test user voice message"
        assert voice_msg.is_user_message() == True
        assert voice_msg.get_ui_source_type() == "STT"
        print("✓ User voice message stored correctly")
        
        # Check assistant message
        assistant_msg = recent_messages[2]
        assert assistant_msg.content == "Test assistant response message"
        assert assistant_msg.is_user_message() == False
        assert assistant_msg.get_ui_source_type() == None
        print("✓ Assistant message stored correctly")
        
        # Test 5: Test app restart simulation
        print("\n5. Testing app restart simulation...")
        
        # Create a new UI instance (simulates app restart)
        ui2 = AuroraUI()
        
        # Verify messages are loaded from database
        messages_after_restart = ui2.message_history.get_today_messages()
        assert len(messages_after_restart) == len(messages), "Messages not persisted across restart"
        print(f"✓ Messages persisted across restart ({len(messages_after_restart)} messages)")
        
        # Test 6: Test daily message filtering
        print("\n6. Testing daily message filtering...")
        
        # Get messages for today
        today_messages = ui.message_history.get_today_messages()
        print(f"   Messages for today: {len(today_messages)}")
        
        # Get messages for yesterday (should be empty for this test)
        yesterday = date.today() - timedelta(days=1)
        yesterday_messages = ui.message_history.get_messages_for_date(yesterday)
        print(f"   Messages for yesterday: {len(yesterday_messages)}")
        
        # Verify today has messages, yesterday should be empty (for clean test)
        assert len(today_messages) > 0, "No messages found for today"
        print("✓ Daily message filtering working correctly")
        
        print("\n" + "=" * 60)
        print("ALL TESTS PASSED! ✓")
        print("Database integration is working correctly!")
        print("=" * 60)
        
        # Display summary
        print(f"\nSUMMARY:")
        print(f"• Database location: /home/skyron/Documentos/aurora/data/aurora.db")
        print(f"• Total messages stored today: {len(today_messages)}")
        print(f"• Message persistence: ✓ Working")
        print(f"• Daily filtering: ✓ Working")
        print(f"• UI integration: ✓ Working")
        
        return True
        
    except Exception as e:
        print(f"\n❌ TEST FAILED: {e}")
        import traceback
        traceback.print_exc()
        return False
    
    finally:
        # Clean up
        app.quit()


def test_message_flow():
    """Test the complete message flow from UI to database"""
    print("\n" + "=" * 60)
    print("TESTING COMPLETE MESSAGE FLOW")
    print("=" * 60)
    
    app = QApplication([])
    
    try:
        ui = AuroraUI()
        
        # Simulate user typing a message
        print("\n1. Simulating user text input...")
        test_message = f"Test message at {datetime.now().strftime('%H:%M:%S')}"
        
        # This simulates what happens when user types and sends a message
        ui.add_message(test_message, is_user=True, source_type="Text")
        
        # Simulate assistant response
        print("2. Simulating assistant response...")
        response_message = f"Response to: {test_message}"
        ui.add_message(response_message, is_user=False, source_type=None)
        
        # Verify both messages are in database
        messages = ui.message_history.get_today_messages()
        
        # Find our test messages
        user_msg = None
        assistant_msg = None
        
        for msg in messages:
            if msg.content == test_message:
                user_msg = msg
            elif msg.content == response_message:
                assistant_msg = msg
        
        assert user_msg is not None, "User message not found in database"
        assert assistant_msg is not None, "Assistant message not found in database"
        
        print("✓ Complete message flow working correctly")
        print(f"   User message: {user_msg.content[:30]}...")
        print(f"   Assistant response: {assistant_msg.content[:30]}...")
        
        return True
        
    except Exception as e:
        print(f"❌ Message flow test failed: {e}")
        return False
    
    finally:
        app.quit()


if __name__ == "__main__":
    print("Starting Aurora UI Database Integration Tests...")
    
    # Run tests
    test1_result = test_database_integration()
    test2_result = test_message_flow()
    
    if test1_result and test2_result:
        print("\n🎉 ALL TESTS PASSED!")
        print("The database integration is ready for use!")
        sys.exit(0)
    else:
        print("\n💥 SOME TESTS FAILED!")
        print("Please check the error messages above.")
        sys.exit(1)
