"""
Aurora Voice Assistant - Main Entry Point

This is the new main.py that uses the message bus architecture.
All services communicate via the message bus for full decoupling.
"""

import asyncio
import logging
import sys
from threading import Thread

from dotenv import load_dotenv

# CRITICAL: Force unbuffered output FIRST before any logging
sys.stdout.reconfigure(line_buffering=True) if hasattr(sys.stdout, 'reconfigure') else None
sys.stderr.reconfigure(line_buffering=True) if hasattr(sys.stderr, 'reconfigure') else None

from app.config.config_manager import config_manager
from app.helpers.aurora_logger import log_error, log_info
from app.services.supervisor import Supervisor

# Reduce ALSA noise
logging.getLogger('alsa').setLevel(logging.ERROR)

# Load environment variables
load_dotenv()
config_manager.migrate_from_env()


async def main_async():
    """Main async entry point for CLI mode (no UI)."""
    log_info("Starting Aurora with Message Bus Architecture (CLI mode)...")
    
    # Create and start supervisor
    supervisor = Supervisor()
    
    try:
        # Initialize supervisor (sets up bus and services)
        log_info(">>> Initializing supervisor...")
        await supervisor.initialize()
        log_info("✓ Supervisor initialized")
        
        # Start all services
        log_info(">>> Calling supervisor.start_services()...")
        await supervisor.start_services()
        log_info("✓ All services started!")
        
        # Start OpenRecall if enabled
        if config_manager.get("plugins.openrecall.activate"):
            log_info("Starting OpenRecall integration...")
            from threading import Thread
            from modules.openrecall.openrecall.app import init_main as openrecall_app
            
            open_recall_thread = Thread(target=openrecall_app, daemon=True)
            open_recall_thread.start()
            log_info("OpenRecall started in background thread")
        
        # Initial greeting via bus
        from app.tts import TTSRequest
        await supervisor.bus.publish(
            "TTS.Request",
            TTSRequest(text="Olá, meu nome é Jarvis", interrupt=False),
            event=False,
            priority=10,
            origin="internal"
        )
        
        # Run supervisor (blocks until shutdown signal)
        await supervisor.run()
        
    except KeyboardInterrupt:
        log_info("Interrupted by user")
    except Exception as e:
        import traceback
        log_error(f"Error in main: {e}")
        log_error(f"Traceback: {traceback.format_exc()}")
    finally:
        # Graceful shutdown
        await supervisor.shutdown()


def main_with_ui():
    """Main entry point for UI mode - runs supervisor in background thread."""
    import threading
    from PyQt6.QtWidgets import QApplication
    from modules.ui.aurora_ui import AuroraUI
    from app.ui.bridge_service import UIBridge
    
    log_info("Starting Aurora with UI...")
    
    # Shared state
    supervisor = None
    supervisor_loop = None
    supervisor_ready = threading.Event()
    supervisor_error = [None]  # Use list to allow modification in nested function
    
    def run_supervisor_thread():
        """Run supervisor in background thread with dedicated event loop."""
        nonlocal supervisor, supervisor_loop
        
        try:
            # Create new event loop for this thread
            supervisor_loop = asyncio.new_event_loop()
            asyncio.set_event_loop(supervisor_loop)
            
            log_info("Supervisor thread: Creating and initializing supervisor...")
            
            # Create and initialize supervisor in THIS event loop
            supervisor = Supervisor()
            supervisor_loop.run_until_complete(supervisor.initialize())
            
            log_info("✓ Supervisor initialized")
            
            # Start all services in THIS event loop
            supervisor_loop.run_until_complete(supervisor.start_services())
            
            log_info("✓ All services started in supervisor thread")
            
            # Signal that we're ready
            supervisor_ready.set()
            
            # Run supervisor's main loop (blocks until shutdown)
            log_info("Supervisor thread: Running supervisor.run()...")
            supervisor_loop.run_until_complete(supervisor.run())
            
        except Exception as e:
            supervisor_error[0] = e
            log_error(f"Supervisor thread error: {e}", exc_info=True)
            supervisor_ready.set()
        finally:
            # Cleanup
            if supervisor_loop:
                try:
                    supervisor_loop.run_until_complete(supervisor.shutdown())
                except:
                    pass
                supervisor_loop.close()
            log_info("Supervisor thread finished")
    
    # Start supervisor in background thread
    supervisor_thread = threading.Thread(
        target=run_supervisor_thread,
        daemon=False,
        name="SupervisorLoop"
    )
    supervisor_thread.start()
    
    # Wait for supervisor to be ready
    log_info("Waiting for supervisor to initialize...")
    supervisor_ready.wait(timeout=30.0)
    
    if supervisor_error[0]:
        log_error("Supervisor failed to initialize!")
        raise supervisor_error[0]
    
    if not supervisor or not supervisor_loop:
        raise RuntimeError("Supervisor thread failed to initialize")
    
    log_info("✓ Supervisor running in background thread")
    
    # Initialize Qt in main thread
    log_info("Initializing Qt application...")
    app = QApplication(sys.argv)
    window = AuroraUI()
    
    # Start UI bridge in supervisor's event loop
    log_info("Starting UI bridge...")
    ui_bridge = UIBridge(supervisor.bus, window)
    
    bridge_future = asyncio.run_coroutine_threadsafe(
        ui_bridge.start(),
        supervisor_loop
    )
    bridge_future.result(timeout=10.0)
    
    log_info("✓ UI bridge started")
    
    # Send initial greeting
    from app.tts import TTSRequest
    greeting_future = asyncio.run_coroutine_threadsafe(
        supervisor.bus.publish(
            "TTS.Request",
            TTSRequest(text="Olá, meu nome é Jarvis", interrupt=False),
            event=False,
            priority=10,
            origin="internal"
        ),
        supervisor_loop
    )
    greeting_future.result(timeout=5.0)
    
    log_info("✓ Initial greeting sent")
    
    # Show window
    window.show()
    log_info("✓ UI window shown")
    
    log_info("="*70)
    log_info("Aurora is ready! All services running in background thread.")
    log_info("="*70)
    
    # Run Qt event loop in main thread (BLOCKS)
    exit_code = app.exec()
    
    # Qt closed - signal supervisor shutdown
    log_info("Qt closed, shutting down supervisor...")
    
    if supervisor_loop and not supervisor_loop.is_closed():
        # Create a simple coroutine to set the shutdown event
        async def signal_shutdown():
            supervisor.shutdown_event.set()
        
        try:
            asyncio.run_coroutine_threadsafe(
                signal_shutdown(),
                supervisor_loop
            ).result(timeout=2.0)
        except Exception as e:
            log_error(f"Error signaling shutdown: {e}")
    
    # Wait for supervisor thread
    supervisor_thread.join(timeout=5.0)
    
    log_info("Shutdown complete")
    sys.exit(exit_code)


def main():
    """Main entry point - routes to UI or CLI mode."""
    try:
        if config_manager.get("ui.activate"):
            # UI mode - run supervisor in background thread
            main_with_ui()
        else:
            # CLI mode - run supervisor in main thread
            asyncio.run(main_async())
    except KeyboardInterrupt:
        log_info("Shutdown complete")


if __name__ == "__main__":
    main()
