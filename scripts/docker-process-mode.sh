#!/bin/bash
# Helper script for running Aurora in process mode with Docker Compose

set -e

COMPOSE_FILE="docker-compose.process.yml"
CONFIG_FILE="config.json"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

print_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if Docker is installed
check_docker() {
    if ! command -v docker &> /dev/null; then
        print_error "Docker is not installed. Please install Docker first."
        exit 1
    fi

    if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
        print_error "Docker Compose is not installed. Please install Docker Compose first."
        exit 1
    fi
}

# Check if config.json exists and has process mode configured
check_config() {
    if [ ! -f "$CONFIG_FILE" ]; then
        print_warning "config.json not found. Creating from defaults..."
        cp app/services/config/config_defaults.json "$CONFIG_FILE" 2>/dev/null || {
            print_error "Could not create config.json. Please create it manually."
            exit 1
        }
    fi

    # Check if process mode is configured
    if ! grep -q '"mode": "processes"' "$CONFIG_FILE" 2>/dev/null; then
        print_warning "config.json does not have process mode enabled."
        print_info "Updating config.json to enable process mode..."
        
        # Use Python to update config safely
        python3 << EOF
import json
import sys

try:
    with open('$CONFIG_FILE', 'r') as f:
        config = json.load(f)
    
    # Set architecture mode to processes
    if 'general' not in config:
        config['general'] = {}
    if 'architecture' not in config['general']:
        config['general']['architecture'] = {}
    config['general']['architecture']['mode'] = 'processes'
    
    # Set Redis URL for Docker
    if 'messaging' not in config:
        config['messaging'] = {}
    if 'redis' not in config['messaging']:
        config['messaging']['redis'] = {}
    config['messaging']['redis']['url'] = 'redis://redis:6379'
    
    with open('$CONFIG_FILE', 'w') as f:
        json.dump(config, f, indent=4)
    
    print("✓ Config updated successfully")
except Exception as e:
    print(f"✗ Error updating config: {e}")
    sys.exit(1)
EOF
        if [ $? -ne 0 ]; then
            print_error "Failed to update config.json"
            exit 1
        fi
    fi
}

# Create necessary directories
create_directories() {
    print_info "Creating necessary directories..."
    mkdir -p data logs config voice_models chat_models
    print_info "✓ Directories created"
}

# Main function
main() {
    print_info "Aurora Process Mode Docker Setup"
    print_info "================================="
    
    check_docker
    check_config
    create_directories
    
    print_info ""
    print_info "Starting Aurora services in process mode..."
    print_info "Use 'docker-compose -f $COMPOSE_FILE logs -f' to view logs"
    print_info "Use 'docker-compose -f $COMPOSE_FILE down' to stop services"
    print_info ""
    
    # Use docker compose (v2) or docker-compose (v1)
    if docker compose version &> /dev/null; then
        docker compose -f "$COMPOSE_FILE" up -d
    else
        docker-compose -f "$COMPOSE_FILE" up -d
    fi
    
    if [ $? -eq 0 ]; then
        print_info ""
        print_info "✓ All services started successfully!"
        print_info ""
        print_info "Services are running. Check status with:"
        print_info "  docker-compose -f $COMPOSE_FILE ps"
        print_info ""
        print_info "View logs with:"
        print_info "  docker-compose -f $COMPOSE_FILE logs -f"
    else
        print_error "Failed to start services"
        exit 1
    fi
}

# Run main function
main
