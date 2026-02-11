"""CLI for running services in process mode."""

import argparse
import signal
import sys
import time

from app.helpers.aurora_logger import log_info
from app.shared.services.process_launcher import ProcessLauncher

SERVICES = {
    "config": "app.services.config",
    "db": "app.services.db",
    "orchestrator": "app.services.orchestrator",
    "scheduler": "app.services.scheduler",
    "tts": "app.services.tts",
    "tooling": "app.services.tooling",
    "stt-coordinator": "app.services.stt_coordinator",
    "stt-transcription": "app.services.stt_transcription",
    "stt-wakeword": "app.services.stt_wakeword",
}


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(description="Run Aurora services in process mode")
    parser.add_argument(
        "services",
        nargs="*",
        choices=list(SERVICES.keys()) + ["all"],
        default=["all"],
        help="Services to run (default: all)",
    )
    parser.add_argument(
        "--monitor",
        action="store_true",
        help="Enable process monitoring",
    )
    parser.add_argument(
        "--logs",
        action="store_true",
        help="Show logs from services",
    )

    args = parser.parse_args()

    launcher = ProcessLauncher()

    # Determine which services to start
    services_to_start = list(SERVICES.keys()) if "all" in args.services else args.services

    # Start services
    for service_name in services_to_start:
        if service_name in SERVICES:
            launcher.start_service(service_name, SERVICES[service_name])

    # Set up signal handlers
    def signal_handler(sig, frame):
        log_info("Received shutdown signal, stopping all services...")
        launcher.stop_all()
        sys.exit(0)

    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    # Start monitoring if requested
    if args.monitor:
        launcher.start_monitoring()

    # Keep running
    try:
        if args.logs:
            # Show logs
            while True:
                for service_name in services_to_start:
                    logs = launcher.get_logs(service_name, lines=10)
                    if logs:
                        print(f"\n[{service_name}]")
                        for log in logs:
                            print(f"  {log}")
                time.sleep(5)
        else:
            # Just wait
            while True:
                time.sleep(1)
    except KeyboardInterrupt:
        signal_handler(None, None)


if __name__ == "__main__":
    main()
