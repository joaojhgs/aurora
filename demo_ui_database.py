#!/usr/bin/env python3
"""
Aurora UI Database Integration Demo
Demonstrates message persistence across app sessions.
"""

import sys
import os
from datetime import datetime
from PyQt6.QtWidgets import QApplication

# Add the project root to Python path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from modules.ui.aurora_ui import AuroraUI


def demo_database_integration():
    """Demo the database integration features"""
    print("🤖 Aurora UI Database Integration Demo")
    print("=" * 50)
    
    app = QApplication([])
    
    try:
        # Create UI instance
        print("\n1. Creating Aurora UI with database integration...")
        ui = AuroraUI()
        
        # Show current message count
        messages = ui.message_history.get_today_messages()
        print(f"   Current messages for today: {len(messages)}")
        
        # Add a demo message
        demo_time = datetime.now().strftime("%H:%M:%S")
        print(f"\n2. Adding demo message at {demo_time}...")
        ui.add_message(f"Demo message sent at {demo_time}", is_user=True, source_type="Text")
        ui.add_message(f"Demo response at {demo_time}", is_user=False, source_type=None)
        
        # Show updated count
        updated_messages = ui.message_history.get_today_messages()
        print(f"   Updated message count: {len(updated_messages)}")
        
        print(f"\n3. Recent messages:")
        for i, msg in enumerate(updated_messages[-5:], 1):  # Show last 5 messages
            user_type = "👤 User" if msg.is_user_message() else "🤖 Assistant"
            source = f" ({msg.get_ui_source_type()})" if msg.get_ui_source_type() else ""
            timestamp = msg.timestamp.strftime("%H:%M:%S")
            print(f"   {i}. [{timestamp}] {user_type}{source}: {msg.content[:50]}...")
        
        print(f"\n✅ Demo completed successfully!")
        print(f"💾 All messages are persisted in: /home/skyron/Documentos/aurora/data/aurora.db")
        print(f"🔄 Messages will be restored when you restart the application")
        
    except Exception as e:
        print(f"❌ Demo failed: {e}")
        import traceback
        traceback.print_exc()
    
    finally:
        app.quit()


if __name__ == "__main__":
    demo_database_integration()
