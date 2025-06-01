#!/bin/bash
# Aurora Run Script
source venv/bin/activate
cd "$(dirname "$0")"
python main.py "$@"
