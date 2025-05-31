"""
Aurora Logging Utility

A centralized logging system for Aurora that provides:
- Normalized logs with timestamps
- Debug logging controlled by AURORA_DEBUG_LOGS environment variable
- Clean and non-cluttered output
- Easy-to-use logging functions for different log levels
"""

import logging
import os
import inspect
from datetime import datetime
from typing import Any
from pathlib import Path


class AuroraLogger:
    """Centralized logging utility for Aurora with debug mode support"""
    
    def __init__(self):
        self.debug_enabled = os.getenv('AURORA_DEBUG_LOGS', 'false').lower() == 'true'
        self._setup_logger()
    
    def _setup_logger(self):
        """Setup the logger with appropriate formatting"""
        self.logger = logging.getLogger('Aurora')
        self.logger.setLevel(logging.DEBUG if self.debug_enabled else logging.INFO)
        
        # Remove existing handlers to avoid duplicates
        self.logger.handlers.clear()
        
        # Create console handler
        console_handler = logging.StreamHandler()
        console_handler.setLevel(logging.DEBUG if self.debug_enabled else logging.INFO)
        
        # Create formatter with clean timestamp format
        formatter = logging.Formatter(
            '%(asctime)s [%(levelname)s] %(message)s',
            datefmt='%H:%M:%S'
        )
        console_handler.setFormatter(formatter)
        
        # Add handler to logger
        self.logger.addHandler(console_handler)
        
        # Prevent propagation to root logger
        self.logger.propagate = False
    
    def _get_caller_module(self):
        """Get the module name of the calling function"""
        # Get the calling frame (skip current frame and the logging method)
        frame = inspect.currentframe()
        try:
            # Skip current frame and the logging method (debug in this case)
            # Then skip the convenience function (log_debug)
            caller_frame = frame.f_back.f_back.f_back
            if caller_frame is None:
                return "unknown"
            
            # Get the filename and convert to module name
            filename = caller_frame.f_code.co_filename
            if filename:
                # Convert absolute path to relative module name
                path = Path(filename)
                if 'aurora' in path.parts:
                    # Find aurora in the path and build module name from there
                    aurora_index = path.parts.index('aurora')
                    module_parts = path.parts[aurora_index + 1:]
                    if module_parts:
                        # Remove .py extension and join with dots
                        module_name = '.'.join(module_parts).replace('.py', '')
                        # Clean up the module name (remove __pycache__ references)
                        module_name = module_name.replace('.__pycache__', '')
                        return module_name
                
                # Fallback to just the filename without extension
                return path.stem
            return "unknown"
        except:
            return "unknown"
        finally:
            del frame

    def info(self, message: Any, *args):
        """Log info message"""
        self.logger.info(str(message), *args)

    def debug(self, message: Any, *args):
        """Log debug message (only if debug mode is enabled)"""
        if self.debug_enabled:
            # Include module info for debug logs
            module_name = self._get_caller_module()
            self.logger.debug(f"[{module_name}] {str(message)}", *args)

    def warning(self, message: Any, *args):
        """Log warning message"""
        self.logger.warning(str(message), *args)

    def error(self, message: Any, *args):
        """Log error message"""
        self.logger.error(str(message), *args)

    def success(self, message: Any, *args):
        """Log success message (using info level with ✓ prefix)"""
        self.logger.info(f"✓ {message}", *args)


# Global logger instance
logger = AuroraLogger()

# Convenience functions for easy import
def log_info(message: Any, *args):
    """Log info message"""
    logger.info(message, *args)

def log_debug(message: Any, *args):
    """Log debug message"""
    logger.debug(message, *args)

def log_warning(message: Any, *args):
    """Log warning message"""
    logger.warning(message, *args)

def log_error(message: Any, *args):
    """Log error message"""
    logger.error(message, *args)

def log_success(message: Any, *args):
    """Log success message"""
    logger.success(message, *args)
